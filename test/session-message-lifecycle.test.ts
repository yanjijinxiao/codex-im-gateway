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
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

function fixture(t: test.TestContext, channel: "dingtalk" | "weixin" | "feishu" = "dingtalk", backend: "app-server" | "exec" = "app-server") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-message-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(path.join(root, "state"));
  const store = new RuntimeStateStore(paths);
  const project = store.createProject("Project", root);
  const session = store.createSession("chat", root, "Original", project.id);
  store.setSessionThread(session.id, "thread");
  const texts: string[] = [], cards: ChannelActionCard[] = [], runs: CodexRunnerInput[] = [];
  let subscriptionsChanged = 0, steers = 0, sequence = 0;
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
      async getRuntimeInfo() { return {}; },
      async getHistory() { return []; }
    } as never
  });
  let service = build();
  return { paths, store, project, session, texts, cards, runs,
    get changes() { return subscriptionsChanged; }, get steers() { return steers; },
    setState(next: Partial<CodexThreadState>) { state = { ...state, ...next }; },
    setRun(fn: typeof runImpl) { runImpl = fn; },
    restart() { service = build(new RuntimeStateStore(paths)); },
    send(text: string) { return service.handleMessage({ id: String(++sequence), senderId: "actor", replyTargetId: "chat", text, attachments: [], raw: {} }); }
  };
}

for (const channel of ["dingtalk", "weixin", "feishu"] as const) {
  for (const backend of ["app-server", "exec"] as const) {
    test(`${channel}/${backend}: a plain message asks while busy and never silently starts or steers`, async t => {
      const f = fixture(t, channel, backend);
      await f.send("你是 GPT？");
      assert.equal(f.runs.length, 0);
      assert.equal(f.steers, 0);
      const card = f.cards.at(-1)!;
      assert.equal(card.title, "当前任务正在执行");
      const choices = card.actionGroups.flat();
      assert.equal(choices.some(x => x.value.arg.endsWith(" steer")), backend === "app-server");
      const queued = choices.find(x => x.value.arg.endsWith(" queue"))!;
      // The original turn can finish before the user chooses the next round.
      f.setState({ runtimeStatus: "idle", activeTurnId: undefined });
      await f.send("/intervene " + queued.value.arg);
      assert.equal(f.runs.length, 1);
      assert.match(f.runs[0].prompt, /你是 GPT？/);
      assert.equal(f.steers, 0);
    });
  }
}

test("Desktop-owned normal messages offer queue/cancel, and an orphan UI tail is not submitted", async t => {
  const f = fixture(t);
  f.setState({ executionOwner: "desktop" });
  await f.send("你是 GPT？");
  assert.ok(f.cards.at(-1)!.actionGroups.flat().every(x => !x.value.arg.endsWith(" steer")));
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

test("/leave remains detached after restart; /new explicitly rebinds and refreshes following", async t => {
  const f = fixture(t);
  await f.send("/leave");
  assert.equal(f.changes, 1);
  f.restart();
  await f.send("你是 GPT？");
  assert.equal(f.runs.length, 0);
  assert.match(f.texts.at(-1)!, /已退出会话.*未发送/);
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
