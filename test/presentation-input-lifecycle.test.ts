import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { SessionControlJournal } from "../src/bridge/session-control.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexThreadSnapshot, type CodexQueuedRunInput } from "../src/codex/backend.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

async function until(condition: () => boolean) {
  for (let n = 0; n < 200 && !condition(); n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(condition());
}
function fixture(t: test.TestContext, channel: "dingtalk" | "weixin" | "feishu" = "dingtalk") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-input-presentation-"));
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const session = store.createSession("room", root, "task", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(session.id, "thread");
  const starts: Array<{ text: string; streamId?: string }> = [], updates: Array<{ text: string; messageId: string; finalize?: boolean }> = [];
  const prepared: Array<string | undefined> = [], statuses: boolean[] = [];
  let snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "active", activeFlags: [], activeTurnId: "turn" },
    turns: [{ id: "turn", status: "inProgress", messages: [{ id: "before", role: "assistant", kind: "progress", text: "之前的公开进展" }] }] };
  let failNative = false, failPresentation = false, nativeWrites = 0, managed = false;
  const client = createChannelClient(channel, { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true }, {
    async sendText() { return { messageId: "notice" }; },
    async startTextStream(input) { starts.push(input); return { messageId: input.streamId! }; },
    async updateTextStream(input) { updates.push(input); }
  });
  const items: Array<{ id: string; clientUserMessageId: string; input: Array<{ type: string; text: string }> }> = [];
  let queuedRun = async (_input: CodexQueuedRunInput) => { throw new Error("not configured"); };
  const backend = {
    backendInfo() { return { id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }; },
    async inspectThread() { return snapshot.state; }, async getHistory() { return []; },
    async steer() { nativeWrites++; if (failNative) throw new Error("lost receipt"); return { status: "accepted", threadId: "thread", turnId: "turn" }; },
    async submitThreadMessage() { return backend.steer(); },
    async run() { throw new Error("must not start a task for a presentation boundary"); },
    async addQueuedSubmission(input: { prompt: string; clientUserMessageId: string }) {
      const item = { id: "queued", clientUserMessageId: input.clientUserMessageId, input: [{ type: "text", text: input.prompt }] };
      items.push(item); return item;
    }, async listQueuedSubmissions() { return { data: items }; },
    async runQueuedSubmission(input: CodexQueuedRunInput) { return queuedRun(input); }
  };
  const controls = new SessionControlJournal(path.join(root, "controls.json"));
  let service!: BridgeService;
  const sub = (): ThreadSubscription => ({ key: "binding", hostId: "local", threadId: "thread", recipientId: "room", client, managed,
    enabled: store.getActiveSession("room")?.id === session.id && store.getSession(session.id)?.threadId === "thread" });
  const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), subscriptions: () => [sub()],
    backend: () => ({ async readThreadSnapshot() { return snapshot; } }),
    acceptedInputs: () => [...controls.acceptedPresentationInputs(), ...service.acceptedPresentationInputs()] });
  service = new BridgeService({ stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, channel: client,
    runner: backend as never, sessionControls: controls,
    onAcceptedInput: async input => { if (failPresentation) throw new Error("display interrupted"); await hub.acceptedInput(input); },
    createTextStream: (s, turnId) => { prepared.push(turnId); return hub.prepareManagedStream({ ...sub(), managed: true }, turnId); },
    onTurnStatus: input => { statuses.push(input.active); managed = input.active; },
    onTurnStarted: (s, turnId) => hub.managedTurnStarted({ ...sub(), managed: true }, turnId),
    deliverTurnResult: (s, turnId, text) => hub.managedCompletion({ ...sub(), managed: true }, turnId, text)
  });
  t.after(async () => { service.suspendUserInputs(); await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { starts, updates, prepared, statuses, service, hub, controls, items, store, session,
    get nativeWrites() { return nativeWrites; },
    failNative() { failNative = true; }, failPresentation(value: boolean) { failPresentation = value; },
    setSnapshot(value: CodexThreadSnapshot) { snapshot = value; },
    setQueuedRun(fn: (input: CodexQueuedRunInput) => Promise<any>) { queuedRun = fn; },
    send(text: string, id = text) { return service.handleMessage({ id, senderId: "actor", replyTargetId: "room", text, raw: {} }); }
  };
}

for (const channel of ["dingtalk", "weixin", "feishu"] as const) test(`${channel}: confirmed steer cuts once; recovery projections and other hosts cannot cut again`, async t => {
  const f = fixture(t, channel); await f.hub.refresh();
  await f.send("/steer 补充要求", "native-input"); await f.send("/steer 补充要求", "native-input");
  assert.equal(f.nativeWrites, 1); assert.equal(f.starts.length, 2);
  assert.ok(f.updates.some(update => update.messageId === f.starts[0].streamId && update.finalize && update.text.includes("阶段小结")));
  await f.hub.refresh(); assert.equal(f.starts.length, 2);
  const [receipt] = f.controls.acceptedPresentationInputs();
  await f.hub.acceptedInput({ ...receipt, id: "other-host", hostId: "remote" });
  await f.hub.acceptedInput({ ...receipt, id: "old-turn", turnId: "another-turn" });
  assert.equal(f.starts.length, 2);
  assert.equal(f.hub.status("binding").resultDelivery?.lastDeliveredTurnId, undefined);
});

test("uncertain steer does not produce a boundary or close the existing card", async t => {
  const f = fixture(t); await f.hub.refresh(); f.failNative();
  await assert.rejects(f.send("/steer 补充", "uncertain"));
  await f.hub.refresh(); assert.equal(f.starts.length, 1);
  assert.deepEqual(f.controls.acceptedPresentationInputs(), []);
  assert.equal(f.updates.some(update => update.finalize), false);
});

test("native acceptance survives a presentation callback failure and recovers from the SAME control journal without submitting again", async t => {
  const f = fixture(t); await f.hub.refresh(); f.failPresentation(true);
  await f.send("/steer 补充", "confirmed-before-crash"); assert.equal(f.starts.length, 1);
  f.failPresentation(false); await f.hub.refresh(); assert.equal(f.starts.length, 2);
  await f.hub.refresh(); assert.equal(f.starts.length, 2); assert.equal(f.nativeWrites, 1);
});

test("first follow baselines historical accepted inputs rather than creating a burst of retrospective cards", async t => {
  const f = fixture(t);
  await f.controls.submit(JSON.stringify(["local", "thread"]), "old", async () => ({ status: "accepted", threadId: "thread", turnId: "turn" }), "local");
  await f.hub.refresh(); assert.equal(f.starts.length, 1);
  await f.hub.acceptedInput(f.controls.acceptedPresentationInputs()[0]); assert.equal(f.starts.length, 1);
  await f.send("/steer 新补充", "new-input"); assert.equal(f.starts.length, 2);
});

test("detaching while a native queue item waits does not cancel or replay it and cannot create another IM card", async t => {
  const f = fixture(t); await f.hub.refresh();
  let entered!: () => void, start!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const canStart = new Promise<void>(resolve => { start = resolve; });
  let consumptions = 0;
  f.setQueuedRun(async input => {
    entered(); input.onQueueStarting?.(); await canStart;
    f.items.shift(); consumptions++;
    await input.onTurnStarted?.({ threadId: "thread", turnId: "queue-turn" });
    await input.onProgress?.("不向已解绑聊天投递");
    await input.onDelta?.("不向已解绑聊天投递");
    return { threadId: "thread", turnId: "queue-turn", text: "原生任务完成", raw: "" };
  });
  await f.send("/queue 已提交的下一轮", "queue-before-detach");
  f.setSnapshot({ state: { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }, turns: [] });
  const running = f.service.recoverNativeQueue(); await preparing;
  await f.send("/unbind");
  start(); await running; await until(() => f.statuses.at(-1) === false);
  assert.equal(consumptions, 1); assert.equal(f.items.length, 0);
  assert.equal(f.prepared.length, 0); assert.equal(f.starts.length, 1);
  assert.equal(f.updates.some(update => update.text.includes("不向已解绑聊天投递") || update.text === "原生任务完成"), false);
  assert.equal(f.store.getBoundSession("room"), undefined);
  assert.equal(f.store.getSession(f.session.id)?.threadId, "thread");
});

test("a queued input does not prepare/close a card or claim a running task until its actual native start", async t => {
  const f = fixture(t); await f.hub.refresh();
  let entered!: () => void, start!: () => void, finish!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const canStart = new Promise<void>(resolve => { start = resolve; });
  const canFinish = new Promise<void>(resolve => { finish = resolve; });
  f.setQueuedRun(async input => {
    entered(); input.onQueueStarting?.(); await canStart;
    f.items.shift();
    await input.onTurnStarted?.({ threadId: "thread", turnId: "queue-turn" });
    await input.onProgress?.("新的原生队列工作"); await input.onDelta?.("队列任务流式答案");
    await canFinish;
    return { threadId: "thread", turnId: "queue-turn", text: "队列完整答案", raw: "" };
  });
  await f.send("/queue 下一轮", "queue-input");
  assert.equal(f.prepared.length, 0); assert.equal(f.starts.length, 1); assert.deepEqual(f.statuses, []);
  f.setSnapshot({ state: { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }, turns: [] });
  const running = f.service.recoverNativeQueue(); await preparing;
  assert.equal(f.prepared.length, 0); assert.equal(f.starts.length, 1);
  assert.equal(f.updates.some(update => update.finalize), false);
  start(); await until(() => f.starts.length === 2);
  assert.deepEqual(f.prepared, ["queue-turn"]); assert.deepEqual(f.statuses, [true]);
  assert.ok(f.updates.some(update => update.finalize && update.text.includes("阶段小结")));
  finish(); await running;
  // enqueue's background dispatcher can own the actual run; this explicit
  // recovery call may correctly return while that existing owner is active.
  await until(() => f.statuses.at(-1) === false);
  assert.equal(f.starts.length, 2);
  assert.equal(f.updates.filter(update => update.messageId === f.starts[1].streamId).at(-1)?.text, "队列完整答案");
  assert.deepEqual(f.statuses, [true, false]);
});
