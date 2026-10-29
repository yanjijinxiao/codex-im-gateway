import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { AccountManager } from "../src/server/account-manager.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";

test("optional Codex discovery cannot block bootstrap or committed settings, and a hung probe is coalesced",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-optional-metadata-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const paths=resolveStatePaths(root),config={...defaultConfig(root),taskboardEnabled:false};saveConfig(paths,config);
  const manager=new AccountManager({paths});t.after(()=>manager.stopAll());
  const gate=Promise.withResolvers<void>();let probes=0;
  const server=await startLocalHttpServer({paths,port:0,accountManager:manager,metadataTimeoutMs:20,
    codexCheck:async()=>({ready:true}),codexRuntimeCheck:async()=>{probes++;await gate.promise;return {model:"native-model"};},
    codexModelsCheck:async()=>{probes++;await gate.promise;return [];}});
  t.after(()=>server.close());
  const first=fetch(`${server.url}/api/bootstrap`);
  let timer:NodeJS.Timeout|undefined;
  try{
    // Prove completion while the native probe gate is still closed. A fixed
    // 150ms sleep measured machine scheduling under full-suite load instead.
    const response=await Promise.race([first,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(Error("bootstrap waited on optional native discovery")),3000);
    })]);
    clearTimeout(timer);
    assert.equal(response.status,200,"core bootstrap must finish while optional native discovery is still hung");
    assert.equal((await response.json()).requestToken,server.requestToken);
    const second=await fetch(`${server.url}/api/bootstrap`);assert.equal(second.status,200);await second.json();
    assert.equal(probes,2,"timeouts do not launch duplicate background probes");
    const saved=await fetch(`${server.url}/api/config`,{method:"PUT",headers:{Origin:server.url,"Content-Type":"application/json","X-Codex-Im-Gateway-Token":server.requestToken},body:JSON.stringify(config)});
    assert.equal(saved.status,200,await saved.clone().text());await saved.json();
    assert.equal(loadConfig(paths).taskboardEnabled,false);
  }finally{clearTimeout(timer);gate.resolve();await first;}
});

test("Taskboard enable and full settings serialize one coherent persisted configuration",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-config-serialization-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const paths=resolveStatePaths(root),config={...defaultConfig(root),taskboardEnabled:false};saveConfig(paths,config);
  const manager=new AccountManager({paths});t.after(()=>manager.stopAll());
  t.mock.method(manager,"getTaskboardStatus",async()=>({enabled:loadConfig(paths).taskboardEnabled,available:false}));
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let active=0,maxActive=0;const flags:boolean[]=[];
  const server=await startLocalHttpServer({paths,port:0,accountManager:manager,codexCheck:async()=>({ready:true}),codexRuntimeCheck:async()=>({}),codexModelsCheck:async()=>[],
    onTaskboardConfig:async next=>{maxActive=Math.max(maxActive,++active);flags.push(next.taskboardEnabled);try{if(flags.length===1){entered.resolve();await gate.promise;}}finally{active--;}}});
  t.after(()=>server.close());
  const send=(url:string,method:string,body:unknown)=>fetch(`${server.url}${url}`,{method,headers:{Origin:server.url,"Content-Type":"application/json","X-Codex-Im-Gateway-Token":server.requestToken},body:JSON.stringify(body)});
  const enable=send("/api/taskboard/start","POST",{});await entered.promise;
  const save=send("/api/config","PUT",{...config,model:"new-model"});
  try{await new Promise(resolve=>setTimeout(resolve,30));assert.equal(maxActive,1);}
  finally{gate.resolve();await Promise.all([enable,save]);}
  const results=await Promise.all([enable,save]);for(const response of results)assert.equal(response.status,200,await response.text());
  assert.deepEqual(flags,[true,false]);assert.equal(loadConfig(paths).taskboardEnabled,false);assert.equal(loadConfig(paths).model,"new-model");
});
