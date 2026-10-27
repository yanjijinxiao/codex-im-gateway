import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {AccountManager} from "../../../src/server/account-manager.ts";
import {resolveStatePaths} from "../../../src/state/paths.ts";
import {defaultConfig} from "../../../src/state/config.ts";
import {saveAccount} from "../../../src/weixin/accounts.ts";
import {createChannelClient,TEXT_CAPABILITIES} from "../../../src/channels/client.ts";

function fixture(t:any,connected=true){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-audit2-lifecycle-")),paths=resolveStatePaths(root);
 saveAccount(paths,{accountId:"one",userId:"actor",token:"synthetic",baseUrl:"https://example.invalid",enabled:false});
 let signal:AbortSignal|undefined,closes=0;
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const runner={backendInfo(){return{id:"app-server",capabilities:{nativeQueue:true}};},async warmUp(){},async listProjects(){return{backend:"app-server",projects:[]};},
  async inspectThread(threadId:string){return{threadId,persistence:"active",runtimeStatus:"idle",activeFlags:[]};},
  async resumeAfterCapacity(input:any){input.assertCurrent();await input.onTurnStarted({threadId:"native",turnId:"recovery"});entered.resolve();await release.promise;return{threadId:"native",turnId:"recovery",text:"done",raw:""};},
  close(){closes++;}};
 const manager=new AccountManager({paths,configProvider:()=>({...defaultConfig(root),taskboardEnabled:false}),runnerFactory:()=>runner as never,
  adapterFactory:()=>({client:createChannelClient("generic",TEXT_CAPABILITIES,{async sendText(){return{messageId:"sent"};}}),
   async monitor(options:any){signal=options.signal;options.onStatus?.({state:connected?"connected":"connecting"});await new Promise<void>(resolve=>options.signal.addEventListener("abort",()=>resolve(),{once:true}));}}),
  bridgeFactory:()=>({hasInFlightWork(){return false;},suspendUserInputs(){}} as never),
  codexSessionMonitorFactory:()=>({start(){},async stop(){}} as never),codexDesktopRequestMonitorFactory:()=>({start(){},stop(){},setFollowedThreads(){}} as never)});
 t.after(async()=>{release.resolve();await manager.stopAccount("one",false);await manager.stopAll();fs.rmSync(root,{recursive:true,force:true});});
 return{manager,root,runner,entered,release,get signal(){return signal;},get closes(){return closes;}};
}

test("PROBE: global stop skips a starting account and leaves its monitor alive",{timeout:3000},async t=>{
 const f=fixture(t,false);await f.manager.startAccount("one",false);assert.equal(f.signal?.aborted,false);
 await f.manager.stopAll();assert.equal(f.signal?.aborted,false);
 assert.equal((f.manager as any).entries.get("one").status,"starting");
});

test("PROBE: configuration barrier closes the native runner during automatic capacity recovery",{timeout:4000},async t=>{
 const f=fixture(t),s=f.manager.createSession("one","chat",f.root,"Recovery");const store=(f.manager as any).storeFor("one");
 store.setSessionThread(s.id,"native");await f.manager.startAccount("one",false);
 const recovery=(f.manager as any).capacityRecovery;recovery.delays=[1];
 assert.equal(recovery.offer({hostId:"local",threadId:"native",turnId:"failed"}),true);
 await f.entered.promise;assert.equal(f.closes,0);
 let commits=0;await f.manager.reconfigureRuntime(async()=>{commits++;});
 assert.equal(commits,1);assert.equal(f.closes,1);
 f.release.resolve();
});
