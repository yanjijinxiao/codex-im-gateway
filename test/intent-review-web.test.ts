import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("first-screen bootstrap renders core views before optional Taskboard responds",async()=>{
  const gate=Promise.withResolvers<unknown>(),rendered:string[]=[];
  const context=vm.createContext({document:{addEventListener(){},querySelector(){return{hidden:true};}},
    window:{setInterval(){},setTimeout,requestAnimationFrame(){}},location:{hash:"#accounts"}});
  vm.runInContext(fs.readFileSync(new URL("../src/web/app.js",import.meta.url),"utf8"),context);
  context.api=async(url:string)=>url==="/api/taskboard"?gate.promise:{requestToken:"token",version:"0.4.0",accounts:[],projects:[],knowledgeBases:[],sessions:[],config:{},codex:{},codexRuntime:{},codexModels:[]};
  context.renderAll=()=>rendered.push("core");context.showView=()=>{};context.toast=()=>{};
  context.renderTaskboardStatus=()=>{};context.renderTaskboardWorkbench=()=>{};context.drawIcons=()=>{};
  const work=context.bootstrap();
  try{await new Promise(resolve=>setImmediate(resolve));assert.deepEqual([...rendered],["core"]);}
  finally{gate.resolve({enabled:false,available:false});await work;}
});

for(const result of ["success","failure"] as const)test(`a retired knowledge save cannot close or overwrite a newer dialog: ${result}`,async()=>{
  const gate=Promise.withResolvers<unknown>(),fields=new Map<string,any>();
  const field=(selector:string)=>{if(!fields.has(selector))fields.set(selector,{value:"",hidden:false,disabled:false,dataset:{},textContent:"",focus(){}});return fields.get(selector);};
  const label={textContent:"验证并保存"},button={disabled:false,querySelector(){return label;}};
  const dialog=field("#knowledgeBaseDialog");dialog.open=true;dialog.close=()=>{dialog.open=false;};
  fields.set("#saveKnowledgeBaseButton",button);
  const context=vm.createContext({window:{},document:{addEventListener(){},querySelector:field,querySelectorAll(){return[];}},
    api:()=>gate.promise,refreshData:async()=>{},toast(){},state:{}});
  vm.runInContext(fs.readFileSync(new URL("../src/web/knowledge-bases.js",import.meta.url),"utf8"),context);
  context.beginKnowledgeBaseDialogSession();field("#editingKnowledgeBaseId").value="old-kb";field("#editingKnowledgeBaseAccountId").value="account";
  const work=context.saveKnowledgeBase({preventDefault(){},submitter:button});
  context.beginKnowledgeBaseDialogSession();field("#editingKnowledgeBaseId").value="new-kb";field("#knowledgeBaseFormError").textContent="new dialog feedback";
  if(result==="success")gate.resolve({knowledgeBase:{accountId:"account",id:"old-kb"}});else gate.reject(Error("old save failed"));await work;
  assert.equal(dialog.open,true);assert.equal(field("#knowledgeBaseFormError").textContent,"new dialog feedback");assert.equal(button.disabled,false);
});

for(const operation of ["newer-read","save"] as const)test(`a late IDE settings read cannot overwrite a ${operation}`,async()=>{
  const gate=Promise.withResolvers<any>(),fields=new Map<string,any>(),ready:Array<()=>void>=[];
  const field=(id:string)=>{if(!fields.has(id))fields.set(id,{value:"",checked:false,hidden:false,disabled:false,dataset:{},innerHTML:"",textContent:"",listeners:new Map(),classList:{toggle(){},add(){},remove(){}},addEventListener(name:string,fn:unknown){this.listeners.set(name,fn);}});return fields.get(id);};
  const payload=(enabled:boolean)=>({config:{enabled,publicOrigin:"http://127.0.0.1:8790",port:8790,hosts:[],profile:{settings:{},extensions:[]}},hosts:[],networkAddresses:[],instances:[],extensionChoices:[]});
  let reads=0;
  const context=vm.createContext({window:{confirm:()=>true},setInterval(){},document:{hidden:false,querySelector:field,querySelectorAll(){return[];},addEventListener(name:string,fn:()=>void){if(name==="DOMContentLoaded")ready.push(fn);}},escapeHtml:String,escapeAttr:String,toast(){},
    api:async(_url:string,init?:{method?:string;body?:any})=>init?.method==="PUT"?{config:init.body.config}:++reads===2?gate.promise:payload(reads>2)});
  vm.runInContext(fs.readFileSync(new URL("../src/web/ide.js",import.meta.url),"utf8"),context);for(const fn of ready)fn();
  await context.window.gatewayIDE.refresh();const old=context.window.gatewayIDE.refresh();
  if(operation==="newer-read")await context.window.gatewayIDE.refresh();else{field("#ideEnabled").checked=true;await field("#ideForm").listeners.get("submit")({preventDefault(){}});}
  gate.resolve(payload(false));await old;assert.equal(field("#ideEnabled").checked,true);
});

test("settings commit feedback does not depend on an optional Taskboard refresh",async()=>{
  const gate=Promise.withResolvers<any>(),messages:string[]=[],fields=new Map<string,any>();
  const field=(id:string)=>{if(!fields.has(id))fields.set(id,{value:"",checked:false,disabled:false});return fields.get(id);};
  let optionalReads=0,refresh:Promise<unknown>|undefined;
  const context=vm.createContext({AbortSignal,document:{addEventListener(){},querySelector:field},window:{},location:{hash:"#settings"}});
  vm.runInContext(fs.readFileSync(new URL("../src/web/app.js",import.meta.url),"utf8"),context);
  context.api=async(url:string)=>{if(url==="/api/config")return{config:{model:"saved"},codexRuntime:{},codexModels:[]};++optionalReads;return gate.promise;};
  const refreshTaskboard=context.refreshTaskboardIssues;
  context.refreshTaskboardIssues=(...args:unknown[])=>refresh=refreshTaskboard(...args);
  context.renderAll=()=>{};context.toast=(s:string)=>messages.push(s);context.drawIcons=()=>{};
  context.renderTaskboardStatus=()=>{};context.renderTaskboardWorkbench=()=>{};
  const button={disabled:false},work=context.saveSettings({preventDefault(){},submitter:button});
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(messages.includes("设置已保存"),"the durable save is acknowledged before optional refresh completes");
    assert.equal(button.disabled,false);
    assert.equal(optionalReads,1);
    gate.reject(Error("optional service unavailable"));await work;await refresh;
    assert.ok(messages.includes("设置已保存"));
  }finally{gate.resolve({enabled:false});await work;await refresh;}
});

for(const form of ["session","project"] as const)test(`an old ${form} save cannot close the reopened edit dialog`,async()=>{
  const gate=Promise.withResolvers<any>(),fields=new Map<string,any>();
  const field=(id:string)=>{if(!fields.has(id))fields.set(id,{value:"",checked:false,disabled:false,open:false,showModal(){this.open=true;},close(){this.open=false;},focus(){},select(){},querySelectorAll(){return[];}});return fields.get(id);};
  const context=vm.createContext({document:{addEventListener(){},querySelector:field},window:{},location:{hash:"#sessions"}});
  vm.runInContext(fs.readFileSync(new URL("../src/web/app.js",import.meta.url),"utf8"),context);
  vm.runInContext(`els.${form}Dialog = document.querySelector("#${form}Dialog")`,context);
  context.api=()=>gate.promise;context.refreshData=async()=>{};context.toast=()=>{};
  const open=form==="session"?context.openRenameSessionDialog:context.openRenameProjectDialog;
  const save=form==="session"?context.saveSession:context.saveProject;
  open({accountId:"a",id:"old",title:"Old",name:"Old"});
  const work=save({preventDefault(){},submitter:{disabled:false}});
  field(`#${form}Dialog`).close();open({accountId:"a",id:"new",title:"New",name:"New"});
  gate.resolve({});await work;
  assert.equal(field(`#${form}Dialog`).open,true);
  assert.equal(field(form==="session"?"#sessionTitleInput":"#projectNameInput").value,"New");
});

test("one session form cannot submit the same click twice while its write is pending",async()=>{
  const gate=Promise.withResolvers<any>(),fields=new Map<string,any>();let writes=0;
  const field=(id:string)=>{if(!fields.has(id))fields.set(id,{value:"",disabled:false,open:false,showModal(){this.open=true;},close(){this.open=false;},focus(){},select(){},querySelectorAll(){return[];}});return fields.get(id);};
  const context=vm.createContext({document:{addEventListener(){},querySelector:field},window:{},location:{hash:"#sessions"}});
  vm.runInContext(fs.readFileSync(new URL("../src/web/app.js",import.meta.url),"utf8"),context);
  vm.runInContext('els.sessionDialog = document.querySelector("#sessionDialog")',context);
  context.api=()=>{writes++;return gate.promise;};context.refreshData=async()=>{};context.toast=()=>{};
  context.openRenameSessionDialog({accountId:"a",id:"old",title:"Old"});
  field("#editingSessionId").value="";field("#sessionSenderInput").value="a\nchat";field("#sessionProjectInput").value="project";
  const event={preventDefault(){},submitter:{disabled:false}};
  const first=context.saveSession(event),second=context.saveSession(event);
  try{assert.equal(writes,1);assert.equal(event.submitter.disabled,true);}
  finally{gate.resolve({session:{accountId:"a",id:"created"}});await Promise.all([first,second]);}
  assert.equal(event.submitter.disabled,false);
});

for(const kind of ["account","removal","channel","notification","taskboard"] as const)test(`reused ${kind} dialog is not closed by the preceding submission`,async()=>{
  const gate=Promise.withResolvers<any>(),fields=new Map<string,any>();
  const field=(id:string)=>{if(!fields.has(id))fields.set(id,{value:"",checked:false,disabled:false,open:false,showModal(){this.open=true;},close(){this.open=false;},focus(){},select(){},reset(){},setAttribute(){},querySelectorAll(){return[];}});return fields.get(id);};
  const context=vm.createContext({document:{addEventListener(){},querySelector:field,querySelectorAll(){return[];}},window:{},location:{hash:"#accounts"},channelModeSettings:{populate(){},serialize(){return{};}}});
  vm.runInContext(fs.readFileSync(new URL("../src/web/app.js",import.meta.url),"utf8"),context);
  const dialogName={account:"account",removal:"removeAccount",channel:"channel",notification:"projectNotification",taskboard:"taskboardAction"}[kind];
  vm.runInContext(`els.${dialogName}Dialog=document.querySelector("#${dialogName}Dialog")`,context);
  context.api=()=>gate.promise;context.refreshData=async()=>{};context.refreshTaskboardIssues=async()=>{};context.toast=()=>{};context.drawIcons=()=>{};
  field("#channelTypeInput").value="feishu";
  const target=(id:string)=>({accountId:id,id,name:id,channel:"feishu",pairedSenderIds:[]});
  const open=(id:string)=>kind==="account"?context.openAccountSettingsDialog(target(id)):kind==="removal"?context.openRemoveAccountDialog(target(id))
    :kind==="channel"?context.openChannelDialog():kind==="notification"?context.openProjectNotificationDialog(target(id)):context.openTaskboardActionDialog(id,"blocked",1);
  const save={account:context.saveAccountSettings,removal:context.removeAccount,channel:context.saveChannel,notification:context.saveProjectNotifications,taskboard:context.submitTaskboardAction}[kind];
  open("old");const work=save({preventDefault(){},submitter:{disabled:false}});
  field(`#${dialogName}Dialog`).close();open("new");gate.resolve({});await work;
  assert.equal(field(`#${dialogName}Dialog`).open,true);
});

test("retired project discovery cannot overwrite a newer rename dialog",async()=>{
  const gate=Promise.withResolvers<any>(),fields=new Map<string,any>();
  const field=(id:string)=>{if(!fields.has(id))fields.set(id,{value:"",disabled:false,open:false,showModal(){this.open=true;},close(){this.open=false;},focus(){},select(){},querySelectorAll(){return[];}});return fields.get(id);};
  const context=vm.createContext({document:{addEventListener(){},querySelector:field},window:{},location:{hash:"#sessions"}});
  vm.runInContext(fs.readFileSync(new URL("../src/web/app.js",import.meta.url),"utf8"),context);
  vm.runInContext('els.projectDialog=document.querySelector("#projectDialog");state.accounts=[{accountId:"a",pairedSenderIds:["actor"]}]',context);
  context.api=()=>gate.promise;context.toast=()=>{};
  const work=context.openNewProjectDialog("a");field("#projectDialog").close();
  context.openRenameProjectDialog({accountId:"a",id:"new",name:"My edit"});
  gate.resolve({projects:[{projectId:"native",name:"Late name",workspace:"/synthetic"}]});await work;
  assert.equal(field("#projectNameInput").value,"My edit");
  assert.equal(field("#projectWorkspaceInput").disabled,true);
});

for (const mode of ["refresh", "coalescing"] as const) test(`IDE activity read ownership: ${mode}`, async () => {
  const gate = Promise.withResolvers<any>(), fields = new Map<string, any>();
  const field = (id: string) => { if (!fields.has(id)) fields.set(id, { value: "", hidden: false, checked: false, disabled: false, innerHTML: "", textContent: "", classList: { toggle() {} } }); return fields.get(id); };
  let poll: () => Promise<void> = async () => {}, reads = 0;
  const payload = (origin: string) => ({ config: { enabled: false, publicOrigin: "http://127.0.0.1:8790", port: 8790, hosts: [], profile: { settings: {}, extensions: [] } }, hosts: [], instances: [], extensionChoices: [], endpoints: [{ hostId: "local", publicOrigin: origin, state: "ready" }] });
  const context = vm.createContext({ window: {}, setInterval(fn: () => Promise<void>) { poll = fn; }, document: { hidden: false, addEventListener() {}, querySelector: field }, escapeAttr: String, escapeHtml: String, toast() {},
    api: async () => { reads++; return reads === 2 ? gate.promise : payload("https://new.example.invalid"); } });
  vm.runInContext(fs.readFileSync(new URL("../src/web/ide.js", import.meta.url), "utf8"), context);
  await context.window.gatewayIDE.refresh();
  const old = poll();
  if (mode === "coalescing") { await poll(); assert.equal(reads, 2, "only one activity poll may be in flight"); }
  await context.window.gatewayIDE.refresh();
  gate.resolve(payload("https://old.example.invalid")); await old;
  assert.match(field("#ideEndpoints").innerHTML, /new\.example/);
  assert.doesNotMatch(field("#ideEndpoints").innerHTML, /old\.example/);
});
