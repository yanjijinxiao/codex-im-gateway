import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { parseDesktopSnapshot } from "../src/codex/desktop-runner.js";
import { CliSessionStore } from "../src/codex/cli-sessions.js";

test("reasoning delta accumulation retains whitespace between wire chunks",async()=>{
  const runner:any=new AppServerCodexRunner(),progress:string[]=[];
  const key="thread\0turn";
  runner.turnStreams.set(key,{chain:Promise.resolve(),onProgress:(s:string)=>{progress.push(s);}});
  for(const delta of ["Hello"," ","world","\n","Next paragraph"])
    runner.handleMessage(JSON.stringify({method:"item/reasoning/summaryTextDelta",params:{threadId:"thread",turnId:"turn",itemId:"summary",delta}}));
  await runner.turnStreams.get(key).chain;
  assert.equal(progress.at(-1),"🤔 Hello world\nNext paragraph");
  await runner.close();
});

for(const persistence of ["active","archived","all"] as const) test(`storage catalog respects ${persistence} persistence when Desktop catalog is absent`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-catalog-contract-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runner:any=new AppServerCodexRunner({codexHome:root}),requests:boolean[]=[];
  runner.ensureConnected=async()=>{};runner.recyclePrivateTransportIfIdle=async()=>{};
  runner.request=async(_method:string,params:any)=>{requests.push(params.archived);return {data:[{
    id:params.archived?"archived-thread":"active-thread",status:"idle",source:"appServer",cwd:"/fixture",
    ...(params.archived?{path:"/fixture/archived_sessions/thread.jsonl"}:{}),updatedAt:params.archived?20:10
  }]};};
  const catalog=await runner.listSessionCatalog({persistence});
  assert.deepEqual(requests,persistence==="all"?[false,true]:[persistence==="archived"]);
  assert.deepEqual(catalog.threads.map((s:any)=>s.threadId),persistence==="all"?["archived-thread","active-thread"]:[`${persistence}-thread`]);
  await runner.close();
});

test("malformed optional file-change entries cannot throw out of the native notification callback",async()=>{
  const runner:any=new AppServerCodexRunner();
  assert.doesNotThrow(()=>runner.handleMessage(JSON.stringify({method:"item/completed",params:{threadId:"t",turnId:"n",
    item:{type:"fileChange",changes:[null,{path:"/fixture/file.ts"}]}}})));
  assert.match(runner.queuedTurnEvents.get("t\0n")[0].text,/file.ts/);
  await runner.close();
});

test("Desktop history ordering uses the supported legacy start timestamp too",()=>{
  const snapshot=parseDesktopSnapshot("thread",{threadRuntimeStatus:{type:"active"},turnHistory:{history:{entitiesByKey:{
    latest:{turnId:"current",status:"inProgress",startedAt:200},
    olderPage:{turnId:"old",status:"completed",startedAt:100}
  }}}});
  assert.deepEqual(snapshot.turns.map(t=>t.id),["old","current"]);
  assert.equal(snapshot.state.activeTurnId,"current");
  assert.equal(snapshot.state.latestTurnStatus,"inProgress");
});

test("CLI history does not turn a failed native completion into a successful turn",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-cli-failure-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,"sessions"));
  fs.writeFileSync(path.join(root,"sessions/thread.jsonl"),[
    {type:"session_meta",payload:{id:"thread",cwd:root,source:"cli"}},
    {type:"event_msg",payload:{type:"task_started",turn_id:"failed-turn"}},
    {type:"event_msg",payload:{type:"task_complete",turn_id:"failed-turn",error:{message:"context window exceeded PRIVATE_PROVIDER_DETAIL"}}}
  ].map(row=>JSON.stringify(row)).join("\n")+"\n");
  const snapshot=await new CliSessionStore(root).snapshot("thread");
  assert.equal(snapshot.turns[0].status,"failed");
  assert.equal(snapshot.state.latestTurnStatus,"failed");
  assert.deepEqual(snapshot.state.lastTurnFailure,{turnId:"failed-turn",code:"context-window"});
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_PROVIDER_DETAIL/);
});
