import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { IDEConfigStore, type IDEConfig } from "../src/ide/config.js";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import { IDEEndpointManager } from "../src/ide/endpoint-manager.js";
import { IDEApprovalService } from "../src/ide/approval-service.js";
import { REMOTE_IDE_RELAY, REMOTE_IDE_SOCKET_PREPARE, type IDEIngressIO } from "../src/ide/remote-ingress.js";

const hostId = "remote-ssh-discovered:203.0.113.10";
const management = "http://127.0.0.1:18788";
async function freePort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function until(check: () => boolean) { for (let i = 0; i < 250; i++) { if (check()) return; await delay(10); } assert.fail("fixture state timeout"); }
function remoteRequest(origin: string, ca: Buffer, route: string, options: { method?: string; headers?: Record<string,string>; body?: string } = {}) {
  const url = new URL(origin);
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port: url.port, path: route, ca, agent: false, method: options.method,
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(url.hostname, cert),
      headers: { Host: url.host, ...options.headers } }, res => {
      let body = ""; res.on("data", chunk => body += chunk); res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    }); req.on("error", reject); req.end(options.body);
  });
}
function fixtureRoot(t: test.TestContext) { const root = fs.mkdtempSync(path.join("/private/tmp", "cig-endpoints-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test("per-host routing validates loopback local origin and explicit unique fixed remote origins", t => {
  const store = new IDEConfigStore(fixtureRoot(t));
  const base = { ...store.config(), enabled: true, routing: "per-host", hosts: [
    { hostId: "local", enabled: true, binary: "code-server" },
    { hostId, enabled: true, binary: "code-server", access: { publicOrigin: "https://203.0.113.10:20015", bindAddress: "192.168.5.3", port: 80 } }
  ] };
  const saved = store.save(base); assert.equal(saved.hosts[1].access?.port, 80);
  assert.throws(() => store.save({ ...base, publicOrigin: "https://30.1.2.3:8790" }));
  for (const origin of ["http://203.0.113.10", "https://127.0.0.2", "https://user:pass@203.0.113.10", "https://203.0.113.10/workspace/x"])
    assert.throws(() => store.save({ ...base, hosts: [{ ...base.hosts[1], access: { ...base.hosts[1].access, publicOrigin: origin } }] }));
  assert.throws(() => store.save({ ...base, hosts: [{ ...base.hosts[1], access: { ...base.hosts[1].access, bindAddress: "0.0.0.0" } }] }));
  assert.throws(() => store.save({ ...base, hosts: [base.hosts[1], { ...base.hosts[1], hostId: "other" }] }));
  assert.throws(() => store.save({ ...base, routing: undefined }));
  assert.equal(store.save({ ...base, sharedIngressHostId: hostId }).sharedIngressHostId, hostId);
  for (const sharedIngressHostId of ["local", "missing"])
    assert.throws(() => store.save({ ...base, sharedIngressHostId }));
  assert.throws(() => store.save({ ...base, sharedIngressHostId: hostId, hosts: [{ ...base.hosts[1], enabled: false }] }));
  assert.throws(() => store.save({ ...base, sharedIngressHostId: hostId, hosts: [{ ...base.hosts[1], access: undefined }] }));
  assert.throws(() => store.save({ ...base, routing: undefined, hosts: [], sharedIngressHostId: hostId }));
});

for (const shared of [false, true]) test(`${shared ? "shared" : "host"} entrances isolate scopes, keep native auth, and reconnect without changing grants, project instances or stable links`, async t => {
  const root = fixtureRoot(t), port = await freePort(), externalPort = await freePort();
  const origin = `https://203.0.113.10:${externalPort}`, local = `http://127.0.0.1:${port}`;
  let launches = 0, stops = 0, attempts = 0, disconnect!: () => Promise<void>;
  const launchedHosts: string[] = [];
  const manager = new WorkspaceIDEManager({ root,
    resolve: (_account, sessionId) => ({ owner: "owner", sessionId, hostId: sessionId === "local" ? "local" : hostId, workspace: root, projectName: "fixture" }),
    transport: { canonicalDirectory: async () => root, launch: async input => {
      launches++; launchedHosts.push(input.hostId); const socketPath = path.join(root, input.id + ".sock");
      const sockets = new Set<net.Socket>();
      const server = http.createServer((req,res) => res.end(req.url === "/healthz" ? "ok" : JSON.stringify({ headers: req.headers })));
      server.on("connection", s => { sockets.add(s); s.on("close",()=>sockets.delete(s)); });
      server.on("upgrade", (_req,socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      return { socketPath, alive: () => server.listening, stop: async () => { stops++; for(const s of sockets)s.destroy(); await new Promise<void>(resolve=>server.close(()=>resolve())); } };
    } }
  });
  manager.configStore.save({ ...manager.config(), enabled: true, routing: "per-host", ...(shared ? { sharedIngressHostId: hostId } : {}), port, publicOrigin: local, hosts: [
    { hostId: "local", enabled: true, binary: "code-server" }, { hostId, enabled: true, binary: "code-server", access: { publicOrigin: origin, bindAddress: "192.168.5.3", port: 80 } }
  ] });
  const io: IDEIngressIO = {
    connect: async input => {
      attempts++; const sockets = new Set<net.Socket>();
      const server = net.createServer(client => {
        const upstream = net.connect(input.localPort, "127.0.0.1"); sockets.add(client); sockets.add(upstream);
        client.on("error",()=>upstream.destroy()); upstream.on("error",()=>client.destroy());
        client.on("close",()=>{sockets.delete(client);upstream.destroy();}); upstream.on("close",()=>{sockets.delete(upstream);client.destroy();});
        client.pipe(upstream).pipe(client);
      });
      await new Promise<void>(resolve=>server.listen(externalPort,"127.0.0.1",resolve));
      let finish!:()=>void; const closed = new Promise<void>(resolve=>finish=resolve);
      let closing: Promise<void> | undefined;
      const close = () => closing ??= (async()=>{for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));finish();})();
      disconnect=close; return {closed,close};
    },
    probe: async input => { assert.equal((await remoteRequest(origin,input.ca,"/")).status,200); }
  };
  let access = new IDEEndpointManager(manager, { ingressIO: io, ingressTiming: { retryMs: 5, probeMs: 100 } });
  t.after(()=>access.close());
  access.setManagementOrigin(management); await access.reload(false);
  await until(()=>access.statuses().some(s=>s.hostId===hostId&&s.state==="ready"));
  const ca=access.tls.caCertificate(), localEntry=manager.entry("account","local")!, remoteEntry=manager.entry("account","remote")!;
  assert.equal(new URL(localEntry.url).origin,shared ? origin : local); assert.equal(new URL(remoteEntry.url).origin,origin);
  assert.equal((await fetch(local+"/workspace/"+remoteEntry.id)).status,404);
  assert.equal((await remoteRequest(origin,ca,"/workspace/"+localEntry.id)).status,shared ? 200 : 404);
  assert.equal((await remoteRequest(origin,ca,"/api/bootstrap")).status,401);
  assert.match((await remoteRequest(origin,ca,"/workspace/"+remoteEntry.id)).body,/等待 Gateway 授权/);
  const grant=await access.grant(remoteEntry.id,true); assert.equal(new URL(grant.action).origin,origin);
  const body=new URLSearchParams({token:grant.token,entryId:remoteEntry.id}).toString();
  assert.equal((await fetch(local+"/authorize",{method:"POST",headers:{Origin:management},body})).status,404,"grant cannot be consumed on a foreign host entrance");
  const login=await remoteRequest(origin,ca,"/authorize",{method:"POST",headers:{Origin:management},body});
  assert.equal(login.status,303); assert.match(login.headers["set-cookie"]![0],/Secure/);
  const cookie=login.headers["set-cookie"]![0].split(";")[0];
  const landing=await remoteRequest(origin,ca,"/workspace/"+remoteEntry.id,{headers:{Cookie:cookie}});
  const csrf=/name="csrf" value="([^"]+)"/.exec(landing.body)![1];
  const opened=await remoteRequest(origin,ca,"/open/"+remoteEntry.id,{method:"POST",headers:{Cookie:cookie,Origin:origin},body:new URLSearchParams({csrf}).toString()});
  assert.equal(opened.status,303); assert.equal(launches,1);
  const authFile=fs.readdirSync(path.join(root,"ide")).find(x=>x.startsWith("authorization-")&&JSON.parse(fs.readFileSync(path.join(root,"ide",x),"utf8")).audience===origin)!;
  const before=fs.readFileSync(path.join(root,"ide",authFile));
  const configBefore=fs.readFileSync(manager.configStore.filePath);
  const websocket=await new Promise<net.Socket>((resolve,reject)=>{
    const u=new URL(origin), req=https.request({host:"127.0.0.1",port:externalPort,path:`/ide/${remoteEntry.id}/socket`,ca,agent:false,
      checkServerIdentity:(_host,cert)=>tls.checkServerIdentity(u.hostname,cert),headers:{Host:u.host,Origin:origin,Cookie:cookie,Connection:"Upgrade",Upgrade:"websocket"}});
    req.on("upgrade",(_res,socket)=>resolve(socket));req.on("error",reject);req.end();
  });
  const wsClosed=new Promise<void>(resolve=>websocket.once("close",()=>resolve()));websocket.resume();
  await disconnect(); await wsClosed;
  await until(()=>attempts>=2&&access.statuses().some(s=>s.hostId===hostId&&s.state==="ready"));
  assert.equal(launches,1); assert.equal(stops,0); assert.deepEqual(fs.readFileSync(path.join(root,"ide",authFile)),before);
  assert.deepEqual(fs.readFileSync(manager.configStore.filePath),configBefore); assert.equal(manager.entry("account","remote")!.url,remoteEntry.url);
  assert.equal((await remoteRequest(origin,ca,"/workspace/"+remoteEntry.id,{headers:{Cookie:cookie}})).status,303);
  await access.close(); access=new IDEEndpointManager(manager,{ingressIO:io,ingressTiming:{retryMs:5,probeMs:100}}); access.setManagementOrigin(management); await access.reload(false);
  await until(()=>access.statuses().some(s=>s.hostId===hostId&&s.state==="ready"));
  assert.match((await remoteRequest(origin,ca,"/workspace/"+remoteEntry.id,{headers:{Cookie:cookie}})).body,/打开 Web IDE/);
  if (!shared) {
    const oldLocalId=localEntry.id;
    manager.configStore.save({...manager.config(),sharedIngressHostId:hostId});
    await access.reload(false);
    await until(()=>access.statuses().some(s=>s.hostId===hostId&&s.state==="ready"));
    assert.equal(manager.entry("account","local")!.id,oldLocalId);
    assert.equal(new URL(manager.entry("account","local")!.url).origin,origin);
    assert.equal(manager.entry("account","remote")!.url,remoteEntry.url);
    assert.deepEqual(fs.readFileSync(path.join(root,"ide",authFile)),before,"enabling shared publication does not rewrite existing remote browser grants");
    assert.match((await remoteRequest(origin,ca,"/workspace/"+remoteEntry.id,{headers:{Cookie:cookie}})).body,/打开 Web IDE/);
  }
  if (shared) {
    assert.equal(access.statuses().find(s => s.hostId === hostId)?.shared, true);
    const waiting = await remoteRequest(origin,ca,"/workspace/"+localEntry.id);
    assert.doesNotMatch(waiting.body,/127\.0\.0\.1|打开本机 Gateway 管理页/);
    const code = /<textarea[^>]*>(\d{6})<\/textarea>/.exec(waiting.body)![1];
    const request = access.pendingAccess().find(r => r.code === code && r.entryId === localEntry.id)!;
    assert.equal(request.hostId,"local"); assert.equal(request.accountId,"account");
    const approval=new IDEApprovalService({root,accounts:()=>[{accountId:"account",channel:"dingtalk",providerId:"fixture"}]});
    const owner={accountId:"account",channel:"dingtalk" as const,providerId:"fixture",actorId:"fixture-owner"};
    approval.setOwner(owner);approval.attach(access);access.setApprovalCopies(approval);
    const preview=approval.preview(owner,code),panelPath=`/approval/${preview.token}`;
    assert.equal(new URL(preview.request.url!).origin,origin);
    const panel=await remoteRequest(origin,ca,panelPath);assert.equal(panel.status,200);assert.match(panel.body,/二次确认/);
    assert.equal(panel.headers["set-cookie"],undefined);
    assert.equal((await fetch(local+panelPath)).status,410,"a valid panel cannot leak across entrance audiences");
    assert.equal((await remoteRequest(origin,ca,panelPath,{method:"POST",headers:{Origin:origin},body:"trust"})).status,405);
    const pairCookie = waiting.headers["set-cookie"]![0].split(";")[0];
    const localWaiting = await fetch(local+"/workspace/"+localEntry.id);
    const localCode = /<textarea[^>]*>(\d{6})<\/textarea>/.exec(await localWaiting.text())![1];
    const localRequest = access.pendingAccess().find(r => r.code === localCode && r.entryId === localEntry.id)!;
    await assert.rejects(access.approveAccess(request.id,remoteEntry.id,true));
    await access.approveAccess(request.id,localEntry.id,true);
    assert.match(await (await fetch(local+"/workspace/"+localEntry.id,{headers:{Cookie:localWaiting.headers.get("set-cookie")!.split(";")[0]}})).text(),/等待 Gateway 授权/);
    const localPending = access.pendingAccess().find(r=>r.id===localRequest.id)!;
    assert.equal(localPending.approved,false,"shared approval cannot approve a loopback browser request");
    const stranger = await remoteRequest(origin,ca,"/workspace/"+localEntry.id);
    assert.match(stranger.body,/等待 Gateway 授权/,"project URL alone never authenticates another browser");
    const accepted = await remoteRequest(origin,ca,"/workspace/"+localEntry.id,{headers:{Cookie:pairCookie}});
    assert.equal(accepted.status,303);
    const localProjectCookie=accepted.headers["set-cookie"]![0].split(";")[0];
    const localLanding=await remoteRequest(origin,ca,"/workspace/"+localEntry.id,{headers:{Cookie:localProjectCookie}});
    assert.match(localLanding.body,/打开 Web IDE/);
    const localCsrf=/name="csrf" value="([^"]+)"/.exec(localLanding.body)![1];
    assert.equal((await remoteRequest(origin,ca,"/open/"+localEntry.id,{method:"POST",headers:{Cookie:localProjectCookie,Origin:local},body:new URLSearchParams({csrf:localCsrf}).toString()})).status,403);
    assert.equal((await remoteRequest(origin,ca,"/open/"+localEntry.id,{method:"POST",headers:{Cookie:localProjectCookie,Origin:origin},body:"csrf=wrong"})).status,403);
    const localOpened=await remoteRequest(origin,ca,"/open/"+localEntry.id,{method:"POST",headers:{Cookie:localProjectCookie,Origin:origin},body:new URLSearchParams({csrf:localCsrf}).toString()});
    assert.equal(localOpened.status,303); assert.deepEqual(launchedHosts,[hostId,"local"]);
    const localSocket=await new Promise<net.Socket>((resolve,reject)=>{
      const u=new URL(origin), req=https.request({host:"127.0.0.1",port:externalPort,path:`/ide/${localEntry.id}/socket`,ca,agent:false,
        checkServerIdentity:(_host,cert)=>tls.checkServerIdentity(u.hostname,cert),headers:{Host:u.host,Origin:origin,Cookie:localProjectCookie,Connection:"Upgrade",Upgrade:"websocket"}});
      req.on("upgrade",(_res,socket)=>resolve(socket));req.on("error",reject);req.end();
    });
    localSocket.destroy();
    assert.match((await remoteRequest(origin,ca,"/workspace/"+remoteEntry.id,{headers:{Cookie:localProjectCookie}})).body,/等待 Gateway 授权/,"local project grant cannot access remote project");
    await access.approveAccess(localRequest.id,localEntry.id,false);
    const localAccepted=await fetch(local+"/workspace/"+localEntry.id,{redirect:"manual",headers:{Cookie:localWaiting.headers.get("set-cookie")!.split(";")[0]}});
    assert.equal(localAccepted.status,303,"loopback maintenance approval still targets its own request");
    access.rejectAccess(access.pendingAccess().find(r=>r.entryId===localEntry.id&&!r.approved)!.id,localEntry.id);
    const beforeDisable=manager.config();
    manager.configStore.save({...beforeDisable,hosts:beforeDisable.hosts.map(h=>h.hostId==="local"?{...h,enabled:false}:h)});
    assert.equal(manager.entry("account","local"),undefined);
    assert.equal((await remoteRequest(origin,ca,"/workspace/"+localEntry.id)).status,404,"disabled project host is rejected even before reload");
    await assert.rejects(access.grant(localEntry.id,true));
    manager.configStore.save(beforeDisable);
  }
  access.revoke(); assert.match((await remoteRequest(origin,ca,"/workspace/"+remoteEntry.id,{headers:{Cookie:cookie}})).body,/等待 Gateway 授权/);
});

for (const shared of [false,true]) test(`an unavailable ${shared ? "shared" : "remote"} ingress does not block loopback maintenance or shutdown; no link fallback`,async t=>{
  const root=fixtureRoot(t),port=await freePort();let attempts=0;
  const manager=new WorkspaceIDEManager({root,resolve:(_account,s)=>({owner:"owner",sessionId:s,hostId:s==="local"?"local":hostId,workspace:root,projectName:"fixture"})});
  manager.configStore.save({...manager.config(),enabled:true,routing:"per-host",...(shared?{sharedIngressHostId:hostId}:{}),port,publicOrigin:`http://127.0.0.1:${port}`,hosts:[{hostId:"local",enabled:true,binary:"code-server"},{hostId,enabled:true,binary:"code-server",access:{publicOrigin:"https://203.0.113.10:20015",bindAddress:"192.168.5.3",port:80}}]});
  const knownLocalEntry=manager.entry("account","local")!;
  const access=new IDEEndpointManager(manager,{ingressIO:{connect:async()=>{attempts++;throw Error("fixture offline");},probe:async()=>{}},ingressTiming:{retryMs:5,probeMs:20}});
  t.after(()=>access.close());await access.reload(false);await until(()=>attempts>=2);
  assert.equal(Boolean(manager.entry("account","local")),!shared);assert.equal(manager.entry("account","remote"),undefined);
  assert.equal((await fetch(`http://127.0.0.1:${port}/workspace/${knownLocalEntry.id}`)).status,200);
  await access.close();const stopped=attempts;await delay(30);assert.equal(attempts,stopped);
});

test("remote relay transfers opaque bytes, binds an exact address, and exits with its SSH owner",async t=>{
  const root=fixtureRoot(t),socketPath=path.join(root,"private.sock"),port=await freePort();
  const upstream=net.createServer(s=>s.on("data",b=>s.write(b)));
  await new Promise<void>(resolve=>upstream.listen(socketPath,resolve));fs.chmodSync(socketPath,0o600);
  t.after(()=>new Promise<void>(resolve=>upstream.close(()=>resolve())));
  const input=Buffer.from(JSON.stringify({socketPath,bindAddress:"127.0.0.1",port})).toString("base64");
  const child=spawn(process.execPath,["-e",REMOTE_IDE_RELAY,input],{stdio:["pipe","pipe","pipe"]});
  t.after(()=>{child.stdin.end();child.kill("SIGTERM");});
  let out="";child.stdout.on("data",b=>out+=b);await until(()=>out.includes('"ready":true'));
  const payload=Buffer.from([22,3,1,0,5,0,255,128,10,13]);
  const echoed=await new Promise<Buffer>((resolve,reject)=>{const socket=net.connect(port,"127.0.0.1",()=>socket.write(payload));socket.on("data",b=>{socket.destroy();resolve(b);});socket.on("error",reject);});
  assert.deepEqual(echoed,payload);const closed=new Promise<void>(resolve=>child.once("exit",()=>resolve()));child.stdin.end();await closed;
  await assert.rejects(new Promise<void>((resolve,reject)=>{const s=net.connect(port,"127.0.0.1",()=>{s.destroy();resolve();});s.on("error",reject);}));
});

test("remote reverse socket recovery prunes only owned stale socket inodes, never active listeners, files or symlinks",async t=>{
  const root=fs.mkdtempSync("/private/tmp/i-");t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id="a".repeat(24),directory=path.join(root,".local/share/codex-im-gateway/ingress",id),socketPath=path.join(directory,"relay.sock");
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const input=Buffer.from(JSON.stringify({id})).toString("base64");
  const helper=`require("node:os").homedir=()=>${JSON.stringify(root)};\n${REMOTE_IDE_SOCKET_PREPARE}`;
  const prepare=()=>spawnSync(process.execPath,["-e",helper,input],{encoding:"utf8",timeout:3000});
  const server=net.createServer();await new Promise<void>(resolve=>server.listen(socketPath,resolve));fs.chmodSync(socketPath,0o600);
  assert.equal(prepare().status,1,"a live listener must not be stolen");assert.ok(fs.lstatSync(socketPath).isSocket());
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  const child=spawn(process.execPath,["-e",`require("node:net").createServer().listen(${JSON.stringify(socketPath)},()=>console.log("ready"));`],{stdio:["ignore","pipe","ignore"]});
  t.after(()=>child.kill("SIGTERM"));let ready="";child.stdout.on("data",b=>ready+=b);await until(()=>ready.includes("ready"));fs.chmodSync(socketPath,0o600);
  const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));child.kill("SIGKILL");await exited;
  assert.ok(fs.lstatSync(socketPath).isSocket());assert.equal(prepare().status,0);assert.equal(fs.existsSync(socketPath),false);
  fs.writeFileSync(socketPath,"owner data");assert.equal(prepare().status,1);assert.equal(fs.readFileSync(socketPath,"utf8"),"owner data");
  fs.unlinkSync(socketPath);fs.symlinkSync(path.join(root,"missing"),socketPath);assert.equal(prepare().status,1);assert.ok(fs.lstatSync(socketPath).isSymbolicLink());
});
