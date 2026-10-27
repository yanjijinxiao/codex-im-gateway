import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { PassThrough } from "node:stream";
import test from "node:test";
import ts from "typescript";
import { ProcessIDEInstallerIO } from "../src/ide/installer.js";
import http from "node:http";
import { EventEmitter } from "node:events";
import { IDEAccessServer } from "../src/ide/access-server.js";

for (const change of ["scope", "endpoint"]) test(`IDE upgrade rechecks ${change} after the upstream handshake`, async t => {
  const server = Object.create(IDEAccessServer.prototype) as any, upstream = new EventEmitter() as any;
  upstream.setTimeout = () => {}; upstream.end = () => {}; upstream.destroy = () => {};
  t.mock.method(http, "request", () => upstream);
  const id = "a".repeat(32), session = { entryId: id, scope: "old" };
  let scope = "old", instanceId = "old";
  server.manager = { config: () => ({ publicOrigin: "http://localhost" }), endpoint: () => ({ instanceId, socketPath: "/unused.sock" }) };
  server.refreshWorkspace = async () => {}; server.authenticate = () => session;
  server.validHost = server.validOrigin = () => true; server.track = () => {};
  server.authorization = { active: () => true }; server.scope = () => scope;
  const socket = new PassThrough(), remote = new PassThrough() as any; remote.setTimeout = () => {};
  let bytes = ""; socket.on("data", chunk => bytes += chunk);
  try {
    await server.upgrade({ url: `/ide/${id}/`, headers: {} }, socket, Buffer.alloc(0));
    if (change === "scope") scope = "new"; else instanceId = "new";
    upstream.emit("upgrade", { headers: {} }, remote, Buffer.alloc(0));
    assert.equal(socket.destroyed, true); assert.equal(remote.destroyed, true); assert.equal(bytes, "");
  } finally { socket.destroy(); remote.destroy(); }
});

for (const operation of ["projects", "inspect"]) test(`CLI ${operation} must not report an unreadable catalog as empty or missing`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-unreadable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.promises.readdir;
  t.mock.method(fs.promises, "readdir", (async (...args: any[]) => {
    if (String(args[0]) === path.join(root, "sessions")) throw Object.assign(Error("synthetic unreadable catalog"), { code: "EACCES" });
    return Reflect.apply(original, fs.promises, args);
  }) as typeof original);
  const { CodexExecRunner } = await import("../src/codex/exec-runner.js");
  const runner = new CodexExecRunner({ codexHome: root }); t.after(() => runner.close());
  await assert.rejects(operation === "projects" ? runner.listProjects() : runner.inspectThread("thread"), /synthetic unreadable catalog/);
});

test("closing an attachment HTTP response destroys its pending file reader", async () => {
  const source = fs.readFileSync(new URL("../src/server/http-server.ts", import.meta.url), "utf8");
  const start = source.indexOf("function serveSessionAttachment("), end = source.indexOf("function parseByteRange(", start);
  const reader = new PassThrough(), response = Object.assign(new PassThrough(), { setHeader() {}, headersSent: true });
  const context = vm.createContext({ fs: { statSync: () => ({ size: 100, isFile: () => true }), createReadStream: () => reader },
    parseByteRange: () => undefined, mediaContentType: () => "application/octet-stream", sendJson() {} });
  vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.serveSessionAttachment({ headers: {} }, response, { path: "/synthetic", name: "file" }, true, false);
  response.destroy(); await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(reader.destroyed, true); } finally { reader.destroy(); }
});

test("two IDE hosts downloading the same asset cannot concurrently write the shared cache", { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-installer-cache-"));
  const previousPath = process.env.PATH, gate = path.join(root, "release"), calls = path.join(root, "calls");
  t.after(() => { process.env.PATH = previousPath; fs.rmSync(root, { recursive: true, force: true }); });
  const bytes = Buffer.from("tiny isolated official-asset fixture"), curl = path.join(root, "curl");
  fs.writeFileSync(curl, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'start\\n');\nconst args=process.argv.slice(2),file=args[args.indexOf('--output')+1];const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);fs.writeFileSync(file,${JSON.stringify(bytes.toString())});}},5);`, { mode: 0o755 });
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  const asset = { version: "test", name: "asset.tar.gz", directory: "asset", size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"), url: "https://example.invalid/fixture" };
  const cache = path.join(root, "cache"), signal = AbortSignal.timeout(3000);
  const first = new ProcessIDEInstallerIO(cache).download(asset, () => {}, signal);
  const second = new ProcessIDEInstallerIO(cache).download(asset, () => {}, signal);
  let concurrent = 0;
  try {
    const deadline = Date.now() + 1500;
    while (!fs.existsSync(calls)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    await new Promise(resolve => setTimeout(resolve, 100));
    concurrent = fs.readFileSync(calls, "utf8").trim().split("\n").length;
  } finally { fs.writeFileSync(gate, "release"); await Promise.allSettled([first, second]); }
  assert.equal(concurrent, 1);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1, "later host reuses the verified cache");
});

for (const operation of ["projects", "inspect"] as const) test(`CLI ${operation} catalog yields while scanning so controls can respond`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-yield-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(root, "sessions"));
  for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(root, "sessions", `${i}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: `thread-${i}`, source: "cli", cwd: root } }) + "\n");
  const { CodexExecRunner } = await import("../src/codex/exec-runner.js");
  const runner = new CodexExecRunner({ codexHome: root }); t.after(() => runner.close());
  let controlsRan = false; const tick = new Promise<void>(resolve => setImmediate(() => { controlsRan = true; resolve(); }));
  if (operation === "projects") assert.equal((await runner.listProjects()).projects[0].sessionCount, 80);
  else assert.equal((await runner.inspectThread("thread-40")).persistence, "active");
  const responsive = controlsRan; await tick; assert.equal(responsive, true);
});
