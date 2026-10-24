import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IDETLSManager, loadIDETLS } from "../src/ide/tls.js";
import { IDEConfigStore } from "../src/ide/config.js";
import { IDEAccessServer } from "../src/ide/access-server.js";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { resolveStatePaths } from "../src/state/paths.js";

function temporary(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-tls-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
async function freePort(): Promise<number> {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function request(url: string, ca?: Buffer, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; fingerprint?: string }>((resolve, reject) => {
    const req = https.request(url, { ca, agent: false, method: options.method, headers: options.headers }, response => {
      let body = ""; response.on("data", value => body += value);
      const fingerprint = (response.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256;
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body, fingerprint }));
    }); req.on("error", reject); req.end(options.body);
  });
}
test("self-signed CA and native IP certificate persist, renew atomically with the same CA, and enforce key permissions", async t => {
  const root = temporary(t), manager = new IDETLSManager(path.join(root, "tls"));
  const [files, duplicate] = await Promise.all([manager.prepare("127.0.0.1"), manager.prepare("127.0.0.1")]);
  assert.deepEqual(files, duplicate); const ca = manager.caCertificate(), cert = fs.readFileSync(files.certFile), key = fs.readFileSync(files.keyFile);
  assert.equal(new crypto.X509Certificate(cert).checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(fs.statSync(files.keyFile).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(files.keyFile)).mode & 0o777, 0o700);
  loadIDETLS(files, "https://127.0.0.1:8790");
  assert.throws(() => loadIDETLS(files, "https://127.0.0.2:8790"), /不匹配/);
  const restored = new IDETLSManager(manager.root); await restored.prepare("127.0.0.1");
  assert.deepEqual(fs.readFileSync(files.certFile), cert); assert.deepEqual(restored.caCertificate(), ca);
  await restored.prepare("127.0.0.1", true);
  assert.notDeepEqual(fs.readFileSync(files.certFile), cert); assert.deepEqual(restored.caCertificate(), ca); assert.deepEqual(fs.readFileSync(files.keyFile), key);
  fs.chmodSync(files.keyFile, 0o644); assert.throws(() => loadIDETLS(files, "https://127.0.0.1:8790"), /仅该用户可读/);
  fs.chmodSync(files.keyFile, 0o600);
  const wrong = new IDETLSManager(path.join(root, "other")), otherFiles = await wrong.prepare("127.0.0.1");
  assert.throws(() => loadIDETLS({ ...files, keyFile: otherFiles.keyFile }, "https://127.0.0.1:8790"), /私钥不匹配/);
  assert.throws(() => manager.prepare("0.0.0.0")); assert.throws(() => manager.prepare("127.0.0.1\nsubjectAltName=DNS:evil"));
  const copy = path.join(root, "private-copy.key"); fs.copyFileSync(files.keyFile, copy); fs.unlinkSync(files.keyFile); fs.symlinkSync(copy, files.keyFile);
  assert.throws(() => loadIDETLS(files, "https://127.0.0.1:8790"), /ELOOP|symbolic/i);
  fs.writeFileSync(wrong.caFile(), "corrupt CA record");
  await assert.rejects(wrong.prepare("127.0.0.1")); assert.equal(fs.readFileSync(wrong.caFile(), "utf8"), "corrupt CA record");
});
test("TLS configuration rejects wildcard binds, HTTP, mismatched ports and relative key paths", t => {
  const store = new IDEConfigStore(temporary(t)), defaults = { ...store.config(), publicOrigin: "https://127.0.0.1:8790" };
  const files = { bindAddress: "127.0.0.1", certFile: "/cert.crt", keyFile: "/key.pem" };
  store.save({ ...defaults, tls: files });
  for (const bindAddress of ["0.0.0.0", "::", "arbitrary.example.com"]) assert.throws(() => store.save({ ...defaults, tls: { ...files, bindAddress } }));
  assert.throws(() => store.save({ ...defaults, tls: { ...files, keyFile: "relative.key" } }));
  assert.throws(() => store.save({ ...defaults, publicOrigin: "http://127.0.0.1:8790", tls: files }));
  assert.throws(() => store.save({ ...defaults, publicOrigin: "https://127.0.0.1:8791", tls: files }));
});
test("HTTPS retains native authorization, Secure cookies, WSS scopes and persistent grants across restart and certificate renewal", async t => {
  const root = temporary(t), upstreams: http.Server[] = [], upstreamSockets: net.Socket[] = [];
  const manager = new WorkspaceIDEManager({ root, resolve: () => ({ owner: "owner", sessionId: "session", hostId: "local", workspace: root, projectName: "fixture" }),
    transport: { canonicalDirectory: async () => root, launch: async () => {
      const socketPath = path.join(root, "upstream.sock"), server = http.createServer((req, res) => res.end(JSON.stringify({ headers: req.headers })));
      upstreams.push(server); server.on("connection", socket => { upstreamSockets.push(socket); });
      server.on("upgrade", (_req, socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      return { socketPath, alive: () => server.listening, stop: async () => { upstreamSockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); } };
    } } });
  let access = new IDEAccessServer(manager); const files = await access.tls.prepare("127.0.0.1"), ca = access.tls.caCertificate(), port = await freePort();
  const origin = `https://127.0.0.1:${port}`, management = "http://127.0.0.1:18788";
  manager.configStore.save({ ...manager.config(), enabled: true, port, publicOrigin: origin, tls: files, hosts: [{ hostId: "local", enabled: true, binary: "code-server" }] });
  await access.reload(false); access.setManagementOrigin(management); t.after(() => access.close());
  const entry = manager.entry("account", "session")!;
  await assert.rejects(request(entry.url), /certificate|issuer/i, "untrusted clients must not bypass TLS verification");
  assert.match((await request(entry.url, ca)).body, /等待 Gateway 授权/);
  assert.equal((await request(origin + "/api/bootstrap", ca)).status, 401);
  const grant = await access.grant(entry.id);
  const logged = await request(origin + "/authorize", ca, { method: "POST", headers: { Origin: management }, body: new URLSearchParams({ token: grant.token, entryId: entry.id }).toString() });
  assert.equal(logged.status, 303); assert.match(logged.headers["set-cookie"]![0], /Secure/);
  const cookie = logged.headers["set-cookie"]![0].split(";")[0];
  const landing = await request(entry.url, ca, { headers: { Cookie: cookie } }), csrf = /name="csrf" value="([^"]+)"/.exec(landing.body)![1];
  assert.equal((await request(origin + "/open/" + entry.id, ca, { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.invalid" }, body: new URLSearchParams({ csrf }).toString() })).status, 403);
  assert.equal((await request(origin + "/open/" + entry.id, ca, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ csrf }).toString() })).status, 303);
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const req = https.request(`${origin}/ide/${entry.id}/socket`, { ca, agent: false, headers: { Cookie: cookie, Origin: origin, Connection: "Upgrade", Upgrade: "websocket" } });
    req.on("upgrade", (_res, connection) => resolve(connection)); req.on("error", reject); req.end();
  });
  const originalFingerprint = landing.fingerprint;
  await access.tls.prepare("127.0.0.1", true); await access.refreshCertificate();
  const renewed = await request(entry.url, ca, { headers: { Cookie: cookie } });
  assert.notEqual(renewed.fingerprint, originalFingerprint); assert.equal(renewed.status, 303); assert.match(renewed.headers.location!, /\/ide\//); assert.equal(socket.destroyed, false, "certificate reload must not close active terminals");
  await access.close(); access = new IDEAccessServer(manager); await access.reload(false);
  assert.match((await request(entry.url, ca, { headers: { Cookie: cookie } })).body, /打开 Web IDE/);
  assert.deepEqual(access.tls.caCertificate(), ca); access.revoke();
  assert.match((await request(entry.url, ca, { headers: { Cookie: cookie } })).body, /等待 Gateway 授权/);
});
test("certificate preparation is a local mutation, refuses arbitrary addresses and does not apply network changes", async t => {
  const root = temporary(t), manager = new WorkspaceIDEManager({ root, resolve: () => undefined });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  manager.configStore.save({ ...manager.config(), enabled: true, port, publicOrigin: origin });
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), accountManager: { ide: manager, listProjects: () => [] } as never, port: 0 });
  t.after(() => server.close());
  const before = fs.readFileSync(manager.configStore.filePath);
  const body = JSON.stringify({ address: "203.0.113.9" });
  assert.equal((await fetch(server.url + "/api/ide/tls/prepare", { method: "POST", body })).status, 403);
  const response = await fetch(server.url + "/api/ide/tls/prepare", { method: "POST", headers: { Origin: server.url, "X-Codex-IM-Gateway-Token": server.requestToken }, body });
  assert.ok(response.status >= 400); assert.deepEqual(fs.readFileSync(manager.configStore.filePath), before);
  const invalid = await fetch(server.url + "/api/ide/config", { method: "PUT", headers: { Origin: server.url, "X-Codex-IM-Gateway-Token": server.requestToken },
    body: JSON.stringify({ config: { ...manager.config(), publicOrigin: `https://127.0.0.1:${port}`, tls: { bindAddress: "127.0.0.1", certFile: path.join(root, "missing.crt"), keyFile: path.join(root, "missing.key") } } }) });
  assert.ok(invalid.status >= 400); assert.deepEqual(fs.readFileSync(manager.configStore.filePath), before);
  assert.equal((await fetch(origin)).status, 200, "invalid TLS must not stop the current valid listener");
});
