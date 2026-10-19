import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import type { ChannelActionCard } from "../src/channels/action-card.js";
import { APP_SERVER_BACKEND_CAPABILITIES, EXEC_BACKEND_CAPABILITIES,
  type CodexRunnerInput, type CodexThreadState } from "../src/codex/backend.js";
import type { CodexThreadMessageInput, CodexInputReceipt } from "../src/codex/backend.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

function fixture(t: test.TestContext, channel: "dingtalk" | "weixin" | "feishu" = "dingtalk", backend: "app-server" | "exec" = "app-server", nativeThreadMessages = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-message-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(path.join(root, "state"));
  const store = new RuntimeStateStore(paths);
  const project = store.createProject("Project", root);
  const session = store.createSession("chat", root, "Original", project.id);
  store.setSessionThread(session.id, "thread");
  const texts: string[] = [], cards: ChannelActionCard[] = [], runs: CodexRunnerInput[] = [];
  let subscriptionsChanged = 0, steers = 0, sequence = 0;
  const queued: Array<{ id: string; clientUserMessageId: string; input: Array<{ type: string; text: string }> }> = [];
  const threadMessages: CodexThreadMessageInput[] = [];
  let threadMessageImpl = async (input: CodexThreadMessageInput): Promise<CodexInputReceipt> => {
    input.assertCurrent?.(); threadMessages.push(input);
    return { status: "accepted", threadId: input.threadId, turnId: "native-turn" };
  };
  let state: CodexThreadState = { threadId: "thread", persistence: "active", runtimeStatus: "active", activeFlags: [], activeTurnId: "old-turn" };
  let runImpl = async (input: CodexRunnerInput) => ({ threadId: input.threadId ?? "new-thread", turnId: "new-turn", text: "完成", raw: "" });
  const build = (stateStore = store) => new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["actor"], codexBackend: backend, streamReplies: false },
    stateStore,
    channel: createChannelClient(channel, { ...TEXT_CAPABILITIES, actions: "available" }, {
      async sendText(x) { texts.push(x.text); return { messageId: String(texts.length) }; },
      async sendActionCard(x) { cards.push(x.card); return { messageId: "card" }; }
    }),
    onSubscriptionsChanged: () => { subscriptionsChanged++; },
    runner: {
      backendInfo() { return { id: backend, capabilities: backend === "exec" ? EXEC_BACKEND_CAPABILITIES : APP_SERVER_BACKEND_CAPABILITIES }; },
      async inspectThread() { return state; },
      async run(input: CodexRunnerInput) { runs.push(input); return runImpl(input); },
      async steer() { steers++; return { status: "accepted", threadId: "thread", turnId: "old-turn" }; },
      ...(nativeThreadMessages ? { submitThreadMessage: (input: CodexThreadMessageInput) => threadMessageImpl(input) } : {}),
      async getRuntimeInfo() { return {}; },
      async getHistory() { return []; },
      async getHistoryPage() { return { messages: [] }; },
      async addQueuedSubmission(input: { prompt: string; clientUserMessageId: string }) {
        const item = { id: "queue-" + (queued.length + 1), clientUserMessageId: input.clientUserMessageId,
          input: [{ type: "text", text: input.prompt }] };
        queued.push(item); return item;
      },
      async listQueuedSubmissions() { return { data: queued }; },
      async runQueuedSubmission(input: CodexRunnerInput & { queuedSubmissionId: string; onQueueStarting?: () => void }) {
        input.onQueueStarting?.();
        await input.onTurnStarted?.({ threadId: input.threadId!, turnId: "queue-turn" });
        const entry = queued.shift()!;
        const run = { ...input, prompt: entry.input[0].text }; runs.push(run); return runImpl(run);
      }
    } as never
  });
  let service = build();
  return { paths, store, project, session, texts, cards, runs, queued, threadMessages,
    get changes() { return subscriptionsChanged; }, get steers() { return steers; },
    setState(next: Partial<CodexThreadState>) { state = { ...state, ...next }; },
    setRun(fn: typeof runImpl) { runImpl = fn; },
    setThreadMessage(fn: typeof threadMessageImpl) { threadMessageImpl = fn; },
    restart() { service = build(new RuntimeStateStore(paths)); },
    send(text: string, id = String(++sequence)) { return service.handleMessage({ id, senderId: "actor", replyTargetId: "chat", text, attachments: [], raw: {} }); }
  };
}

for (const channel of ["dingtalk", "weixin", "feishu"] as const) {
  for (const backend of ["app-server", "exec"] as const) {
    test(`${channel}/${backend}: a plain message asks while busy and never silently starts or steers`, async t => {
      const f = fixture(t, channel, backend);
      f.store.setActiveMessagePolicy(f.session.id, "ask");
      await f.send("你是 GPT？");
      assert.equal(f.runs.length, 0);
      assert.equal(f.steers, 0);
      if (backend === "exec") {
        assert.equal(f.cards.length, 0); assert.match(f.texts.at(-1)!, /不支持.*消息未提交/);
        await f.send("/policy queue");
        assert.match(f.texts.at(-1)!, /不支持.*原生队列.*策略未改变/);
        assert.equal(f.store.getSession(f.session.id)?.activeMessagePolicy, "ask");
        return;
      }
      const card = f.cards.at(-1)!;
      assert.equal(card.title, "当前任务正在执行");
      const choices = card.actionGroups.flat();
      assert.equal(choices.some(x => x.value.arg.endsWith(" steer")), backend === "app-server");
      const queued = choices.find(x => x.value.arg.endsWith(" queue"))!;
      // The original turn can finish before the user chooses the next round.
      f.setState({ runtimeStatus: "idle", activeTurnId: undefined });
      await f.send("/intervene " + queued.value.arg);
      for (let n = 0; n < 100 && !f.runs.length; n++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(f.runs.length, 1);
      assert.match(f.runs[0].prompt, /你是 GPT？/);
      assert.equal(f.steers, 0);
    });
  }
}

test("Desktop-owned messages do not offer unsupported actions; an orphan UI tail is not submitted", async t => {
  const f = fixture(t);
  f.store.setActiveMessagePolicy(f.session.id, "ask");
  f.setState({ executionOwner: "desktop" });
  await f.send("你是 GPT？");
  assert.equal(f.cards.length, 0); assert.match(f.texts.at(-1)!, /不支持.*消息未提交/);
  await f.send("/policy queue");
  assert.match(f.texts.at(-1)!, /不支持.*原生队列.*策略未改变/);
  await f.send("/policy steer");
  assert.match(f.texts.at(-1)!, /不支持安全介入.*策略未改变/);
  assert.equal(f.store.getSession(f.session.id)?.activeMessagePolicy ?? "ask", "ask");
  await f.send("补充一条");
  assert.equal(f.runs.length, 0);
  assert.equal(f.steers, 0);
  f.setState({ runtimeStatus: "idle", activeTurnId: undefined, pendingTurnWithoutId: true });
  await f.send("/policy ask");
  await f.send("你是 GPT？");
  assert.equal(f.runs.length, 0);
  assert.match(f.texts.at(-1)!, /实际任务已空闲.*消息未提交/);
  await f.send("/status");
  assert.match(f.cards.at(-1)!.body, /状态异常.*实际后端空闲/);
});

for (const channel of ["dingtalk", "weixin", "feishu"] as const) {
  test(`${channel}: ordinary busy Desktop input uses the native conversation port, not /steer or queue`, async t => {
    const f = fixture(t, channel, "app-server", true); f.setState({ executionOwner: "desktop" });
    await f.send("补充要求", "same-im-message");
    assert.equal(f.threadMessages.length, 1); assert.match(f.threadMessages[0].prompt, /补充要求/);
    assert.equal(f.threadMessages[0].threadId, "thread"); assert.equal(f.threadMessages[0].clientUserMessageId, "same-im-message");
    assert.equal("expectedTurnId" in f.threadMessages[0], false);
    assert.match(f.texts.at(-1)!, /原 Codex 会话接收.*\nTurn：native-turn/);
    f.restart(); await f.send("补充要求", "same-im-message");
    assert.equal(f.threadMessages.length, 1, "accepted native input is not replayed after restart");
    await f.send("/policy steer"); assert.match(f.texts.at(-1)!, /运行中消息处理方式：steer/);
    await f.send("/steer 仅介入指定任务"); assert.match(f.texts.at(-1)!, /不支持指定轮次的安全介入/);
    assert.equal(f.threadMessages.length, 1); assert.equal(f.steers, 0); assert.equal(f.runs.length, 0);
    assert.equal(f.queued.length, 0); assert.equal(f.cards.length, 0);
  });
  test(`${channel}: the default busy-message policy is steer, with no ask card or new turn`, async t => {
    const f = fixture(t, channel);
    await f.send("补充要求");
    assert.equal(f.steers, 1); assert.equal(f.runs.length, 0); assert.equal(f.cards.length, 0);
    await f.send("/policy"); assert.match(f.texts.at(-1)!, /steer/);
  });
  test(`${channel}: explicit queue is native, returns promptly while busy, and survives restart`, async t => {
    const f = fixture(t, channel);
    await f.send("/queue 下一轮内容");
    assert.equal(f.queued.length, 1); assert.equal(f.runs.length, 0); assert.equal(f.steers, 0);
    f.restart(); await f.send("/queue list"); assert.match(f.texts.at(-1)!, /queue-1.*queued/);
  });
}

test("unknown native ordinary-message receipts are not replayed on gateway restart", async t => {
  const f = fixture(t, "dingtalk", "app-server", true); f.setState({ executionOwner: "desktop" });
  let writes = 0;
  f.setThreadMessage(async () => { writes++; throw new Error("IPC connection closed before response"); });
  await assert.rejects(f.send("follow-up", "lost-receipt"));
  f.restart(); await assert.rejects(f.send("follow-up", "lost-receipt"), /结果尚未确认/);
  assert.equal(writes, 1); assert.equal(f.runs.length, 0); assert.equal(f.queued.length, 0);
  assert.equal(f.store.getActiveSession("chat")?.threadId, "thread");
});

test("ordinary message input rejects a cross-thread receipt and retains it as uncertain", async t => {
  const f = fixture(t, "dingtalk", "app-server", true); f.setState({ executionOwner: "desktop" });
  let writes = 0;
  f.setThreadMessage(async () => { writes++; return { status: "accepted", threadId: "other-thread", turnId: "turn" }; });
  await assert.rejects(f.send("message", "invalid-scope"), { name: "CodexCommunicationError", submission: "unconfirmed" });
  f.restart(); await assert.rejects(f.send("message", "invalid-scope"), /结果尚未确认/);
  assert.equal(writes, 1); assert.equal(f.runs.length, 0); assert.equal(f.store.getActiveSession("chat")?.threadId, "thread");
});

test("binding changes during native ordinary-message preflight invalidate the write", async t => {
  const f = fixture(t, "dingtalk", "app-server", true); f.setState({ executionOwner: "desktop" });
  let release!: () => void, entered!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  f.setThreadMessage(async input => {
    entered(); await gate; input.assertCurrent?.(); writes++;
    return { status: "accepted", threadId: input.threadId, turnId: "turn" };
  });
  const message = f.send("ordinary message");
  // Attach a rejection handler before releasing the suspended preflight.
  const rejected = assert.rejects(message, /绑定已切换/);
  await starting; await f.send("/new"); release(); await rejected;
  assert.equal(writes, 0); assert.equal(f.runs.length, 0); assert.equal(f.queued.length, 0);
  assert.notEqual(f.store.getActiveSession("chat")?.id, f.session.id);
  assert.equal(f.store.getSession(f.session.id)?.threadId, "thread");
});

test("default steer never silently falls back for Desktop or exec", async t => {
  const desktop = fixture(t); desktop.setState({ executionOwner: "desktop" });
  await desktop.send("补充要求");
  assert.match(desktop.texts.at(-1)!, /不支持.*安全介入.*未提交/);
  assert.equal(desktop.runs.length, 0); assert.equal(desktop.steers, 0);
  const exec = fixture(t, "weixin", "exec");
  await exec.send("补充要求");
  assert.match(exec.texts.at(-1)!, /不支持.*消息未提交/);
  assert.equal(exec.runs.length, 0);
});

test("/leave remains detached after restart; /new explicitly rebinds and refreshes following", async t => {
  const f = fixture(t);
  await f.send("/leave");
  assert.equal(f.changes, 1);
  f.restart();
  await f.send("你是 GPT？");
  assert.equal(f.runs.length, 0);
  assert.match(f.texts.at(-1)!, /未绑定任何 session.*未提交/);
  await f.send("/new");
  const restored = new RuntimeStateStore(f.paths);
  assert.equal(restored.isSessionDetached("chat"), false);
  assert.notEqual(restored.getActiveSession("chat")?.id, f.session.id);
  assert.equal(f.changes, 2);
});

test("switching bindings leaves the task running but does not deliver its old answer to the new binding", async t => {
  const f = fixture(t);
  f.setState({ runtimeStatus: "idle", activeTurnId: undefined });
  let resolveRun!: (result: { threadId: string; turnId: string; text: string; raw: string }) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.setRun(async () => { entered(); return new Promise(resolve => { resolveRun = resolve; }); });
  const turn = f.send("开始工作");
  await started;
  await f.send("/new");
  resolveRun({ threadId: "thread", turnId: "real-turn", text: "OLD_RESULT_MUST_NOT_DELIVER", raw: "" });
  await turn;
  assert.ok(f.texts.every(x => !x.includes("OLD_RESULT_MUST_NOT_DELIVER")));
  assert.notEqual(f.store.getActiveSession("chat")?.id, f.session.id);
  assert.equal(f.store.getSession(f.session.id)?.threadId, "thread");
});
