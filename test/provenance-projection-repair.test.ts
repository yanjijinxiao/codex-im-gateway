import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ThreadEventHub, type ThreadSubscription } from '../src/server/thread-event-hub.js';
import type { CodexThreadSnapshot } from '../src/codex/backend.js';

for(const proof of ['active','terminal','missing','other-thread','binding-change','healthy-current','clean-current'] as const)
test(`polluted progress only recovers with same-owner complete active provenance: ${proof}`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-provenance-repair-')),filePath=path.join(root,'state.json');
 const started=new Date(Date.now()-600000).toISOString();
 const healthy=proof==='healthy-current'||proof==='clean-current';
 fs.writeFileSync(filePath,JSON.stringify({binding:{eventVersion:2,deliveryVersion:1,hostId:'local',threadId:'thread',initialized:true,sequence:0,
  turnId:healthy?'main':'foreign-child',checkpointTurnId:healthy?'main':'foreign-child',startedAt:healthy?started:new Date().toISOString(),completed:healthy?(proof==='clean-current'?['older']:['older','foreign-child']):['main','foreign-child'],baseline:[],delivered:[],
  checkpoint:{messageId:'wrong-card',streamId:'wrong-card',startedAt:Date.now(),progressEntries:['CHILD_PROGRESS'],thought:'',answerPreview:'CHILD_TEXT',finished:false}}}));
 const frames:Array<{messageId:string;text:string;finalize?:boolean}>=[];
 const sub:ThreadSubscription={key:'binding',hostId:'local',threadId:'thread',recipientId:'chat',managed:false,
  client:{resumableTextStream:true,async sendText(){throw Error('no plain fallback');},async startTextStream(input){frames.push({messageId:'main-card',text:input.text});return{messageId:'main-card'};},async updateTextStream(input){frames.push(input);}}};
 const snap:CodexThreadSnapshot={state:{threadId:'thread',persistence:'active',executionOwner:'desktop',runtimeStatus:'active',activeTurnId:'main',activeFlags:[]},
  turns:[{id:'main',status:'inProgress',startedAt:started,messages:[{id:'progress',role:'assistant',kind:'progress',text:'ROOT_PROGRESS'}]}]};
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve});
 const hub=new ThreadEventHub({filePath,subscriptions:()=>[sub],backend:()=>({async readThreadSnapshot(){return structuredClone(snap);},
  async readThreadProvenance(){await gate;if(proof==='missing')return undefined;return{threadId:proof==='other-thread'?'other':'thread',complete:true as const,turns:[{id:'older',status:'completed' as const},{id:'main',status:proof==='terminal'?'completed' as const:'inProgress' as const}]};}})});
 t.after(async()=>{release();await hub.stop();fs.rmSync(root,{recursive:true,force:true});});
 await hub.synchronize('binding');assert.equal(frames.some(x=>x.messageId==='main-card'),false,'a snapshot alone cannot reopen an acknowledged completion');
 if(proof==='binding-change')sub.threadId='replacement';release();
 for(let i=0;i<100;i++){await new Promise(resolve=>setImmediate(resolve));if(JSON.parse(fs.readFileSync(filePath,'utf8')).binding.provenanceVersion===3||proof!=='active'&&i>10)break;}
 const state=JSON.parse(fs.readFileSync(filePath,'utf8')).binding;
 if(proof==='active'){
  assert.equal(state.turnId,'main');assert.equal(state.completed.includes('main'),false);assert.equal(state.completed.includes('foreign-child'),false);
  assert.equal(state.provenanceVersion,3);assert.equal(state.checkpoint.startedAt,Date.parse(started));
  assert.match(frames.find(x=>x.messageId==='wrong-card')!.text,/子任务结果/);
  assert.ok(frames.some(x=>x.messageId==='main-card'&&x.text.includes('ROOT_PROGRESS')));
  assert.equal(hub.status('binding').status,'synced');
 }else if(healthy){
  assert.equal(state.provenanceVersion,3);assert.deepEqual(state.completed,['older']);assert.equal(state.checkpoint.messageId,'wrong-card');
  assert.equal(frames.some(x=>x.messageId==='main-card'||x.finalize),false,'a healthy current card must not be rotated');
  if(proof==='healthy-current')assert.ok(frames.some(x=>x.text.includes('已校正来源')));
  else assert.equal(frames.some(x=>x.text.includes('子任务')),false,'clean provenance needs no correction notice');
 }else assert.equal(frames.some(x=>x.messageId==='main-card'||x.finalize),false,'insufficient or changed provenance never causes a new or finalized card');
});
