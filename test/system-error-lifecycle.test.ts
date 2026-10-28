import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { SystemErrorRecoveryCoordinator } from "../src/server/system-error-recovery.js";

const scope = { hostId: "remote", threadId: "thread", turnId: "failed" };
const snapshot = () => ({ state: { threadId: "thread", persistence: "active", runtimeStatus: "systemError", activeFlags: [],
  lastTurnFailure: { turnId: "failed", code: "workspace-routing" } }, turns: [{ id: "failed", status: "failed", messages: [] }] });
function native() {
  const wire = new AppServerCodexRunner() as any;
  const state = snapshot() as any, calls: string[] = [];
  let pending = false, confirmed = false, allowed = true, unarchiveFailure = false, archiveFailure = false;
  wire.ensureConnected = async () => {}; wire.recyclePrivateTransportIfIdle = async () => {};
  wire.readThreadSnapshot = async () => structuredClone(state); wire.listQueuedSubmissions = async () => ({ data: [] });
  wire.getGoal = async () => undefined;
  wire.request = async (method: string) => {
    calls.push(method);
    if (method === "thread/archive") {
      state.state.persistence = "archived"; state.state.runtimeStatus = "notLoaded";
      if (archiveFailure) throw Error("archive acknowledgement lost");
    }
    if (method === "thread/unarchive") {
      if (unarchiveFailure) throw Error("unarchive disconnected");
      state.state.persistence = "active"; state.state.runtimeStatus = "notLoaded";
    }
    if (method === "thread/resume") state.state.runtimeStatus = "idle";
    return { thread: { id: "thread" } };
  };
  const input = { threadId: "thread", failedTurnId: "failed", assertCurrent() { if (!allowed) throw Error("source revoked"); },
    lifecycle: { restoring: false, archiveConfirmed: false,
      beforeArchive() { input.assertCurrent(); pending = true; }, archived() { confirmed = true; }, restored() { pending = false; } } };
  return { wire, state, input, calls, pending: () => pending, confirmed: () => confirmed,
    revoke() { allowed = false; }, failUnarchive(value: boolean) { unarchiveFailure = value; }, failArchive() { archiveFailure = true; } };
}

test("retained native runtime resets through a durable lifecycle and restores original persistence", async () => {
  const n = native(); const result = await n.wire.recoverSystemError(n.input);
  assert.equal(result.status, "recovered"); assert.equal(n.pending(), false);
  assert.deepEqual(n.calls, ["thread/archive", "thread/unarchive", "thread/resume"]);
  assert.equal(n.state.turns[0].status, "failed"); assert.equal(n.state.state.persistence, "active");
});
test("lost archive acknowledgement still compensates an observed archive without sending a task", async () => {
  const n = native(); n.failArchive(); await assert.rejects(n.wire.recoverSystemError(n.input), /acknowledgement/);
  assert.equal(n.state.state.persistence, "active"); assert.equal(n.pending(), false);
  assert.deepEqual(n.calls, ["thread/archive", "thread/unarchive"]);
});
test("unarchive failure keeps the obligation; retry only restores and never archives twice", async () => {
  const n = native(); n.failUnarchive(true);
  await assert.rejects(n.wire.recoverSystemError(n.input), /disconnected/); assert.equal(n.pending(), true);
  n.failUnarchive(false); n.input.lifecycle.restoring = true; n.input.lifecycle.archiveConfirmed = n.confirmed();
  assert.equal((await n.wire.recoverSystemError(n.input)).status, "recovered");
  assert.equal(n.pending(), false); assert.equal(n.calls.filter(x => x === "thread/archive").length, 1);
});
test("revoked source after archive still restores active persistence but cannot reload or execute", async () => {
  const n = native(), archived = n.input.lifecycle.archived;
  n.input.lifecycle.archived = () => { archived(); n.revoke(); };
  await assert.rejects(n.wire.recoverSystemError(n.input), /source revoked/);
  assert.equal(n.state.state.persistence, "active"); assert.equal(n.pending(), false);
  assert.equal(n.calls.includes("thread/resume"), false);
});
test("uncertain archive with a still-active read does not discard the restoration obligation", async () => {
  const n = native(); n.input.lifecycle.restoring = true;
  const result = await n.wire.recoverSystemError(n.input);
  assert.equal(result.reason, "unconfirmed"); assert.deepEqual(n.calls, []);
});
test("an active native Goal blocks state repair before lifecycle or inference", async () => {
  const n = native(); n.wire.getGoal = async () => ({ status: "active" });
  assert.equal((await n.wire.recoverSystemError(n.input)).reason, "busy");
  assert.deepEqual(n.calls, []); assert.equal(n.pending(), false);
});
test("native activity appearing during preparation prevents archive", async () => {
  const n = native(); n.wire.listQueuedSubmissions = async () => {
    n.state.state.activeTurnId = "new"; n.state.state.runtimeStatus = "active";
    n.state.turns.push({ id: "new", status: "inProgress", messages: [] }); return { data: [] };
  };
  assert.equal((await n.wire.recoverSystemError(n.input)).reason, "changed"); assert.deepEqual(n.calls, []);
});
test("a pending restoration gate also blocks a Goal mutation that could start native work", async () => {
  const router = Object.create(CodexBackendRouter.prototype) as any; let calls = 0;
  router.options = { onThreadMutation() { throw Error("pending native restoration"); } };
  router.backendForSharedOperation = () => ({ async setGoal() { calls++; } });
  await assert.rejects(router.setGoal("thread", { status: "active" }, "remote"), /pending native restoration/);
  assert.equal(calls, 0);
});

test("write-ahead lifecycle facts survive restart and compensate without a remaining IM binding", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-owned-restore-")), filePath = path.join(root, "recovery.json");
  const id = JSON.stringify([scope.hostId, scope.threadId, scope.turnId]);
  fs.writeFileSync(filePath, JSON.stringify({ [id]: { ...scope, attempts: 1, phase: "recovering", updatedAt: 1, nextAt: 0,
    message: "interrupted lifecycle", restoreActive: true, archiveConfirmed: true } }));
  let restored = false, messages = 0;
  const backend = { systemErrorLifecycleRecovery: true, async recoverSystemError(input: any) {
    assert.equal(input.lifecycle.restoring, true); restored = true; input.lifecycle.restored(); input.assertCurrent();
  }, async readThreadSnapshot() { return snapshot(); } } as any;
  const coordinator = new SystemErrorRecoveryCoordinator({ filePath, backend: () => backend, lease: () => undefined,
    notice: async () => { messages++; }, now: () => 100 });
  t.after(async () => { await coordinator.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(coordinator.hasPendingRestore("thread", "remote"), true);
  await coordinator.request(scope);
  assert.equal(restored, true); assert.equal(coordinator.hasPendingRestore("thread", "remote"), false);
  assert.equal(messages, 0, "the former binding is never notified");
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8"))[id].restoreActive, false);
});
test("coordinator makes rollback obligation durable before any native archive", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-writeahead-restore-")), filePath = path.join(root, "recovery.json");
  let state = snapshot() as any;
  const backend = { systemErrorLifecycleRecovery: true, async readThreadSnapshot() { return structuredClone(state); },
    async recoverSystemError(input: any) {
      input.lifecycle.beforeArchive();
      const row = Object.values(JSON.parse(fs.readFileSync(filePath, "utf8")))[0] as any;
      assert.equal(row.restoreActive, true); input.lifecycle.archived();
      throw Error("disconnected after archive");
    } } as any;
  const coordinator = new SystemErrorRecoveryCoordinator({ filePath, backend: () => backend, lease: () => () => {}, notice: async () => {}, now: () => 100 });
  t.after(async () => { await coordinator.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await coordinator.request(scope); assert.equal(coordinator.hasPendingRestore("thread", "remote"), true);
  assert.equal(coordinator.hasInFlightWork(), true);
  assert.match(coordinator.status(scope)!.message, /新写入暂缓/);
});
