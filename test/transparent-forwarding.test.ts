import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {BridgeService} from "../src/bridge/service.js";
import {RuntimeStateStore} from "../src/state/runtime-state.js";
import {resolveStatePaths} from "../src/state/paths.js";
import {defaultConfig} from "../src/state/config.js";
import {createChannelClient,TEXT_CAPABILITIES} from "../src/channels/client.js";
import {APP_SERVER_BACKEND_CAPABILITIES} from "../src/codex/backend.js";

for(const channel of ["dingtalk","weixin","feishu","wecom"] as const)test(`${channel}: project/session/review/skill/group requests stay intact in Codex`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-transparent-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new RuntimeStateStore(resolveStatePaths(dir)),p=store.createProject("Current",dir);store.activateProject("actor",p.id);
 const s=store.createSession("actor",dir,"Current",p.id);store.setSessionThread(s.id,"native");const inputs:any[]=[];let classifiers=0,discovery=0;
 const service=new BridgeService({config:{...defaultConfig(dir),allowedSenderIds:["actor"],streamReplies:false},stateStore:store,
  channel:createChannelClient(channel,TEXT_CAPABILITIES,{async sendText(){return{messageId:"sent"};}}),
  intentResolver:{async resolve(){classifiers++;return{kind:"command",command:{name:"project",arg:"switch Other"}};}},
  channelCapabilities:async()=>{discovery++;return[];},runner:{backendInfo(){return{id:"app-server",capabilities:APP_SERVER_BACKEND_CAPABILITIES};},
   async inspectThread(){return{threadId:"native",persistence:"active",runtimeStatus:"idle",activeFlags:[]};},
   async run(input:any){inputs.push(input);return{threadId:"native",turnId:"turn",text:"done",raw:""};}} as never});
 const texts=["在 odps_src_-_2 project 创建一个 session 来 review full text index property patch，然后用 skill 为 session 建群。","查看帮助","请切换项目并继续完成 review","说明 /project 和 /mode session 的区别"];
 for(const [i,text]of texts.entries())await service.handleMessage({id:`m-${i}`,senderId:"actor",text,raw:{}});
 assert.equal(inputs.length,texts.length);texts.forEach((text,i)=>{assert.ok(inputs[i].prompt.includes(text));assert.equal(inputs[i].threadId,"native");});
 assert.equal(classifiers,0);assert.equal(discovery,0,"ordinary text does not discover control aliases");
 assert.equal(store.getActiveProject("actor")?.id,p.id);assert.equal(store.listSessions().length,1);
 await service.handleMessage({id:"control",senderId:"actor",text:"/stream off",raw:{}});
 assert.equal(inputs.length,texts.length);assert.equal(store.getSession(s.id)?.streamReplies,false);
 await service.handleMessage({id:"unknown-control",senderId:"actor",text:"/unknown-command ordinary payload",raw:{}});
 assert.equal(inputs.length,texts.length);assert.equal(classifiers,0);
});

for(const change of ["thread","role","access"] as const)test(`ordinary IM rechecks ${change} after attachment preparation`,{timeout:4000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-transparent-guard-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new RuntimeStateStore(resolveStatePaths(dir)),p=store.createProject("Remote",dir,{hostId:"remote:test",projectKind:"remote"});store.activateProject("actor",p.id);
 const s=store.createSession("actor",dir,"Current",p.id);store.setSessionThread(s.id,"native");const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let writes=0;
 const service=new BridgeService({config:{...defaultConfig(dir),allowedSenderIds:["actor"],streamReplies:false},inboundDir:dir,stateStore:store,
  channel:createChannelClient("generic",{...TEXT_CAPABILITIES,inbound:{...TEXT_CAPABILITIES.inbound,file:"available"}},{async sendText(){return{messageId:"sent"};},async resolveAttachments(m){return m.attachments??[];}}),
  runner:{async inspectThread(){return{threadId:"native",persistence:"active",runtimeStatus:"idle",activeFlags:[]};},
   async stageAttachments(files:any[]){entered.resolve();await release.promise;return files.map(f=>({...f,path:"/remote/file"}));},
   async run(){writes++;throw Error("stale write");}} as never});
 const file=path.join(dir,"file.txt");fs.writeFileSync(file,"fixture");
 const pending=service.handleMessage({id:"source",senderId:"actor",text:"read",attachments:[{kind:"file",label:"file",path:file,item:{}}],raw:{}});
 await entered.promise;if(change==="thread")store.setSessionThread(s.id,"replacement");if(change==="role")store.setRole("actor","actor","viewer");if(change==="access")service.removeSender("actor");
 release.resolve();await pending.catch(error=>assert.match(error.message,/权限|未提交/));assert.equal(writes,0);
 if(change==="thread")assert.equal(store.getSession(s.id)?.threadId,"replacement");
});
