import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {ThreadEventHub,type ThreadSubscription} from "../src/server/thread-event-hub.js";
import type {CodexThreadSnapshot,CodexTurnObservation} from "../src/codex/backend.js";

function fixture(t:test.TestContext,legacy=true){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-queue-correction-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const filePath=path.join(dir,"follow.json"),updates:Array<{messageId:string;text:string;finalize?:boolean}>=[],starts:string[]=[];
 const checkpoint={messageId:"wrong-card",streamId:"wrong-card",startedAt:Date.now(),progressEntries:["initial"],thought:"",answerPreview:"",finished:true,
  terminal:{text:"Codex 本轮任务已中断；未自动重启或重发消息。",error:true,outcome:"interrupted"}};
 fs.writeFileSync(filePath,JSON.stringify({binding:{eventVersion:2,deliveryVersion:1,hostId:"local",threadId:"thread",turnId:"turn",checkpointTurnId:"turn",sequence:0,delivered:[],completed:["turn"],baseline:[],initialized:true,checkpoint}}));
 let enabled=true,observation:CodexTurnObservation={status:"inProgress",source:"owner"};
 let snapshot:CodexThreadSnapshot={state:{threadId:"thread",persistence:"active",runtimeStatus:"active",executionOwner:"desktop",activeFlags:[],activeTurnId:"turn"},turns:[{id:"turn",status:"inProgress",messages:[{id:"progress",role:"assistant",kind:"progress",text:"still running"}]}]};
 const sub:ThreadSubscription={key:"binding",hostId:"local",threadId:"thread",recipientId:"chat",managed:false,client:{resumableTextStream:true,
  async sendText(){assert.fail("no text fallback");},async startTextStream(x){starts.push(x.streamId!);return{messageId:x.streamId!};},async updateTextStream(x){updates.push(x);}}};
 const options={filePath,subscriptions:()=>enabled?[sub]:[],legacyQueueTerminal:(_sub:ThreadSubscription,id:string)=>legacy&&id==="turn",
  turnAudience:{correctionTargets:()=>["mention-card"],originalCorrectionCards:()=>["wrong-card"],participants:()=>[],record(){},async notify(){}} as never,
  backend:()=>({async readThreadSnapshot(){return structuredClone(snapshot);},async readTurnLifecycle(){return observation;}})};
 const hub=new ThreadEventHub(options);t.after(()=>hub.stop());
 return{hub,options,filePath,updates,starts,sub,setSnapshot(x:CodexThreadSnapshot){snapshot=x;},setObservation(x:CodexTurnObservation){observation=x;},detach(){enabled=false;}};
}

test("a verified premature queue stop corrects known cards, resumes live followups and delivers the genuine final once",async t=>{
 const f=fixture(t);await f.hub.refresh();
 assert.ok(f.updates.some(x=>x.messageId==="wrong-card"&&/判断错误/.test(x.text)));
 assert.ok(f.updates.some(x=>x.messageId==="mention-card"&&/判断错误/.test(x.text)));
 assert.equal(f.starts.length,1);
 await f.hub.acceptedInput({id:"steer-receipt",kind:"steer",hostId:"local",threadId:"thread",turnId:"turn",acceptedAt:Date.now()});
 f.setSnapshot({state:{threadId:"thread",persistence:"active",runtimeStatus:"active",executionOwner:"desktop",activeFlags:[],activeTurnId:"turn"},turns:[{id:"turn",status:"inProgress",messages:[{id:"followup",role:"assistant",kind:"progress",text:"ANSWER_TO_FOLLOWUP"}]}]});
 await f.hub.refresh();await f.hub.synchronize("binding");
 assert.ok(f.updates.some(x=>/ANSWER_TO_FOLLOWUP/.test(x.text)));
 f.setSnapshot({state:{threadId:"thread",persistence:"active",runtimeStatus:"idle",executionOwner:"desktop",activeFlags:[]},turns:[{id:"turn",status:"completed",messages:[{id:"final",role:"assistant",text:"GENUINE_FINAL"}]}]});
 await f.hub.refresh();assert.ok(f.updates.some(x=>x.finalize&&/GENUINE_FINAL/.test(x.text)));
 const count=f.updates.filter(x=>x.finalize&&/GENUINE_FINAL/.test(x.text)).length;
 await f.hub.stop();const restored=new ThreadEventHub(f.options);t.after(()=>restored.stop());await restored.refresh();
 assert.equal(f.updates.filter(x=>x.finalize&&/GENUINE_FINAL/.test(x.text)).length,count);
 assert.equal(f.updates.filter(x=>x.messageId==="mention-card").length,1);
});

for(const legacy of [true,false])test(`a real stop or unrelated completed card is never reopened: legacy=${legacy}`,async t=>{
 const f=fixture(t,legacy);if(legacy)f.setObservation({status:"interrupted",source:"native-event"});await f.hub.refresh();
 assert.equal(f.updates.length,0);assert.equal(f.starts.length,0);
});

test("old false-stop correction cannot rotate or overwrite a newer turn",async t=>{
 const f=fixture(t),data=JSON.parse(fs.readFileSync(f.filePath,"utf8")),old=data.binding.checkpoint;
 data.binding.pendingTerminals={turn:{text:old.terminal.text,outcome:"interrupted",checkpoint:old}};
 data.binding.turnId="new-turn";data.binding.checkpointTurnId="new-turn";delete data.binding.checkpoint;
 fs.writeFileSync(f.filePath,JSON.stringify(data));await f.hub.stop();
 f.setObservation({status:"completed",source:"native-event",text:"ACTUAL_OLD_RESULT"});
 f.setSnapshot({state:{threadId:"thread",persistence:"active",runtimeStatus:"active",executionOwner:"desktop",activeFlags:[],activeTurnId:"new-turn"},turns:[{id:"new-turn",status:"inProgress",messages:[{id:"new",role:"assistant",kind:"progress",text:"NEW_TASK_PROGRESS"}]}]});
 const hub=new ThreadEventHub(f.options);t.after(()=>hub.stop());await hub.refresh();await hub.synchronize("binding");
 assert.ok(f.updates.some(x=>x.messageId==="wrong-card"&&/ACTUAL_OLD_RESULT/.test(x.text)));
 assert.ok(f.updates.some(x=>x.messageId!=="wrong-card"&&x.messageId!=="mention-card"&&/NEW_TASK_PROGRESS/.test(x.text)));
 assert.equal(JSON.parse(fs.readFileSync(f.filePath,"utf8")).binding.turnId,"new-turn");
});

test("detaching during correction observation prevents every channel write",async t=>{
 const f=fixture(t),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const options={...f.options,backend:()=>({...f.options.backend(),async readTurnLifecycle(){entered.resolve();await release.promise;return{status:"inProgress" as const,source:"owner" as const};}})};
 await f.hub.stop();const hub=new ThreadEventHub(options);t.after(()=>hub.stop());
 const pending=hub.refresh();await entered.promise;f.detach();release.resolve();await pending;
 assert.equal(f.updates.length,0);assert.equal(f.starts.length,0);
});

test("explicit repair of a rotated checkpoint uses acknowledged cards and cannot modify another binding or turn",async t=>{
 const f=fixture(t),data=JSON.parse(fs.readFileSync(f.filePath,"utf8"));
 delete data.binding.checkpoint;delete data.binding.checkpointTurnId;
 data.binding.turnId="new-turn";fs.writeFileSync(f.filePath,JSON.stringify(data));await f.hub.stop();
 f.setObservation({status:"completed",source:"native-event",text:"ACTUAL_RESULT\n```codex-im-gateway-actions\n{\"send\":[]}\n```"});
 f.setSnapshot({state:{threadId:"thread",persistence:"active",runtimeStatus:"active",executionOwner:"desktop",activeFlags:[],activeTurnId:"new-turn"},turns:[{id:"new-turn",status:"inProgress",messages:[]}]});
 const hub=new ThreadEventHub(f.options);t.after(()=>hub.stop());
 await assert.rejects(hub.repairQueuedTerminal("other-binding","turn"),/当前绑定/);
 await assert.rejects(hub.repairQueuedTerminal("binding","other-turn"),/当前绑定/);
 assert.equal(await hub.repairQueuedTerminal("binding","turn"),true);
 assert.deepEqual(f.updates.map(x=>x.messageId),["wrong-card","mention-card"]);
 assert.ok(f.updates.every(x=>/ACTUAL_RESULT/.test(x.text)&&!x.text.includes("codex-im-gateway-actions")));
 assert.equal(await hub.repairQueuedTerminal("binding","turn"),true);
 assert.equal(f.updates.length,2);
 assert.equal(JSON.parse(fs.readFileSync(f.filePath,"utf8")).binding.turnId,"new-turn");
});
