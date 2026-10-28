import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager, RuntimeConfigurationBusyError } from "../src/server/account-manager.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { releaseAdmissionFile, readReleaseOwner } from "../src/server/release-admission.js";
// @ts-ignore Standalone JS release tooling.
import { claimRuntimeRelease, finishRuntimeRelease, assertRollbackAdmission } from "../scripts/release-local.mjs";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-release-admission-"));
  const paths = resolveStatePaths(root);
  const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: false }) });
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, paths, internal: manager as any };
}

for (const kind of ["responding", "preparing", "queue dispatch", "capacity recovery", "system recovery", "configuration", "shutdown"]) {
  test(`release refuses ${kind} without closing the runner or freezing the existing task`, t => {
    const f = fixture(t); let closes = 0;
    f.internal.runner = { close() { closes++; } };
    if (kind === "responding") f.internal.respondingSessions.set("task", 1);
    if (kind === "preparing" || kind === "queue dispatch") f.internal.entries.set("one", { service: { hasInFlightWork: () => true } });
    if (kind === "capacity recovery") t.mock.method(f.internal.capacityRecovery, "hasInFlightWork", () => true);
    if (kind === "system recovery") t.mock.method(f.internal.systemRecovery, "hasInFlightWork", () => true);
    if (kind === "configuration") f.internal.runtimeConfigurationChanging = true;
    if (kind === "shutdown") f.internal.stoppingAll = true;
    assert.throws(() => f.manager.prepareRelease(crypto.randomUUID()), RuntimeConfigurationBusyError);
    assert.equal(closes, 0);
    assert.equal(f.internal.releaseOwner, undefined);
    f.internal.entries.clear();
  });
}

test("release admission is synchronous, owner scoped, and blocks shared mutation/reconfiguration until cancellation", async t => {
  const f = fixture(t), id = crypto.randomUUID();
  const lease = f.manager.prepareRelease(id);
  assert.deepEqual(lease, { id, pid: process.pid, prepared: true });
  assert.deepEqual(f.manager.prepareRelease(id), lease, "an exact retry retains the same gate");
  assert.throws(() => f.manager.prepareRelease(crypto.randomUUID()), RuntimeConfigurationBusyError);
  assert.throws(() => f.internal.assertRuntimeWritable(), /发布/);
  let changed = false;
  await assert.rejects(f.manager.reconfigureRuntime(async () => { changed = true; }), RuntimeConfigurationBusyError);
  assert.equal(changed, false);
  assert.equal(f.manager.cancelRelease(crypto.randomUUID()), false);
  assert.throws(() => f.internal.assertRuntimeWritable(), /发布/);
  assert.equal(f.manager.cancelRelease(id), true);
  assert.doesNotThrow(() => f.internal.assertRuntimeWritable());
  assert.equal(f.manager.cancelRelease(id), false);
  assert.throws(() => f.manager.prepareRelease(""), /release|发布/i);
});

test("real IM, Web, and queue entry points refuse submissions behind the same release gate", async t => {
  const f = fixture(t); let writes = 0;
  saveAccount(f.paths, { accountId: "one", userId: "actor", token: "synthetic", baseUrl: "https://example.invalid", enabled: false });
  const session = f.manager.createSession("one", "chat", f.paths.root, "Synthetic gate test");
  const service = new BridgeService({ config: { ...defaultConfig(f.paths.root), taskboardEnabled: false },
    stateStore: new RuntimeStateStore(f.paths),
    runner: { async run() { writes++; return { text: "", raw: "" }; } } as never,
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "synthetic" }; } }),
    assertRuntimeWritable: () => f.internal.assertRuntimeWritable() });
  const id = crypto.randomUUID(); f.manager.prepareRelease(id);
  await assert.rejects(service.handleMessage({ id: "message", senderId: "actor", text: "run", attachments: [], raw: {} }), /发布/);
  await assert.rejects(service.recoverNativeQueue(), /发布/);
  await assert.rejects(f.manager.continueSession("one", session.id, "run"), /发布/);
  assert.equal(service.hasInFlightWork(), false); assert.equal(writes, 0);
  f.manager.cancelRelease(id);
});

test("authenticated HTTP prepare freezes submissions and a wrong owner cannot reopen them", async t => {
  const f = fixture(t), server = await startLocalHttpServer({ paths: f.paths, port: 0, accountManager: f.manager });
  t.after(() => server.close());
  const id = crypto.randomUUID(), headers = { Origin: server.url, "Content-Type": "application/json", "X-Codex-Im-Gateway-Token": server.requestToken };
  const post = (route: string, owner = id, extra = headers) => fetch(`${server.url}/api/release/${route}`, { method: "POST", headers: extra, body: JSON.stringify({ id: owner }) });
  assert.equal((await post("prepare", id, { ...headers, "X-Codex-Im-Gateway-Token": "wrong" })).status, 403);
  assert.doesNotThrow(() => f.internal.assertRuntimeWritable());
  const accepted = await post("prepare"); assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { id, pid: process.pid, prepared: true });
  assert.equal((await post("prepare", crypto.randomUUID())).status, 409);
  assert.equal((await post("prepare", "invalid")).status, 400);
  assert.deepEqual(await (await post("cancel", crypto.randomUUID())).json(), { released: false });
  assert.throws(() => f.internal.assertRuntimeWritable(), /发布/);
  assert.deepEqual(await (await post("cancel")).json(), { released: true });
  assert.doesNotThrow(() => f.internal.assertRuntimeWritable());
});

test("replacement startup remains frozen until the same release owner completes readiness", async t => {
  const f = fixture(t), id = crypto.randomUUID();
  saveAccount(f.paths, { accountId: "one", userId: "actor", token: "synthetic", baseUrl: "https://example.invalid", enabled: true });
  f.manager.prepareRelease(id, true);
  assert.equal(readReleaseOwner(f.paths.root), id);
  await f.manager.stopAll();
  const replacement = new AccountManager({ paths: f.paths,
    configProvider: () => ({ ...defaultConfig(f.paths.root), taskboardEnabled: false }),
    adapterFactory: () => ({ client: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "synthetic" }; } }),
      async monitor({ signal, onStatus }) { onStatus?.({ state: "connected" }); await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true })); } }),
    runnerFactory: () => ({ async warmUp() {}, close() {} } as never),
    codexSessionMonitorFactory: () => ({ start() {}, async stop() {} } as never),
    codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} } as never) });
  t.after(() => replacement.stopAll());
  assert.throws(() => (replacement as any).assertRuntimeWritable(), /发布/);
  await replacement.startAll();
  assert.equal(replacement.listAccounts()[0].status, "running", "channel readiness can initialize behind the native input gate");
  assert.throws(() => (replacement as any).assertRuntimeWritable(), /发布/);
  assert.equal(replacement.cancelRelease(crypto.randomUUID()), false);
  assert.equal(replacement.cancelRelease(id), true);
  assert.equal(readReleaseOwner(f.paths.root), undefined);
  assert.doesNotThrow(() => (replacement as any).assertRuntimeWritable());
  await replacement.stopAll();
});

test("rollback refuses to stop a replacement after its persistent admission was reopened", t => {
  const f = fixture(t), id = crypto.randomUUID(); f.manager.prepareRelease(id, true);
  assert.doesNotThrow(() => assertRollbackAdmission(f.paths.root, id));
  assert.throws(() => assertRollbackAdmission(f.paths.root, crypto.randomUUID()), /admission/);
  f.manager.cancelRelease(id);
  assert.throws(() => assertRollbackAdmission(f.paths.root, id), /ENOENT/);
});

test("invalid gate journals fail closed and disk errors cannot silently reopen native admission", t => {
  const f = fixture(t), file = releaseAdmissionFile(f.paths.root), id = crypto.randomUUID();
  fs.writeFileSync(file, '{"version":1,"id":"corrupt"}');
  assert.throws(() => new AccountManager({ paths: f.paths }), /Invalid release admission/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"version":1,"id":"corrupt"}');
  fs.unlinkSync(file); f.manager.prepareRelease(id, true);
  const original = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", function(target: fs.PathLike) {
    if (String(target) === file) throw Error("injected gate disk failure");
    return original(target);
  });
  assert.throws(() => f.manager.cancelRelease(id), /disk failure/);
  assert.throws(() => f.internal.assertRuntimeWritable(), /发布/);
  assert.equal(readReleaseOwner(f.paths.root), id);
});

for (const status of [404, 409]) test(`release tooling refuses HTTP ${status} before any cutover`, async () => {
  let cancellations = 0;
  const request = async (url: URL) => {
    if (url.pathname === "/api/request-context") return Response.json({ requestToken: "synthetic" });
    if (url.pathname.endsWith("/cancel")) { cancellations++; return Response.json({ released: false }); }
    return new Response("", { status });
  };
  await assert.rejects(claimRuntimeRelease(new URL("http://127.0.0.1:12345"), 111, request), new RegExp(`HTTP ${status}`));
  assert.equal(cancellations, 1, "uncertain claim acknowledgements receive an owner-scoped cancellation");
});

test("release tooling cancels an ambiguously acknowledged gate without submitting or replaying a task", async () => {
  let owner: string | undefined;
  const request = async (url: URL, options?: RequestInit) => {
    if (url.pathname === "/api/request-context") return Response.json({ requestToken: "synthetic" });
    const { id } = JSON.parse(options!.body as string);
    if (url.pathname.endsWith("/prepare")) { owner = id; throw Error("lost gate acknowledgement"); }
    assert.equal(url.pathname, "/api/release/cancel"); assert.equal(id, owner); owner = undefined;
    return Response.json({ released: true });
  };
  await assert.rejects(claimRuntimeRelease(new URL("http://127.0.0.1:12345"), 111, request), /lost gate acknowledgement/);
  assert.equal(owner, undefined);
});

test("replacement verification refreshes process credentials and refuses a changed owner or PID", async () => {
  const origin = new URL("http://127.0.0.1:12345"), id = crypto.randomUUID();
  let pid = 222, owner = id, prepared = true, cancellations = 0;
  const request = async (url: URL, options?: RequestInit) => {
    if (url.pathname === "/api/request-context") return Response.json({ requestToken: "new-process-token" });
    assert.equal((options!.headers as Record<string, string>)["X-Codex-Im-Gateway-Token"], "new-process-token");
    if (url.pathname.endsWith("/status")) return Response.json({ id: owner, pid, prepared });
    assert.equal(JSON.parse(options!.body as string).id, owner); cancellations++; prepared = false;
    return Response.json({ released: true });
  };
  pid = 333; await assert.rejects(finishRuntimeRelease(origin, id, 222, request), /PID changed/);
  pid = 222; owner = crypto.randomUUID(); await assert.rejects(finishRuntimeRelease(origin, id, 222, request), /owner\/PID changed/);
  assert.equal(cancellations, 0);
  owner = id; await finishRuntimeRelease(origin, id, 222, request);
  assert.equal(cancellations, 1);
  await finishRuntimeRelease(origin, id, 222, request); assert.equal(cancellations, 1);
});

test("web updater refuses active work before installation and clears its admission on install failure", async t => {
  const f = fixture(t); let installs = 0;
  const server = await startLocalHttpServer({ paths: f.paths, port: 0, accountManager: f.manager,
    updateService: { async check() { return {} as never; }, async installLatest() { installs++; throw Error("injected install failure"); } } });
  t.after(() => server.close());
  const request = () => fetch(`${server.url}/api/update`, { method: "POST", headers: { Origin: server.url, "X-Codex-Im-Gateway-Token": server.requestToken } });
  f.internal.respondingSessions.set("running", 1);
  assert.equal((await request()).status, 409); assert.equal(installs, 0);
  f.internal.respondingSessions.clear();
  assert.equal((await request()).status, 500); assert.equal(installs, 1);
  assert.doesNotThrow(() => f.internal.assertRuntimeWritable());
});
