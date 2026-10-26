import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CapacityRecoveryCoordinator, type CapacityFailure } from "../src/server/capacity-recovery.js";
import { CodexTurnExecutionError, type CodexBridgeBackend, type CodexThreadSnapshot, type CodexCapacityResumeInput } from "../src/codex/backend.js";

const scope = { hostId: "local", threadId: "thread", turnId: "new-failure" }, key = JSON.stringify(["local", "thread"]);
const snapshot = (): CodexThreadSnapshot => ({ state: { threadId: "thread", persistence: "active", runtimeStatus: "systemError", activeFlags: [],
  lastTurnFailure: { turnId: scope.turnId, code: "model-capacity" } }, turns: [
  { id: "old-failure", status: "failed", messages: [] }, { id: "old-retry", status: "completed", messages: [] },
  { id: scope.turnId, status: "failed", messages: [] }] });
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error("Capacity reconciliation condition timed out");
}
function fixture(t: test.TestContext, read: () => Promise<CodexThreadSnapshot> = async () => snapshot(), patch: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-reconcile-")), file = path.join(root, "recovery.json");
  const previous = { hostId: "local", threadId: "thread", turnId: "old-retry", backend: "app-server", turns: ["old-failure", "old-retry"],
    acceptedTurnId: "old-retry", clientId: "old-client", attempts: 3, status: "uncertain", cancelFuture: true, nextAt: 1, ...patch };
  fs.writeFileSync(file, JSON.stringify({ records: { [key]: previous } }));
  const calls: CodexCapacityResumeInput[] = [], terminal: Array<{ scope: CapacityFailure; text: string; outcome?: string }> = [];
  let reads = 0, eligible = true;
  const backend = { backendInfo: () => ({ id: "app-server" }), async readThreadSnapshot(thread: string, host: string) {
    assert.equal(thread, "thread"); assert.equal(host, "local"); reads++; return read();
  }, async resumeAfterCapacity(input: CodexCapacityResumeInput) {
    input.assertCurrent(); calls.push(input); await input.onTurnStarted({ threadId: "thread", turnId: "new-retry" });
    return { threadId: "thread", turnId: "new-retry", text: "new result", raw: "" };
  } } as CodexBridgeBackend;
  const options = { filePath: file, backend: () => backend, eligible: () => eligible, delaysMs: [2, 2, 2, 2], reconcileTimeoutMs: 50,
    async notice() {}, async accepted() {}, async progress() {}, async terminal(scope: CapacityFailure, text: string, outcome?: string) { terminal.push({ scope, text, outcome }); } };
  const coordinator = new CapacityRecoveryCoordinator(options);
  t.after(() => { coordinator.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { coordinator, calls, terminal, options, backend, saved: () => JSON.parse(fs.readFileSync(file, "utf8")).records[key], reads: () => reads,
    setEligible: (value: boolean) => { eligible = value; } };
}

test("new confirmed failure supersedes a proved-ended old recovery without inheriting cancellation or attempt counts", async t => {
  let release!: (value: CodexThreadSnapshot) => void;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  for (let i = 0; i < 10; i++) assert.equal(f.coordinator.offer(scope), true);
  assert.equal(f.reads(), 1); assert.equal(f.coordinator.holdsStart(scope), true); assert.equal(f.calls.length, 0);
  release(snapshot()); await until(() => f.terminal.length === 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].failedTurnId, scope.turnId);
  assert.match(f.calls[0].clientUserMessageId, /^capacity-/); assert.notEqual(f.calls[0].clientUserMessageId, "old-client");
  assert.equal("prompt" in f.calls[0], false);
  const saved = f.saved(); assert.equal(saved.attempts, 1); assert.equal(saved.cancelFuture, undefined);
  assert.deepEqual(saved.turns, [scope.turnId, "new-retry"]);
  assert.deepEqual(saved.retiredTurns, ["old-failure", "old-retry"]);
  assert.equal(saved.previousClosure.turnId, "old-retry"); assert.equal(saved.previousClosure.status, "completed");
  assert.equal(f.terminal[0].text, "new result");
  assert.equal(f.coordinator.offer({ ...scope, turnId: "old-failure" }), true); assert.equal(f.calls.length, 1);
  const restarted = new CapacityRecoveryCoordinator(f.options); t.after(() => restarted.stop());
  assert.equal(restarted.offer({ ...scope, turnId: "old-retry" }), true); assert.equal(f.reads(), 1);
});

for (const invalid of ["missing-old", "old-active", "missing-acceptance", "foreign", "new-active", "wrong-cause", "superseded", "unknown-runtime"] as const) {
  test(`uncertain recovery remains protected when fresh proof is invalid: ${invalid}`, async t => {
    const value = snapshot();
    if (invalid === "missing-old") value.turns.splice(1, 1);
    if (invalid === "old-active") value.turns[1].status = "inProgress";
    if (invalid === "foreign") value.state.threadId = "other";
    if (invalid === "new-active") value.state.runtimeStatus = "active";
    if (invalid === "wrong-cause") value.state.lastTurnFailure!.code = "rate-limit";
    if (invalid === "superseded") value.turns.push({ id: "newer", status: "completed", messages: [] });
    if (invalid === "unknown-runtime") value.state.runtimeStatus = "unknown";
    const f = fixture(t, async () => value, invalid === "missing-acceptance" ? { acceptedTurnId: undefined } : {});
    assert.equal(f.coordinator.offer(scope), true); await until(() => f.terminal.length === 1);
    assert.equal(f.calls.length, 0); assert.equal(f.saved().status, "uncertain"); assert.equal(f.saved().attempts, 3);
    assert.equal(f.terminal[0].outcome, "failed"); assert.match(f.terminal[0].text, /未安排自动恢复/);
  });
}

test("native client-message correlation can establish an accepted ID without guessing from text", async t => {
  const value = snapshot(); value.turns[1].messages = [{ id: "receipt", role: "user", text: "irrelevant", clientUserMessageId: "old-client" }];
  const f = fixture(t, async () => value, { acceptedTurnId: undefined });
  f.coordinator.offer(scope); await until(() => f.calls.length === 1);
  assert.equal(f.saved().previousClosure.turnId, "old-retry");
});

test("a fresh chain gets its own full bounded budget, without replaying the old chain", async t => {
  const f = fixture(t);
  let attempts = 0;
  f.backend.resumeAfterCapacity = async input => {
    input.assertCurrent(); f.calls.push(input); attempts++;
    await input.onTurnStarted({ threadId: "thread", turnId: `fresh-${attempts}` });
    throw new CodexTurnExecutionError("failed", "capacity", "model-capacity");
  };
  f.coordinator.offer(scope); await until(() => f.terminal.length === 1);
  assert.equal(attempts, 4); assert.equal(f.saved().attempts, 4);
  assert.deepEqual(f.calls.map(call => call.failedTurnId), [scope.turnId, "fresh-1", "fresh-2", "fresh-3"]);
  assert.match(f.terminal[0].text, /4 次容量自动恢复上限/);
});

for (const change of ["cancel", "unbind", "stop", "backend"] as const) test(`${change} during reconciliation cannot schedule a late continuation`, async t => {
  let release!: (value: CodexThreadSnapshot) => void;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  f.coordinator.offer(scope);
  if (change === "cancel") f.coordinator.cancel("thread");
  if (change === "unbind") f.setEligible(false);
  if (change === "stop") f.coordinator.stop();
  if (change === "backend") f.backend.backendInfo = () => ({ id: "exec" } as never);
  release(snapshot()); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 0); assert.equal(f.saved().attempts, 3);
});

test("timed-out reconciliation releases its pending claim without an execution write", async t => {
  const f = fixture(t, () => new Promise(() => {}));
  f.coordinator.offer(scope); await until(() => f.terminal.length === 1);
  assert.equal(f.calls.length, 0); assert.equal(f.coordinator.holdsStart(scope), false); assert.equal(f.saved().status, "uncertain");
});

test("restart retires proved-ended recovery read-only, without scanning history to start new work", async t => {
  const f = fixture(t); f.coordinator.start();
  await until(() => !f.coordinator.hasPending("thread", "local"));
  assert.equal(f.saved().status, "finished"); assert.equal(f.saved().closedBy.turnId, "old-retry");
  assert.equal(f.calls.length, 0); assert.equal(f.terminal.length, 0);
});

test("a late old failure cannot cancel a waiting new chain", async t => {
  const f = fixture(t); f.options.delaysMs.splice(0, f.options.delaysMs.length, 1000);
  f.coordinator.offer(scope); await until(() => f.saved().turnId === scope.turnId);
  assert.equal(f.coordinator.offer({ ...scope, turnId: "old-failure" }), true);
  assert.equal(f.saved().turnId, scope.turnId); assert.equal(f.saved().status, "waiting");
});

test("an old waiting timer cannot race a replacement proof into an execution write", async t => {
  let release!: (value: CodexThreadSnapshot) => void;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }), { status: "waiting", acceptedTurnId: undefined, cancelFuture: false });
  f.coordinator.start(); f.coordinator.offer(scope);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.calls.length, 0);
  release(snapshot()); await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].failedTurnId, scope.turnId);
});

test("rejecting a stale offered failure does not swallow the original waiting timer", async t => {
  let release!: (value: CodexThreadSnapshot) => void;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }), { status: "waiting", acceptedTurnId: undefined, cancelFuture: false });
  f.coordinator.start(); f.coordinator.offer(scope);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.calls.length, 0);
  const value = snapshot(); value.turns.pop(); value.turns[1].status = "failed";
  value.state.lastTurnFailure = { turnId: "old-retry", code: "model-capacity" };
  release(value); await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].failedTurnId, "old-retry");
});
