import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, loadConfig, saveConfig, MAX_INBOUND_BYTES } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { resolveChannelModeSettings } from "../src/server/channel-mode-settings.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

test("malformed persisted operational and access fields fail closed without rewriting the source", t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-intent-config-")), paths=resolveStatePaths(root);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const invalid of [{allowedSenderIds:"alice"},{allowedSenderIds:[123]},{allowedWorkspaces:"/tmp"},
    {defaultCwd:null},{codexBin:[]},{maxBufferItems:-1},{maxBufferItems:1.1},{promptBufferTtlMs:"60000"},{model:{bad:true}}]) {
    const original=JSON.stringify(invalid);fs.writeFileSync(paths.configPath,original);
    assert.throws(()=>loadConfig(paths),/Invalid configuration/);
    assert.equal(fs.readFileSync(paths.configPath,"utf8"),original);
  }
});

test("fractional sub-byte inbound limits never normalize to zero", t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-intent-inbound-")), paths=resolveStatePaths(root);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  saveConfig(paths,{...defaultConfig(root),maxInboundBytes:0.5});
  assert.equal(JSON.parse(fs.readFileSync(paths.configPath,"utf8")).maxInboundBytes,MAX_INBOUND_BYTES);
  assert.equal(loadConfig(paths).maxInboundBytes,MAX_INBOUND_BYTES);
  fs.writeFileSync(paths.configPath,JSON.stringify({maxInboundBytes:0.5}));
  assert.equal(loadConfig(paths).maxInboundBytes,MAX_INBOUND_BYTES);
});

test("HTTP settings reject unsupported managed IPv6 before applying configuration", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-intent-ipv6-")), paths=resolveStatePaths(root);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  saveConfig(paths,defaultConfig(root));let applied:string|undefined;
  const server=await startLocalHttpServer({paths,port:0,onTaskboardConfig:async c=>{applied=c.taskboardUrl;},accountManager:{
    async reconfigureRuntime(commit:()=>Promise<unknown>){await commit();},async getCodexRuntimeInfo(){return{};},async getCodexModels(){return[];}
  } as never});t.after(()=>server.close());
  const response=await fetch(`${server.url}/api/config`,{method:"PUT",headers:{Origin:server.url,"X-Codex-Im-Gateway-Token":server.requestToken,"Content-Type":"application/json"},body:JSON.stringify({...defaultConfig(root),taskboardUrl:"http://[::1]:47823"})});
  assert.equal(response.status,400,await response.text());assert.equal(applied,undefined);
  assert.equal(loadConfig(paths).taskboardUrl,defaultConfig(root).taskboardUrl);
  fs.writeFileSync(paths.configPath,JSON.stringify({taskboardUrl:"http://[::1]:47823"}));
  assert.throws(()=>loadConfig(paths),/IPv4 loopback/);
});

test("remote projects cannot become local directory-backed QA defaults", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-intent-remote-kb-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new RuntimeStateStore(resolveStatePaths(root));const project=store.createProject("Remote",root,{hostId:"remote-host"});let inspections=0;
  await assert.rejects(resolveChannelModeSettings({store,llmWiki:{async inspect(){inspections++;return{} as never;}},settings:{defaultMode:"qa",enabledModes:["qa"],qaKnowledgeBase:{kind:"project",projectId:project.id}}}),/remote|远程/);
  assert.equal(inspections,0);assert.equal(store.listKnowledgeBases().length,0);
});

test("Taskboard enable rolls back the owned service if configuration persistence fails",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-intent-taskboard-commit-")),paths=resolveStatePaths(root);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));saveConfig(paths,{...defaultConfig(root),taskboardEnabled:false});
  const changes:boolean[]=[];const original=fs.renameSync;let fail=true;
  t.mock.method(fs,"renameSync",function(from:fs.PathLike,to:fs.PathLike){if(String(to)===paths.configPath&&fail){fail=false;throw Object.assign(Error("disk full"),{code:"ENOSPC"});}return original(from,to);});
  const server=await startLocalHttpServer({paths,port:0,onTaskboardConfig:async c=>{changes.push(c.taskboardEnabled);},accountManager:{async getTaskboardStatus(){return{};}} as never});t.after(()=>server.close());
  const response=await fetch(`${server.url}/api/taskboard/start`,{method:"POST",headers:{Origin:server.url,"X-Codex-Im-Gateway-Token":server.requestToken,"Content-Type":"application/json"},body:"{}"});
  assert.equal(response.status,500);assert.deepEqual(changes,[true,false]);assert.equal(loadConfig(paths).taskboardEnabled,false);
});
