import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { CapacityRecoveryCoordinator } from "../src/server/capacity-recovery.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { CodexThreadStateError, type CodexThreadSnapshot, type CodexBridgeBackend, type CodexCapacityResumeInput } from "../src/codex/backend.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error("Recovery pipeline timed out");
}

for (const channel of ["dingtalk", "weixin", "feishu", "wecom"] as const) for (const desktop of [false, true]) {
  test(`${channel}/${desktop ? "Desktop" : "App Server"}: new IM input recovers a delivered capacity failure through native acceptance and a new card`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-capacity-preflight-"));
    const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
    const project = store.createProject("Project", root), session = store.createSession("actor", root, "Task", project.id);
    store.setSessionThread(session.id, "thread");
    const notices: string[] = [], starts: string[] = [], updates: Array<{ messageId?: string; text: string; finalize?: boolean }> = [];
    const client = createChannelClient(channel, { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true }, {
      async sendText(input) { notices.push(input.text); return { messageId: "notice" }; },
      async startTextStream(input) { const id = `new-card-${starts.length}`; starts.push(id); return { messageId: id }; },
      async updateTextStream(input) { updates.push(input); }
    });
    const snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "systemError", activeFlags: [],
      ...(desktop ? { executionOwner: "desktop" } : {}), lastTurnFailure: { turnId: "failed-tail", code: "model-capacity" } }, turns: [
      { id: "old-retry", status: "completed", messages: [] }, { id: "failed-tail", status: "failed", messages: [] }] };
    let runs = 0;
    const calls: CodexCapacityResumeInput[] = [];
    const runner = { backendInfo: () => ({ id: "app-server" }), async inspectThread() { return snapshot.state; },
      async readThreadSnapshot() { return snapshot; }, async run() { runs++; throw Error("must not replay new or old prompt"); },
      async resumeAfterCapacity(input: CodexCapacityResumeInput) {
        input.assertCurrent(); calls.push(input);
        await input.onTurnStarted({ threadId: "thread", turnId: "accepted-new" });
        await input.onProgress?.("继续处理原任务");
        return { threadId: "thread", turnId: "accepted-new", text: "原任务继续后的真实结果", raw: "" };
      } } as unknown as CodexBridgeBackend;
    const followFile = path.join(root, "follow.json");
    fs.writeFileSync(followFile, JSON.stringify({ binding: { eventVersion: 2, deliveryVersion: 1, hostId: "local", threadId: "thread",
      turnId: "failed-tail", checkpointTurnId: "failed-tail", sequence: 0, initialized: true, completed: ["failed-tail"], baseline: [], delivered: [],
      checkpoint: { streamId: "old-stream", messageId: "old-failed-card", startedAt: 1, progressEntries: [], thought: "", answerPreview: "", finished: true,
        terminal: { text: "旧失败结果", error: true, outcome: "failed" } } } }));
    const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "actor", client };
    const hub = new ThreadEventHub({ filePath: followFile, subscriptions: () => [sub], backend: () => runner });
    const capFile = path.join(root, "capacity.json"), key = JSON.stringify(["local", "thread"]);
    fs.writeFileSync(capFile, JSON.stringify({ records: { [key]: { hostId: "local", threadId: "thread", turnId: "old-retry", backend: "app-server",
      turns: ["old-failure", "old-retry"], acceptedTurnId: "old-retry", attempts: 3, status: "finished", cancelFuture: true, nextAt: 0 } } }));
    const coordinator = new CapacityRecoveryCoordinator({ filePath: capFile, backend: () => runner, eligible: () => true, delaysMs: [1],
      notice: (scope, text) => hub.capacityNotice(scope, text), accepted: (scope, turn) => hub.capacityAccepted(scope, turn),
      progress: (scope, text) => hub.activity(scope.hostId, scope.threadId, scope.turnId, text),
      terminal: (scope, text, outcome) => hub.capacityTerminal(scope, text, outcome) });
    const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: true }, stateStore: store, channel: client,
      runner, requestCapacityRecovery: (scope, current) => coordinator.request(scope, current) });
    t.after(async () => { coordinator.stop(); await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await service.handleMessage({ id: "retry-message", senderId: "actor", text: "你卡了，恢复原任务", raw: {} });
    await until(() => updates.some(update => update.finalize && update.text.includes("真实结果")));
    assert.equal(runs, 0); assert.equal(calls.length, 1); assert.equal(calls[0].failedTurnId, "failed-tail");
    assert.equal("prompt" in calls[0], false); assert.equal(starts.length, 1);
    assert.equal(updates.some(update => update.messageId === "old-failed-card"), false);
    assert.match(notices.join("\n"), /新消息未提交/);
    const saved = JSON.parse(fs.readFileSync(capFile, "utf8")).records[key];
    assert.equal(saved.status, "finished"); assert.equal(saved.attempts, 1); assert.equal(saved.turnId, "accepted-new");
    assert.equal(store.getBoundSession("actor")?.threadId, "thread");
  });
}

test("IM preflight never sends other system errors to the capacity coordinator", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-noncapacity-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const p = store.createProject("Project", root), session = store.createSession("actor", root, "Task", p.id); store.setSessionThread(session.id, "thread");
  let recoveries = 0;
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, stateStore: store,
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText() { return { messageId: "notice" }; } }),
    runner: { async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: "systemError", activeFlags: [],
      lastTurnFailure: { turnId: "failed", code: "safety-blocked" } }; } } as never,
    async requestCapacityRecovery() { recoveries++; return true; } });
  await assert.rejects(service.handleMessage({ id: "new", senderId: "actor", text: "继续", raw: {} }), CodexThreadStateError);
  assert.equal(recoveries, 0);
});
