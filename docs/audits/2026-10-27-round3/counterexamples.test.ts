import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import test from 'node:test';
import {CodexBackendRouter} from '../../../src/codex/runner.ts';
import {TurnSubmission} from '../../../src/bridge/turn-submission.ts';
import {AccountManager} from '../../../src/server/account-manager.ts';
import {RuntimeStateStore} from '../../../src/state/runtime-state.ts';
import {resolveStatePaths,accountStatePaths} from '../../../src/state/paths.ts';
import {defaultConfig} from '../../../src/state/config.ts';
import {saveAccount} from '../../../src/weixin/accounts.ts';
import {createChannelClient,TEXT_CAPABILITIES} from '../../../src/channels/client.ts';
import {WorkspaceIDEManager} from '../../../src/ide/manager.ts';
import {IDEAuthorization} from '../../../src/ide/authorization.ts';
import {InteractionRoutingJournal} from '../../../src/bridge/interaction-routing.ts';
import {parseActionBlocks} from '../../../src/bridge/actions.ts';
import {WeComChannelAdapter} from '../../../src/channels/wecom.ts';
import {EventEmitter} from 'node:events';
import {LoginManager} from '../../../src/server/login-manager.ts';
import {normalizeDingTalkCardContent,dingTalkPlainText} from '../../../src/channels/dingtalk-markdown.ts';
import {resolveLocalAppServerTransport} from '../../../src/codex/app-server-daemon.ts';
import {isWorkspaceAllowed} from '../../../src/state/config.ts';
import {MessageHandler} from '../../../node_modules/@wecom/aibot-node-sdk/dist/index.esm.js';

// These are COUNTEREXAMPLES: passing confirms a defect, never a release regression.
const directory=(t:any,prefix:string)=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};

test('PROBE: the final submission guard does not run after the backend serialization wait',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let writes=0,checks=0,allowed=true;
 const router=new CodexBackendRouter({backend:'exec',execBackend:{async run(){writes++;if(writes===1){entered.resolve();await release.promise;}return{text:'done',raw:'',threadId:'thread',turnId:'turn'};},close(){}} as never});
 try{
  const first=router.run({prompt:'first',cwd:'/tmp',threadId:'thread'});await entered.promise;
  const second=new TurnSubmission().run(router,{prompt:'second',cwd:'/tmp',threadId:'thread'},()=>{checks++;assert.equal(allowed,true);});
  allowed=false;release.resolve();await Promise.all([first,second]);
  assert.equal(checks,1);assert.equal(writes,2,'second native write happened after authorization was revoked');
 }finally{release.resolve();await router.close();}
});

test('PROBE: late Web completion restores the thread cleared by an explicit reset',async t=>{
 const root=directory(t,'gateway-audit3-web-'),paths=resolveStatePaths(root),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 saveAccount(paths,{accountId:'one',userId:'actor',token:'synthetic',baseUrl:'https://example.invalid',enabled:false});
 const runner={async warmUp(){},async listProjects(){return{backend:'app-server',projects:[]};},async inspectThread(threadId:string){return{threadId,persistence:'active',runtimeStatus:'idle',activeFlags:[]};},
  async run(input:any){await input.onTurnStarted?.({threadId:'old-thread',turnId:'turn'});entered.resolve();await release.promise;return{threadId:'old-thread',turnId:'turn',text:'done',raw:''};},close(){}};
 const manager=new AccountManager({paths,configProvider:()=>({...defaultConfig(root),taskboardEnabled:false,streamReplies:false}),runnerFactory:()=>runner as never,
  adapterFactory:()=>({client:createChannelClient('generic',TEXT_CAPABILITIES,{async sendText(){return{messageId:'sent'};}}),async monitor({signal,onStatus}:any){onStatus?.({state:'connected'});await new Promise<void>(r=>signal.addEventListener('abort',r,{once:true}));}}),
  bridgeFactory:()=>({hasInFlightWork(){return false;},suspendUserInputs(){}} as never),
  codexSessionMonitorFactory:()=>({start(){},async stop(){}} as never),codexDesktopRequestMonitorFactory:()=>({start(){},stop(){},setFollowedThreads(){}} as never)});
 try{
  const session=manager.createSession('one','chat',root,'Original'),store=(manager as any).storeFor('one') as RuntimeStateStore;store.setSessionThread(session.id,'old-thread');
  await manager.startAccount('one',false);const pending=manager.continueSession('one',session.id,'synthetic',[],undefined,'audit3-source');await entered.promise;
  manager.resetSession('one',session.id);assert.equal(store.getSession(session.id)?.threadId,undefined);
  release.resolve();await pending;assert.equal(store.getSession(session.id)?.threadId,'old-thread','late result overwrote the explicit reset');
 }finally{release.resolve();await manager.stopAll();}
});

for(const change of ['name','root-order'] as const)test(`PROBE: cosmetic IDE ${change} changes invalidate an existing browser grant`,async t=>{
 const root=directory(t,'gateway-audit3-ide-');let target={owner:'owner',sessionId:'session',hostId:'local',projectId:'project',projectName:'Before',workspace:'/work',rootPaths:['/work','/other']};
 const manager=new WorkspaceIDEManager({root,resolve:()=>target,transport:{} as never});
 try{
  manager.configStore.save({...manager.configStore.config(),enabled:true,hosts:[{hostId:'local',enabled:true,binary:'code-server'}]});
  const entry=manager.entry('account','session')!,scope=manager.authorizationScope(entry.id),auth=new IDEAuthorization();
  const grant=auth.consume(auth.grant(entry.id,scope),entry.id,scope)!;
  if(change==='name')target={...target,projectName:'After'};else target={...target,rootPaths:['/other','/work']};
  assert.equal(manager.entry('account','session')?.id,entry.id);
  assert.notEqual(manager.authorizationScope(entry.id),scope);
  assert.equal(auth.authenticate(grant.token,entry.id,manager.authorizationScope(entry.id)),undefined);
 }finally{await manager.close();}
});

test('PROBE: origin pruning redirects a live older turn to a newer primary',t=>{
 const root=directory(t,'gateway-audit3-origin-'),file=path.join(root,'routing.json');
 const old={accountId:'a',sessionId:'old-session',recipientId:'old-group',hostId:'local',threadId:'thread'},next={...old,sessionId:'new-session',recipientId:'new-group'};
 const origins:any={};origins[JSON.stringify(['local','thread','old-live-turn'])]=old;
 for(let i=0;i<1999;i++)origins[JSON.stringify(['local','other-thread',String(i)])]={...old,threadId:'other-thread'};
 fs.writeFileSync(file,JSON.stringify({version:1,primary:{[JSON.stringify(['local','thread'])]:{destination:next,explicit:true}},origins}));
 const journal=new InteractionRoutingJournal(file);assert.equal(journal.resolve('local','thread',[old,next],'old-live-turn').destination?.recipientId,'old-group');
 journal.rememberTurn(next,'new-turn');
 assert.equal(journal.resolve('local','thread',[old,next],'old-live-turn').destination?.recipientId,'new-group');
});

test('PROBE: an older Web refresh overwrites the newer binding snapshot',async()=>{
 const all=fs.readFileSync(new URL('../../../src/web/app.js',import.meta.url),'utf8');
 const fn=all.slice(all.indexOf('async function refreshData('),all.indexOf('\nfunction renderAll(',all.indexOf('async function refreshData(')));
 const release=Promise.withResolvers<void>();let calls=0;
 const state:any={};const context:any={state,selectedSession:()=>undefined,isTaskboardEditing:()=>false,document:{querySelector:()=>({hidden:true})},window:{},bindingOverview:{render(){}},
  async api(url:string){const version=Math.floor(calls++/5)+1;if(version===1)await release.promise;const name=url.split('/').at(-1);return{[name!]:[{version}],version};},async loadTaskboardIssues(){},renderMetrics(){},renderAccounts(){},renderSessions(){},renderTaskboardStatus(){},renderTaskboardWorkbench(){},drawIcons(){},toast(){}};
 vm.createContext(context);vm.runInContext(fn,context);const first=context.refreshData(false);await context.refreshData(false);assert.equal(state.sessions[0].version,2);
 release.resolve();await first;assert.equal(state.sessions[0].version,1);
});

test('PROBE: distinct case-sensitive attachment paths are silently deduplicated',()=>{
 const result=parseActionBlocks('```codex-im-gateway-actions\n'+JSON.stringify({send:[{type:'file',path:'/work/Report.csv'},{type:'file',path:'/work/report.csv'}]})+'\n```');
 assert.equal(result.actions.send.length,1);
});

test('PROBE: synchronous WeCom receipt failure is swallowed by SDK without a Gateway error receipt',async()=>{
 class Client extends EventEmitter{connect(){}disconnect(){}async sendMessage(){}}
 const client=new Client(),adapter=new WeComChannelAdapter({botId:'bot',secret:'synthetic'} as never,{wsClient:client as never});const controller=new AbortController();
 let reports=0,sdkErrors=0;
 const monitor=adapter.monitor({signal:controller.signal,claimMessage(){throw Error('receipt disk failure');},async onMessage(){assert.fail('must not submit');},async onMessageError(){reports++;}});
 const handler=new MessageHandler({debug(){},info(){},warn(){},error(){sdkErrors++;}});
 try{handler.handleFrame({cmd:'aibot_msg_callback',body:{msgtype:'text',msgid:'m',from:{userid:'u'},text:{content:'hello'}}},client);assert.equal(sdkErrors,1);assert.equal(reports,0);}finally{controller.abort();await monitor;}
});

test('PROBE: an interrupted Web response loses submission uncertainty after receiving progress',async()=>{
 const all=fs.readFileSync(new URL('../../../src/web/app.js',import.meta.url),'utf8');
 const start=all.indexOf('async function streamApi('),fn=all.slice(start,all.indexOf('\nfunction emptyState(',start));
 let reads=0;const events:any[]=[];
 const context:any={state:{requestToken:'synthetic'},TextDecoder,Uint8Array,JSON,async fetch(){return{ok:true,headers:{get(){return'application/x-ndjson';}},body:{getReader(){return{async read(){if(reads++===0)return{value:new TextEncoder().encode('{"type":"progress","message":"working"}\\n'.replace('\\n','\n')),done:false};throw new TypeError('connection reset');}};}}};}};
 vm.createContext(context);vm.runInContext(fn,context);
 await assert.rejects(context.streamApi('/messages',{},(event:any)=>events.push(event)),(error:any)=>{assert.equal(error.submission,undefined);return true;});
 assert.equal(events.length,1);
 // sendSessionMessage restores the original draft for this undefined phase,
 // and the next submit generates a different requestId despite unknown receipt.
});


test('PROBE: custom Codex home selects its binary but daemon start inherits a different state directory',async t=>{
 const root=directory(t,'gateway-audit3-home-'),executable=path.join(root,'packages/standalone/current/codex'),output=path.join(root,'observed-home.json');
 fs.mkdirSync(path.dirname(executable),{recursive:true});
 fs.writeFileSync(executable,'#!'+process.execPath+'\n'+`require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({home:process.env.CODEX_HOME??null}));`);fs.chmodSync(executable,0o700);
 const transport=resolveLocalAppServerTransport({codexHome:root,mode:'daemon'})!;
 await transport.prepare!();assert.notEqual(JSON.parse(fs.readFileSync(output,'utf8')).home,root);
});

test('PROBE: a legitimate child directory beginning with two dots is rejected as a parent escape',()=>{
 assert.equal(isWorkspaceAllowed('/allowed/..cache',['/allowed']),false);
});


test('PROBE: Desktop review directives survive shared parsing and both DingTalk presentation routes',()=>{
 const directive='::code-comment{title="[P1] finding" body="Details with {} and escaped \\"quotes\\"" file="/work/Source.java" start=1 priority=1}';
 const visible=parseActionBlocks('Review result\n\n'+directive).visibleText;
 assert.ok(visible.includes('::code-comment{'));
 assert.ok(normalizeDingTalkCardContent(visible).includes('::code-comment{'));
 assert.ok(dingTalkPlainText(visible).includes('::code-comment{'));
});

test('PROBE: a failed login account refresh becomes permanently confirmed without an account result',async t=>{
 const root=directory(t,'gateway-audit3-login-'),paths=resolveStatePaths(root);let refreshes=0;
 const manager=new LoginManager({paths,accountManager:{async refreshAccount(){refreshes++;throw Error('isolated startup failure');}} as never,
  sessionFactory:async()=>({qrContent:'synthetic',expiresAt:new Date(Date.now()+60000).toISOString(),async poll(){return{status:'confirmed',account:{accountId:'one',userId:'actor',token:'synthetic',baseUrl:'https://example.invalid',enabled:true}};}}) as never,
  qrDataUrlFactory:async()=> 'synthetic'});
 const login=await manager.start();await assert.rejects(manager.poll(login.id),/isolated startup failure/);
 const result=await manager.poll(login.id);assert.equal(result.status,'confirmed');assert.equal(result.account,undefined);assert.equal(refreshes,1);
});
