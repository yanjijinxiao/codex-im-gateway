import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CapacityRecoveryCoordinator } from "../src/server/capacity-recovery.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import type { CodexBridgeBackend, CodexThreadSnapshot } from "../src/codex/backend.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error("Startup projection condition timed out");
}

for (const status of ["finished", "cancelled"] as const) test(`${status} history cannot replay acceptance; an archived false recovery card is corrected in place`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-capacity-startup-"));
  const capFile = path.join(root, "capacity.json"), followFile = path.join(root, "follow.json"), key = JSON.stringify(["remote", "thread"]);
  fs.writeFileSync(capFile, JSON.stringify({ records: { [key]: { hostId: "remote", threadId: "thread", turnId: "historical-accepted", backend: "app-server",
    turns: ["historical-failure", "historical-accepted"], acceptedTurnId: "historical-accepted", status, attempts: 1, nextAt: 0 } } }));
  fs.writeFileSync(followFile, JSON.stringify({ binding: { eventVersion: 2, deliveryVersion: 1, hostId: "remote", threadId: "thread",
    turnId: "historical-accepted", checkpointTurnId: "historical-accepted", sequence: 0, initialized: true, delivered: [], completed: ["historical-failure", "later-completed"], baseline: [],
    historyBoundary: { version: 1, turnId: "later-completed", startedAt: new Date().toISOString() },
    checkpoint: { streamId: "wrong-stream", messageId: "existing-wrong-card", startedAt: Date.now(), progressEntries: [], thought: "", answerPreview: "",
      finished: false, activity: "unconfirmed", statusHeader: true } } }));
  let writes = 0, accepted = 0;
  const updates: Array<{ messageId: string; text: string; finalize?: boolean }> = [];
  const backend = { backendInfo: () => ({ id: "app-server" }), async readThreadSnapshot(): Promise<CodexThreadSnapshot> {
    return { state: { threadId: "thread", persistence: "archived", runtimeStatus: "notLoaded", activeFlags: [] }, turns: [] };
  }, async resumeAfterCapacity() { writes++; throw Error("never execute archived history"); } } as unknown as CodexBridgeBackend;
  const sub: ThreadSubscription = { key: "binding", hostId: "remote", threadId: "thread", recipientId: "chat", managed: false,
    client: { resumableTextStream: true, async sendText() { throw Error("no extra messages"); }, async startTextStream() { throw Error("no new cards"); },
      async updateTextStream(input) { updates.push(input); } } };
  let hub = new ThreadEventHub({ filePath: followFile, subscriptions: () => [sub], backend: () => backend });
  const makeCoordinator = () => new CapacityRecoveryCoordinator({ filePath: capFile, backend: () => backend, eligible: () => true,
    async notice() {}, async progress() {}, async terminal() { throw Error("no synthetic native completion"); }, async accepted() { accepted++; },
    retireProjection: (scope, text) => hub.retireCapacityProjection(scope, text) });
  let coordinator = makeCoordinator();
  t.after(async () => { coordinator.stop(); await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  coordinator.start(); await until(() => updates.length === 1);
  assert.equal(accepted, 0); assert.equal(writes, 0);
  assert.equal(updates[0].messageId, "existing-wrong-card"); assert.equal(updates[0].finalize, true);
  assert.match(updates[0].text, /状态已纠正/); assert.match(updates[0].text, /本次没有启动新的任务/);
  assert.doesNotMatch(updates[0].text, /\/stop|打开项目 Web IDE|任务已完成|正在恢复执行/);
  const state = JSON.parse(fs.readFileSync(followFile, "utf8")).binding;
  assert.equal(state.checkpoint.finished, true); assert.equal(state.checkpoint.presentationCorrection.delivered, true);
  assert.equal(state.checkpoint.terminal, undefined); assert.deepEqual(state.completed, ["historical-failure", "later-completed"]);
  assert.equal(JSON.parse(fs.readFileSync(capFile, "utf8")).records[key].attempts, 1);
  coordinator.stop(); await hub.stop();
  hub = new ThreadEventHub({ filePath: followFile, subscriptions: () => [sub], backend: () => backend });
  coordinator = makeCoordinator(); coordinator.start(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(updates.length, 1); assert.equal(writes, 0); assert.equal(accepted, 0);
});

test("an unfinished latest result card cannot be invalidated as historical recovery", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-capacity-latest-card-")), file = path.join(root, "follow.json");
  fs.writeFileSync(file, JSON.stringify({ binding: { eventVersion: 2, deliveryVersion: 1, hostId: "local", threadId: "thread",
    turnId: "latest", checkpointTurnId: "latest", sequence: 0, initialized: true, delivered: [], completed: [], baseline: [],
    historyBoundary: { version: 1, turnId: "latest", startedAt: new Date().toISOString() },
    checkpoint: { streamId: "latest-stream", messageId: "latest-card", startedAt: 1, progressEntries: [], thought: "", answerPreview: "", finished: false } } }));
  let updates = 0;
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
    client: { resumableTextStream: true, async sendText() { throw Error("no extra message"); }, async updateTextStream() { updates++; } } };
  const hub = new ThreadEventHub({ filePath: file, subscriptions: () => [sub], backend: () => ({} as never) });
  t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.retireCapacityProjection({ hostId: "local", threadId: "thread", turnId: "latest" }, "not authorized for this latest result");
  assert.equal(updates, 0); assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).binding.checkpoint.finished, false);
});

for (const persistence of ["active", "archived", "unknown"] as const) test(`startup ${persistence} observation cannot manufacture an active recovery from uncertain history`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-capacity-proof-")), file = path.join(root, "recovery.json"), key = JSON.stringify(["local", "thread"]);
  fs.writeFileSync(file, JSON.stringify({ records: { [key]: { hostId: "local", threadId: "thread", turnId: "accepted", backend: "app-server",
    turns: ["failure", "accepted"], acceptedTurnId: "accepted", status: "uncertain", attempts: 1, nextAt: 0 } } }));
  let accepted = 0, writes = 0;
  const coordinator = new CapacityRecoveryCoordinator({ filePath: file, eligible: () => true,
    backend: () => ({ backendInfo: () => ({ id: "app-server" }), async readThreadSnapshot() { return {
      state: { threadId: "thread", persistence, runtimeStatus: "notLoaded", activeFlags: [] }, turns: [{ id: "accepted", status: "inProgress", messages: [] }] }; },
      async resumeAfterCapacity() { writes++; } }) as never,
    async accepted() { accepted++; }, async notice() {}, async progress() {}, async terminal() {} });
  t.after(() => { coordinator.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  coordinator.start(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(accepted, 0); assert.equal(writes, 0);
});

test("startup projects only the exact currently running accepted native turn, never the full historical chain", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-capacity-live-proof-")), file = path.join(root, "recovery.json"), key = JSON.stringify(["local", "thread"]);
  fs.writeFileSync(file, JSON.stringify({ records: { [key]: { hostId: "local", threadId: "thread", turnId: "accepted", backend: "app-server",
    turns: ["old-failure", "old-retry", "failure", "accepted"], acceptedTurnId: "accepted", status: "running", attempts: 3, nextAt: 0 } } }));
  const projections: string[][] = [];
  const coordinator = new CapacityRecoveryCoordinator({ filePath: file, eligible: () => true, backend: () => ({
    backendInfo: () => ({ id: "app-server" }), async readThreadSnapshot() { return { state: { threadId: "thread", persistence: "active", runtimeStatus: "active",
      activeTurnId: "accepted", activeFlags: [] }, turns: [{ id: "accepted", status: "inProgress", messages: [] }] }; },
    async resumeAfterCapacity() { throw Error("do not restart an active task"); } }) as never,
    async accepted(scope, turn) { projections.push([scope.turnId, turn]); }, async notice() {}, async progress() {}, async terminal() {} });
  t.after(() => { coordinator.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  coordinator.start(); await until(() => projections.length === 1);
  assert.deepEqual(projections, [["failure", "accepted"]]);
});
