import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import type { ChannelActionCard } from "../src/channels/action-card.js";
import type { CodexHistoryPageInput, CodexSteerInput } from "../src/codex/backend.js";

test("enforces roles on commands, scopes pending choices, rejects stale turns and pages history", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-intervention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(path.join(root, "state"));
  const store = new RuntimeStateStore(paths);
  const project = store.createProject("project", root);
  const session = store.createSession("chat", root, "session", project.id);
  store.setSessionThread(session.id, "thread");
  const replies: string[] = [], cards: ChannelActionCard[] = [];
  const steers: CodexSteerInput[] = [], reads: CodexHistoryPageInput[] = [];
  let turnId = "turn-original", subscriptionsChanged = 0, runs = 0, stops = 0;
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["admin", "chat"], codexBackend: "app-server", streamReplies: false },
    stateStore: store,
    onSubscriptionsChanged: async () => { subscriptionsChanged++; },
    weixin: {
      async sendText(input) { replies.push(input.text); return { messageId: "reply" }; },
      async sendActionCard(input) { cards.push(input.card); return { messageId: "choice" }; }
    },
    runner: {
      async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: "active", activeTurnId: turnId, activeFlags: [] }; },
      async getHistoryPage(_thread: string, input: CodexHistoryPageInput) {
        reads.push(input);
        return input.cursor ? {
          messages: [{ id: "old", role: "user", text: "更早的输入" }]
        } : {
          messages: [{ id: "recent", role: "assistant", text: "最近的结论" }],
          nextCursor: "older-snapshot-cursor"
        };
      },
      async steer(input: CodexSteerInput) { steers.push(input); return { status: "accepted", threadId: "thread", turnId: input.expectedTurnId }; },
      async run() { runs++; return { threadId: "thread", turnId: "next", text: "完成", raw: "" }; },
      async stop() { stops++; return "interrupted"; }
    } as never
  });
  let sequence = 0;
  const send = (actor: string, text: string, id = String(++sequence)) => service.handleMessage({
    id, senderId: actor, replyTargetId: "chat", text, attachments: [], raw: {}
  });
  await send("admin", "/role alice viewer");
  await send("alice", "/steer 无权插话");
  await send("alice", "/queue 无权排队");
  await send("alice", "/approve A1");
  assert.equal(steers.length, 0);
  assert.equal(runs, 0);
  assert.match(replies.at(-1)!, /需要 controller/);
  await send("alice", "/history 1");
  assert.match(replies.at(-1)!, /最近的结论/);
  await send("alice", "/history more");
  assert.match(replies.at(-1)!, /更早的输入/);
  assert.doesNotMatch(replies.at(-1)!, /最近的结论/);
  assert.equal(reads[1].cursor, "older-snapshot-cursor");
  await send("admin", "/role bob participant");
  await send("bob", "/stop");
  assert.equal(stops, 0);
  await send("bob", "先检查接口");
  assert.equal(cards.at(-1)!.title, "当前任务正在执行");
  const arg = cards.at(-1)!.actionGroups.flat()[0].value.arg;
  await assert.rejects(send("admin", "/intervene " + arg), /不属于/);
  turnId = "turn-new";
  await send("bob", "/intervene " + arg);
  assert.equal(steers.length, 0, "a stale choice must not write into a newer turn");
  assert.match(replies.at(-1)!, /已结束或发生切换/);
  await send("bob", "/policy steer");
  await send("bob", "新的介入", "stable-message");
  await send("bob", "新的介入", "stable-message");
  assert.equal(steers.length, 1);
  assert.equal(steers[0].expectedTurnId, "turn-new");
  await send("bob", "/follow off");
  assert.equal(store.getActiveSession("chat")!.follow, false);
  await send("bob", "/leave");
  assert.equal(store.getActiveSession("chat"), undefined);
  assert.equal(subscriptionsChanged, 2);
  const restored = new RuntimeStateStore(paths);
  assert.equal(restored.roleFor("chat", "alice"), "viewer");
});
