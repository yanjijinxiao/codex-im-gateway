import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {AppServerCodexRunner} from "../src/codex/app-server-runner.js";
import {CodexBackendRouter} from "../src/codex/runner.js";
import {BridgeService} from "../src/bridge/service.js";
import {RuntimeStateStore} from "../src/state/runtime-state.js";
import {resolveStatePaths} from "../src/state/paths.js";
import {defaultConfig} from "../src/state/config.js";
import {APP_SERVER_BACKEND_CAPABILITIES, CodexBackendCapabilityError, CodexQueueAdmissionError, type CodexQueueAddInput} from "../src/codex/backend.js";
import {NativeQueueCoordinator} from "../src/bridge/native-queue.js";

for(const mode of ["stdio","daemon-proxy","remote-daemon"] as const) test(`${mode}: external queue admission/list/cancel never resume or reconfigure the owner`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-owner-queue-")),file=path.join(dir,"methods");
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const runner=new AppServerCodexRunner({codexHome:dir,transport:{command:process.execPath,args:[path.resolve("test/fixtures/fake-external-queue.mjs"),file],mode},requestTimeoutMs:1000});t.after(()=>runner.close());
 const item=await runner.addQueuedSubmission({threadId:"native",prompt:"queued body",clientUserMessageId:"source-id",...(mode==="stdio"?{enqueueOnly:true}:{})});
 assert.equal((await runner.listQueuedSubmissions("native")).data[0].id,item.id);
 assert.equal(await runner.deleteQueuedSubmission("native",item.id),true);
 const methods=fs.readFileSync(file,"utf8").trim().split("\n");
 assert.ok(methods.includes("thread/queue/add"));assert.doesNotMatch(methods.join("\n"),/thread\/resume|turn\/start|turn\/steer|thread\/queue\/start|settings/);
});

test("backend chooses external admission from a fresh confirmed Desktop owner",async t=>{
 const inputs:CodexQueueAddInput[]=[],owner={threadId:"thread",persistence:"active",runtimeStatus:"active",executionOwner:"desktop",activeFlags:[],activeTurnId:"current"};
 const app={capabilities:APP_SERVER_BACKEND_CAPABILITIES,async inspectThread(){return{...owner,runtimeStatus:"notLoaded",executionOwner:undefined};},async addQueuedSubmission(x:CodexQueueAddInput){inputs.push(x);return{id:"q",clientUserMessageId:x.clientUserMessageId,input:[]};},async listQueuedSubmissions(){return{data:[]};},async deleteQueuedSubmission(){return true;},async runQueuedSubmission(){assert.fail("admission must not consume");},close(){}};
 const router=new CodexBackendRouter({backend:"app-server",appServerBackend:app as never,desktopRunner:{async inspectThread(){return owner;},close(){}} as never});t.after(()=>router.close());
 await router.addQueuedSubmission({threadId:"thread",prompt:"queue",clientUserMessageId:"origin"});
 assert.equal(inputs.length,1);assert.equal(inputs[0].enqueueOnly,true);assert.equal(inputs[0].clientUserMessageId,"origin");
});

test("the IM /queue entry accepts Desktop ownership and stores only its native receipt",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-im-desktop-queue-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new RuntimeStateStore(resolveStatePaths(dir)),p=store.createProject("Project",dir);store.activateProject("actor",p.id);const s=store.createSession("actor",dir,undefined,p.id);store.setSessionThread(s.id,"native");
 const messages:string[]=[],items:Array<{id:string;clientUserMessageId:string;input:unknown[]}>=[];
 const service=new BridgeService({config:{...defaultConfig(dir),codexBackend:"app-server",allowedSenderIds:["actor"]},stateStore:store,
  weixin:{async sendText(x){messages.push(x.text);return{messageId:"reply"};}},runner:{backendInfo(){return{id:"app-server",capabilities:APP_SERVER_BACKEND_CAPABILITIES};},async inspectThread(){return{threadId:"native",persistence:"active",runtimeStatus:"active",activeFlags:[],executionOwner:"desktop",activeTurnId:"running"};},async addQueuedSubmission(x){const item={id:"native-queue-id",clientUserMessageId:x.clientUserMessageId,input:[{type:"text",text:x.prompt}]};items.push(item);return item;},async listQueuedSubmissions(){return{data:items};},async getHistoryPage(){return{messages:[]};}} as never});
 await service.handleMessage({id:"im-queue-source",senderId:"actor",text:"/queue review next",raw:{}});
 assert.equal(items.length,1);assert.match(messages.at(-1)!,/加入原生队列/);assert.doesNotMatch(messages.at(-1)!,/Desktop.*不支持/);
 assert.ok(!fs.readFileSync(path.join(path.dirname(store.controlJournalPath),"native-submissions.json"),"utf8").includes("review next"));
});

for (const change of ["detach", "replace-thread", "stop", "revoke-role", "reconfigure"] as const)
test(`queue preflight rechecks ${change} after asynchronous preparation`, async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-queue-preflight-")); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new RuntimeStateStore(resolveStatePaths(dir)),p=store.createProject("Project",dir);store.activateProject("actor",p.id);
 const s=store.createSession("actor",dir,undefined,p.id);store.setSessionThread(s.id,"native");
 const inspecting=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let writes=0,changing=false;
 const service=new BridgeService({config:{...defaultConfig(dir),allowedSenderIds:["actor"]},stateStore:store,
  assertRuntimeWritable(){if(changing)throw Error("configuration changed");},weixin:{async sendText(){return{messageId:"reply"};}},
  runner:{backendInfo(){return{id:"app-server",capabilities:APP_SERVER_BACKEND_CAPABILITIES};},async inspectThread(){inspecting.resolve();await release.promise;return{threadId:"native",persistence:"active",runtimeStatus:"active",activeFlags:[],executionOwner:"desktop"};},
   async addQueuedSubmission(){writes++;throw Error("stale submission");}} as never});
 const pending=service.handleMessage({id:"source",senderId:"actor",text:"/queue next",raw:{}}); await inspecting.promise;
 assert.equal(service.hasInFlightWork(),true);
 if(change==="detach")store.leaveSession("actor");
 if(change==="replace-thread")store.setSessionThread(s.id,"replacement");
 if(change==="stop")service.suspendUserInputs();
 if(change==="revoke-role")store.setRole("actor","actor","viewer");
 if(change==="reconfigure")changing=true;
 release.resolve();await assert.rejects(pending,/未提交|configuration changed/);
 assert.equal(writes,0);assert.equal(service.hasInFlightWork(),false);
});

test("last admission rejection sends no native RPC; a safe retry rechecks admission with the same identity",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-queue-final-guard-")),file=path.join(dir,"methods");t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const runner=new AppServerCodexRunner({codexHome:dir,transport:{command:process.execPath,args:[path.resolve("test/fixtures/fake-external-queue.mjs"),file],mode:"stdio"},requestTimeoutMs:1000});t.after(()=>runner.close());
 const journal=new NativeQueueCoordinator(path.join(dir,"receipt.json"));let checks=0;
 const backend={backendInfo(){return{id:"app-server",capabilities:APP_SERVER_BACKEND_CAPABILITIES};},addQueuedSubmission(input:CodexQueueAddInput){return runner.addQueuedSubmission({...input,enqueueOnly:true});}};
 const origin={accountId:"a",conversationId:"chat",actorId:"actor",messageId:"im",sessionId:"s",hostId:"local",threadId:"native",backend:"app-server" as const};
 await assert.rejects(journal.enqueue(origin,"private queued text",backend as never,{assertCurrent(){if(++checks===2)throw Error("binding changed before RPC");}}),CodexQueueAdmissionError);
 assert.equal(journal.list("a")[0].status,"rejected");assert.equal(checks,2);
 assert.doesNotMatch(fs.readFileSync(file,"utf8"),/thread\/queue\/add|thread\/resume/);
 const original=journal.list("a")[0].clientUserMessageId;
 const accepted=await journal.enqueue(origin,"private queued text",backend as never,{assertCurrent(){checks++;}});
 assert.equal(checks,4);assert.equal(accepted.clientUserMessageId,original);assert.equal(accepted.status,"queued");
 assert.equal(fs.readFileSync(file,"utf8").split("\n").filter(x=>x==="thread/queue/add").length,1);
 await journal.enqueue(origin,"private queued text",backend as never,{assertCurrent(){assert.fail("accepted input must not be replayed");}});
});

test("unsupported external native queue never falls back to turn/start or replaces Desktop state",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-queue-unsupported-")),file=path.join(dir,"methods");t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const runner=new AppServerCodexRunner({codexHome:dir,transport:{command:process.execPath,args:[path.resolve("test/fixtures/fake-external-queue.mjs"),file,"--unsupported"],mode:"stdio"},requestTimeoutMs:1000});t.after(()=>runner.close());
 await assert.rejects(runner.addQueuedSubmission({threadId:"native",prompt:"next",clientUserMessageId:"im",enqueueOnly:true}),CodexBackendCapabilityError);
 assert.deepEqual(fs.readFileSync(file,"utf8").trim().split("\n"),["initialize","thread/queue/add"]);
});

test("close confirms a delayed client exit before permitting a replacement lifecycle",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-queue-exit-")),file=path.join(dir,"methods");t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const runner=new AppServerCodexRunner({codexHome:dir,transport:{command:process.execPath,args:[path.resolve("test/fixtures/fake-external-queue.mjs"),file,"--delayed-exit"],mode:"stdio"},requestTimeoutMs:1000});t.after(()=>runner.close());
 await runner.addQueuedSubmission({threadId:"native",prompt:"next",clientUserMessageId:"im",enqueueOnly:true});
 const stopped=runner.close();assert.equal(runner.close(),stopped);await stopped;
 assert.match(fs.readFileSync(file,"utf8"),/process-exited/);
 await assert.rejects(runner.listQueuedSubmissions("native"),/closed/);
});

test("a rejected owned admission releases its subscription and origin before retrying other work",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-owned-rejection-")),file=path.join(dir,"methods");t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const runner=new AppServerCodexRunner({codexHome:dir,transport:{command:process.execPath,args:[path.resolve("test/fixtures/fake-external-queue.mjs"),file,"--owned"],mode:"stdio"},requestTimeoutMs:1000});t.after(()=>runner.close());
 await assert.rejects(runner.addQueuedSubmission({threadId:"native",prompt:"next",clientUserMessageId:"im",assertCurrent(){throw Error("binding changed");}}),CodexQueueAdmissionError);
 assert.deepEqual(fs.readFileSync(file,"utf8").trim().split("\n"),["initialize","thread/resume","thread/unsubscribe"]);
});

test("fresh non-runnable queue target is a definite admission rejection with no native mutation",async t=>{
 let writes=0;
 const app={capabilities:APP_SERVER_BACKEND_CAPABILITIES,async inspectThread(threadId:string){return{threadId,persistence:"archived",runtimeStatus:"notLoaded",activeFlags:[]};},async addQueuedSubmission(){writes++;throw Error("must not run");},async listQueuedSubmissions(){return{data:[]};},async deleteQueuedSubmission(){return false;},async runQueuedSubmission(){throw Error("must not run");},close(){}};
 const router=new CodexBackendRouter({backend:"app-server",appServerBackend:app as never});t.after(()=>router.close());
 await assert.rejects(router.addQueuedSubmission({threadId:"native",prompt:"next",clientUserMessageId:"im"}),CodexQueueAdmissionError);
 assert.equal(writes,0);
});
