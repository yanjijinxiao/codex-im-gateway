import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SystemErrorRecoveryCoordinator, type SystemRecoveryStatus } from "../src/server/system-error-recovery.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { canRecoverSystemError, type CodexThreadSnapshot } from "../src/codex/backend.js";
import { codexFailureCode, codexFailureSummary } from "../src/codex/turn-failure.js";

const scope = { hostId: "remote:one", threadId: "thread", turnId: "failed" };
const failed = (): CodexThreadSnapshot => ({ state: { threadId: "thread", persistence: "active", runtimeStatus: "systemError",
  activeFlags: [], lastTurnFailure: { turnId: "failed", code: "workspace-routing" } }, turns: [{ id: "failed", status: "failed", messages: [] }] });
function fixture(t: test.TestContext, extra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-system-recovery-"));
  const filePath = path.join(root, "recovery.json"); let snapshot = failed(), allowed = true, blocked = false, calls = 0, now = 1000;
  const notices: SystemRecoveryStatus[] = [];
  const backend = { async readThreadSnapshot() { return structuredClone(snapshot); }, async recoverSystemError(input: any) {
    input.assertCurrent(); calls++; snapshot.state.runtimeStatus = "idle"; return { status: "recovered" }; } } as any;
  const options = { filePath, backend: () => backend, lease: () => () => { if (!allowed) throw Error("binding changed"); },
    blocked: () => blocked, notice: async (_scope: unknown, status: SystemRecoveryStatus) => { notices.push(status); },
    now: () => now, cooldownMs: 100, noticeTimeoutMs: 25, ...extra };
  const manager = new SystemErrorRecoveryCoordinator(options);
  t.after(async () => { await manager.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, filePath, manager, backend, options, notices, snapshot: () => snapshot, calls: () => calls,
    revoke() { allowed = false; }, block() { blocked = true; }, clock(value: number) { now = value; } };
}

test("system recovery keeps identity and reports success only after a fresh native read", async t => {
  const f = fixture(t), result = await f.manager.request(scope);
  assert.equal(result?.runtimeStatus, "idle"); assert.equal(f.calls(), 1);
  assert.equal(f.manager.status(scope)?.phase, "recovered");
  assert.equal(f.notices[0].phase, "recovering"); assert.match(f.notices[1].message, /账号工作区路由/);
  assert.equal(f.notices.at(-1)?.phase, "recovered"); assert.match(f.notices.at(-1)!.message, /旧消息未重发/);
});
test("a claimed successful reset without native recovery remains failed", async t => {
  const f = fixture(t); f.backend.recoverSystemError = async () => ({ status: "recovered", state: { runtimeStatus: "idle" } });
  assert.equal(await f.manager.request(scope), undefined); assert.equal(f.manager.status(scope)?.phase, "failed");
  assert.equal(f.snapshot().state.runtimeStatus, "systemError");
});
test("parallel observations coalesce and respect cooldown", async t => {
  const f = fixture(t), gate = Promise.withResolvers<void>();
  let nativeCalls = 0;
  f.backend.recoverSystemError = async () => { nativeCalls++; await gate.promise; f.snapshot().state.runtimeStatus = "idle"; return { status: "recovered" }; };
  const first = f.manager.request(scope), second = f.manager.request(scope); gate.resolve();
  assert.equal((await first)?.threadId, "thread"); await second;
  const count = f.notices.length; await f.manager.request(scope); assert.equal(f.notices.length, count);
  assert.equal(nativeCalls, 1);
});
for (const reason of ["active", "flags", "orphan", "history-active", "changed-tail", "archived"])
  test(`native recovery refuses ${reason} snapshots`, () => {
    const s = failed();
    if (reason === "active") s.state.activeTurnId = "new";
    if (reason === "flags") s.state.activeFlags = ["waitingOnApproval"];
    if (reason === "orphan") s.state.pendingTurnWithoutId = true;
    if (reason === "history-active") s.turns.push({ id: "new", status: "inProgress", messages: [] });
    if (reason === "changed-tail") s.turns.push({ id: "new", status: "failed", messages: [] });
    if (reason === "archived") s.state.persistence = "archived";
    assert.equal(canRecoverSystemError(s, "failed"), false);
  });
test("unknown submissions block recovery before any write", async t => {
  const f = fixture(t); f.block(); await f.manager.request(scope);
  assert.equal(f.calls(), 0); assert.equal(fs.existsSync(f.filePath), false);
});
test("a replaced binding during preparation never receives a native reset", async t => {
  const f = fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.backend.readThreadSnapshot = async () => { entered.resolve(); await release.promise; return failed(); };
  const pending = f.manager.request(scope); await entered.promise; f.revoke(); release.resolve(); await pending;
  assert.equal(f.calls(), 0); assert.notEqual(f.manager.status(scope)?.phase, "recovered");
});
test("a new source cancels pending recovery before the native write", async t => {
  const f = fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.backend.readThreadSnapshot = async () => { entered.resolve(); await release.promise; return failed(); };
  const pending = f.manager.request(scope); await entered.promise; f.manager.cancel(scope.threadId, scope.hostId); release.resolve(); await pending;
  assert.equal(f.calls(), 0); assert.equal(f.manager.status(scope)?.phase, "cancelled");
});
test("a hanging progress transport cannot block state recovery or shutdown", { timeout: 1500 }, async t => {
  const f = fixture(t, { notice: () => new Promise(() => {}), noticeTimeoutMs: 10 });
  assert.equal((await f.manager.request(scope))?.runtimeStatus, "idle"); await f.manager.stop();
});
test("an accepted input invalidates late progress even after recovery work finished", async t => {
  const gate = Promise.withResolvers<void>(); let delivered = 0;
  const f = fixture(t, { notice: async (_scope: unknown, _status: unknown, _state: unknown, assertSource: () => void) => {
    await gate.promise; assertSource(); delivered++;
  } });
  await f.manager.request(scope); f.manager.cancel(scope.threadId, scope.hostId); gate.resolve();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(delivered, 0);
});
test("missing native owner support is explicit and is not retried on every observation", async t => {
  const f = fixture(t); delete f.backend.recoverSystemError;
  await f.manager.request(scope); assert.equal(f.manager.status(scope)?.phase, "unsupported");
  const count = f.notices.length; f.manager.offer(failed(), scope.hostId); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.notices.length, count); assert.match(f.notices.at(-1)!.message, /未切换后端/);
});
test("capacity recovery retains its separate coordinator", async t => {
  const f = fixture(t), snapshot = failed(); snapshot.state.lastTurnFailure!.code = "model-capacity";
  f.manager.offer(snapshot, scope.hostId); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls(), 0);
});
test("malformed optional recovery ledger is preserved and disables native resets", async t => {
  const f = fixture(t), raw = '{"bad":true}'; fs.writeFileSync(f.filePath, raw);
  const manager = new SystemErrorRecoveryCoordinator(f.options); await manager.request(scope); await manager.stop();
  assert.equal(f.calls(), 0); assert.equal(fs.readFileSync(f.filePath, "utf8"), raw);
});
test("failed write-ahead persistence prevents a native reset", async t => {
  const f = fixture(t), original = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => { if (String(to) === f.filePath) throw Error("synthetic disk failure"); return original(from, to); });
  await assert.rejects(f.manager.request(scope), /synthetic disk failure/); assert.equal(f.calls(), 0);
});
for (const healthy of [false, true]) test(`restart only reconciles an uncertain reset, healthy=${healthy}`, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, JSON.stringify({ [JSON.stringify([scope.hostId, scope.threadId, scope.turnId])]: {
    ...scope, attempts: 1, phase: "recovering", nextAt: 10000, updatedAt: 900, message: "pending" } }));
  f.snapshot().state.runtimeStatus = healthy ? "idle" : "systemError";
  const manager = new SystemErrorRecoveryCoordinator(f.options); const state = await manager.request(scope); await manager.stop();
  assert.equal(f.calls(), 0); assert.equal(state?.runtimeStatus, healthy ? "idle" : undefined);
  assert.equal(manager.status(scope)?.phase, healthy ? "recovered" : "failed");
});
test("the native adapter only resumes the same identity and never submits an input", async () => {
  const wire = new AppServerCodexRunner() as any; let state = failed(), calls: any[] = [];
  state.state.runtimeStatus = "notLoaded";
  wire.listQueuedSubmissions = async () => ({ data: [] });
  wire.ensureConnected = async () => {}; wire.recyclePrivateTransportIfIdle = async () => {};
  wire.readThreadSnapshot = async () => structuredClone(state);
  wire.request = async (method: string, params: unknown) => { calls.push([method, params]); state.state.runtimeStatus = "idle"; return { thread: { id: "thread" } }; };
  assert.equal((await wire.recoverSystemError({ threadId: "thread", failedTurnId: "failed", assertCurrent() {} })).status, "recovered");
  assert.deepEqual(calls, [["thread/resume", { threadId: "thread", excludeTurns: true }]]);
});
test("native reset rechecks the binding after connecting and preserves unknown starts", async () => {
  const wire = new AppServerCodexRunner() as any; let allowed = true, writes = 0;
  wire.listQueuedSubmissions = async () => ({ data: [] });
  wire.recyclePrivateTransportIfIdle = async () => {}; wire.readThreadSnapshot = async () => failed();
  wire.ensureConnected = async () => { allowed = false; }; wire.request = async () => { writes++; };
  await assert.rejects(wire.recoverSystemError({ threadId: "thread", failedTurnId: "failed", assertCurrent() { if (!allowed) throw Error("revoked"); } }), /revoked/);
  assert.equal(writes, 0); wire.unconfirmedStarts.add("thread");
  assert.equal((await wire.recoverSystemError({ threadId: "thread", failedTurnId: "failed", assertCurrent() {} })).status, "deferred");
  assert.equal(writes, 0);
});
test("a loaded error only releases its own subscription and waits for native unload", async () => {
  const wire = new AppServerCodexRunner() as any, calls: unknown[] = [];
  wire.readThreadSnapshot = async () => failed(); wire.listQueuedSubmissions = async () => ({ data: [] });
  wire.ensureConnected = async () => {}; wire.recyclePrivateTransportIfIdle = async () => {};
  wire.request = async (method: string, params: unknown) => { calls.push([method, params]); return { status: "notSubscribed" }; };
  const result = await wire.recoverSystemError({ threadId: "thread", failedTurnId: "failed", assertCurrent() {} });
  assert.equal(result.reason, "awaiting-unload"); assert.deepEqual(calls, [["thread/unsubscribe", { threadId: "thread" }]]);
  wire.listQueuedSubmissions = async () => ({ data: [{ id: "existing" }] });
  assert.equal((await wire.recoverSystemError({ threadId: "thread", failedTurnId: "failed", assertCurrent() {} })).reason, "busy");
  assert.equal(calls.length, 1, "native pending inputs prohibit reload");
});
test("native-unload waiting is read-only until the exact failed session becomes unloaded", async t => {
  const f = fixture(t); let nativeCalls = 0;
  f.backend.recoverSystemError = async () => { nativeCalls++; return { status: "deferred", reason: "awaiting-unload" }; };
  await f.manager.request(scope); assert.equal(f.manager.status(scope)?.phase, "waiting");
  f.clock(1200); await f.manager.request(scope); assert.equal(nativeCalls, 1);
  const noticeCount = f.notices.length;
  f.snapshot().state.runtimeStatus = "notLoaded";
  f.backend.recoverSystemError = async () => { nativeCalls++; f.snapshot().state.runtimeStatus = "idle"; return { status: "recovered" }; };
  f.clock(1400); f.manager.offer(structuredClone(f.snapshot()), scope.hostId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeCalls, 2); assert.equal(f.manager.status(scope)?.phase, "recovered");
  assert.ok(f.notices.length > noticeCount);
});
test("an owner held error has a bounded waiting period and is never reported recovered", async t => {
  const f = fixture(t, { unloadWaitMs: 150 });
  f.backend.recoverSystemError = async () => ({ status: "deferred", reason: "awaiting-unload" });
  await f.manager.request(scope); f.clock(1200); await f.manager.request(scope);
  assert.equal(f.manager.status(scope)?.phase, "unsupported"); assert.match(f.manager.status(scope)!.message, /尚未恢复/);
});
test("a deployed lifecycle capability upgrades an existing owner-held wait", async t => {
  const f = fixture(t); f.backend.recoverSystemError = async () => ({ status: "deferred", reason: "awaiting-unload" });
  await f.manager.request(scope); f.clock(1200); f.backend.systemErrorLifecycleRecovery = true;
  f.backend.recoverSystemError = async (input: any) => {
    input.lifecycle.beforeArchive(); input.lifecycle.archived(); input.lifecycle.restored();
    f.snapshot().state.runtimeStatus = "idle"; return { status: "recovered" };
  };
  await f.manager.request(scope); assert.equal(f.manager.status(scope)?.phase, "recovered");
});
test("a restarted unload wait does not repeat native release and throttles failed observations", async t => {
  const f = fixture(t);
  f.backend.recoverSystemError = async () => ({ status: "deferred", reason: "awaiting-unload" });
  await f.manager.request(scope);
  const manager = new SystemErrorRecoveryCoordinator(f.options); f.clock(1200);
  f.backend.readThreadSnapshot = async () => { throw Error("offline"); };
  await manager.request(scope); const notices = f.notices.length;
  await manager.request(scope); assert.equal(f.notices.length, notices); assert.equal(f.calls(), 0);
  assert.match(manager.status(scope)!.message, /只读检查/); await manager.stop();
});
test("a failed reload of an unloaded session retries after transport recovers", async t => {
  const f = fixture(t); let calls = 0;
  f.backend.recoverSystemError = async () => { calls++; return { status: "deferred", reason: "awaiting-unload" }; };
  await f.manager.request(scope); f.snapshot().state.runtimeStatus = "notLoaded"; f.clock(1200);
  f.backend.recoverSystemError = async () => { calls++; throw Error("transport unavailable during reload"); };
  await f.manager.request(scope); assert.equal(f.manager.status(scope)?.phase, "failed");
  f.backend.recoverSystemError = async () => { calls++; f.snapshot().state.runtimeStatus = "idle"; return { status: "recovered" }; };
  f.clock(1400); f.manager.offer(structuredClone(f.snapshot()), scope.hostId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3); assert.equal(f.manager.status(scope)?.phase, "recovered");
});
test("an obsolete failed turn is retired during native-unload waiting", async t => {
  const f = fixture(t); f.backend.recoverSystemError = async () => ({ status: "deferred", reason: "awaiting-unload" });
  await f.manager.request(scope); f.clock(1200);
  f.snapshot().state.lastTurnFailure!.turnId = "different";
  await f.manager.request(scope); assert.equal(f.manager.status(scope)?.phase, "cancelled");
});
test("Desktop ownership never falls back to a private stdio state reset", async () => {
  const router = Object.create(CodexBackendRouter.prototype) as any; let privateReads = 0;
  Object.defineProperty(router, "selectedBackend", { value: "app-server" }); const snapshot = failed(); snapshot.state.executionOwner = "desktop";
  router.readThreadSnapshot = async () => snapshot; router.appServerFor = () => { privateReads++; throw Error("wrong owner"); };
  assert.equal((await router.recoverSystemError({ threadId: "thread", failedTurnId: "failed", assertCurrent() {} })).status, "unsupported");
  assert.equal(privateReads, 0);
});
test("known routing and CONNECT errors have safe progress summaries", () => {
  assert.equal(codexFailureCode("workspace routing discovery failed"), "workspace-routing");
  assert.equal(codexFailureCode("tunnel CONNECT failed with 503 secret-provider-body"), "network-proxy");
  assert.doesNotMatch(codexFailureSummary("network-proxy"), /secret-provider-body/);
});

test("three failed reloads back off before a later automatic recovery cycle", async t => {
  const f = fixture(t); let calls = 0;
  f.backend.recoverSystemError = async () => { calls++; return { status: "failed" }; };
  for (const now of [1000, 1100, 1200]) { f.clock(now); await f.manager.request(scope); }
  assert.equal(calls, 3); f.clock(5000); await f.manager.request(scope); assert.equal(calls, 3);
  f.clock(901201); await f.manager.request(scope); assert.equal(calls, 4); assert.equal(f.manager.status(scope)?.attempts, 1);
});

test("a preflight transport failure is recorded and rate limited", async t => {
  const f = fixture(t); f.backend.readThreadSnapshot = async () => { throw Error("synthetic connection error"); };
  await f.manager.request(scope); assert.equal(f.manager.status(scope)?.phase, "failed");
  const count = f.notices.length; await f.manager.request(scope); assert.equal(f.notices.length, count); assert.equal(f.calls(), 0);
});

for (const recovered of [true, false]) test(`a new IM message may submit only after recovery is natively confirmed, recovered=${recovered}`, async t => {
  const { BridgeService } = await import("../src/bridge/service.js");
  const { RuntimeStateStore } = await import("../src/state/runtime-state.js");
  const { resolveStatePaths } = await import("../src/state/paths.js");
  const { defaultConfig } = await import("../src/state/config.js");
  const f = fixture(t), store = new RuntimeStateStore(resolveStatePaths(path.join(f.root, "state")));
  const project = store.createProject("project", f.root), session = store.createSession("chat", f.root, "session", project.id);
  store.setSessionThread(session.id, "thread"); let runs = 0, recoveries = 0;
  let nativeState = failed().state;
  const service = new BridgeService({ config: { ...defaultConfig(f.root), allowedSenderIds: ["chat"], streamReplies: false }, stateStore: store,
    weixin: { async sendText() { return { messageId: "sent" }; } } as never,
    runner: { async inspectThread() { return nativeState; }, async run(input: any) {
      runs++; assert.match(input.prompt, /new IM request/); return { threadId: "thread", text: "new result", raw: "" }; } } as never,
    requestSystemRecovery: async (target, guard) => {
      assert.equal(target.threadId, "thread"); assert.equal(target.turnId, "failed"); guard(); recoveries++;
      if (!recovered) return undefined;
      nativeState = { ...failed().state, runtimeStatus: "idle" }; return nativeState;
    } });
  const input = service.handleMessage({ id: "new", senderId: "chat", text: "new IM request", raw: {} });
  if (recovered) await input;
  else await assert.rejects(input, /本条输入尚未提交/);
  assert.equal(recoveries, 1); assert.equal(runs, recovered ? 1 : 0); assert.equal(store.getSession(session.id)?.threadId, "thread");
});
