import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChoiceCard, formatChannelActionCommand } from "../src/channels/action-card.js";
import { compactTableCell, renderMarkdownTable, renderTextTable } from "../src/channels/table.js";
import { feishuActionCard } from "../src/channels/feishu-action-card.js";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import { DingTalkChannelAdapter, normalizeDingTalkCardContent } from "../src/channels/dingtalk.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

const table = { columns: ["编号", "会话", "归属", "状态"].map(label => ({ label })), rows: [
  ["R1", "【当前】 排查问题", "gateway", "执行中"],
  ["R2", 'a|b\n![x](url) <at id="all">', "无项目", "未知"]
] };
const card = createChoiceCard({ title: "会话 · 2 个", body: "", table, note: "/session R1；/sessions more",
  fallbackText: renderTextTable(table), choices: [{ label: "R1", command: "session", arg: "thread-a --host remote-a" }, { label: "下一页", command: "sessions", arg: "more" }] });

test("table rendering bounds Unicode titles and cannot inject Markdown rows or mentions", () => {
  assert.equal(compactTableCell("a\nb\u202ec", 28), "a b c");
  assert.equal(compactTableCell("👨‍👩‍👧‍👦".repeat(4), 3), "👨‍👩‍👧‍👦👨‍👩‍👧‍👦…");
  const markdown = normalizeDingTalkCardContent("会话\n\n" + renderMarkdownTable(table) + "\n\n选择编号");
  const rows = markdown.split("\n").filter(line => line.startsWith("|"));
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.split("|").length, 6);
  assert.ok(markdown.includes("a｜b"));
  assert.ok(!markdown.includes("<at "));
  assert.ok(!markdown.includes("![x]"));
  assert.ok(markdown.includes("\n\n| 编号 | 会话 | 归属 | 状态 |\n| ---"));
});

test("DingTalk uses a finalized Markdown table without claiming native action buttons", async () => {
  const texts: string[] = [], finals: boolean[] = [];
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "t", clientId: "fake", clientSecret: "fake", cardTemplateId: "fake", savedAt: "", enabled: true }, {
    streamClient: { async getAccessToken() { return "fake"; } } as never,
    cardClient: { async create(x) { texts.push(x.text); }, async update(x) { finals.push(x.finalize); } }
  });
  await adapter.client.sendActionCard({ toUserId: "user", card });
  assert.equal(adapter.client.capabilities.tableLayout, "markdown");
  assert.equal(adapter.client.capabilities.actions, "not-implemented");
  assert.match(texts[0], /\| 编号 \| 会话 \| 归属 \| 状态 \|/);
  assert.deepEqual(finals, [true]);
});

test("Feishu posts and patches native Card JSON 2.0 tables with exact callback identities", async () => {
  const writes: any[] = [], patches: any[] = [];
  const adapter = new FeishuChannelAdapter({ channel: "feishu", accountId: "f", appId: "fake", appSecret: "fake", savedAt: "", enabled: true }, {
    apiClient: { im: { v1: { message: {
      async create(x: any) { writes.push(JSON.parse(x.data.content)); return { code: 0, data: { message_id: "ack" } }; },
      async patch(x: any) { patches.push(JSON.parse(x.data.content)); return { code: 0, data: {} }; }
    } } } } as never, wsClient: { async start() {}, close() {} }
  });
  await adapter.client.sendActionCard({ toUserId: "oc_chat", card });
  await adapter.client.updateActionCard({ messageId: "ack", card });
  assert.deepEqual(patches[0], writes[0]);
  const payload = writes[0];
  assert.equal(payload.schema, "2.0");
  assert.equal(payload.elements, undefined, "no legacy action container in a v2 card");
  const native = payload.body.elements.find((e: any) => e.tag === "table");
  assert.equal(native.columns.length, 4);
  assert.ok(native.columns.every((c: any) => c.data_type === "text"));
  assert.equal(native.rows[1].col_1, table.rows[1][1]);
  const button = payload.body.elements.find((e: any) => e.tag === "column_set").columns[0].elements[0];
  assert.equal(formatChannelActionCommand(button.behaviors[0].value), "/session thread-a --host remote-a");
  const ordinary = feishuActionCard({ ...card, table: undefined }) as any;
  assert.equal(ordinary.schema, undefined, "non-table cards retain existing payload");
});

for (const channel of ["weixin", "wecom", "generic"] as const) {
  test(`${channel}: table fallback is a compact list, never raw Markdown or space-padded columns`, async () => {
    const texts: string[] = [];
    const client = createChannelClient(channel, TEXT_CAPABILITIES, { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } });
    await client.sendActionCard({ toUserId: "chat", card });
    assert.equal(texts.join(""), card.fallbackText);
    assert.doesNotMatch(texts[0], /\| ---|编号\s{3,}会话/);
    assert.match(texts[0], /\[R1\] 【当前】 排查问题 · gateway · 执行中/);
  });
}

test("session overview hides technical details; viewer detail is read-only, actor scoped and page-stable", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-session-table-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  store.setRole("chat", "viewer", "viewer");
  const cards: any[] = [], texts: string[] = [];
  const states = Array.from({ length: 9 }, (_, i) => ({ threadId: `full-thread-${i}`, title: i ? `Title ${i}` : "长标题测试".repeat(20), cwd: "/secret/path", persistence: "active", runtimeStatus: "idle", activeFlags: [], updatedAt: new Date(100000 - i).toISOString() }));
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["chat"], codexBackend: "exec" }, stateStore: store,
    weixin: { async sendActionCard(x) { cards.push(x.card); return { messageId: "card" }; }, async sendText(x) { texts.push(x.text); return { messageId: "text" }; } },
    runner: { async listThreads() { return states; } } as never });
  let n = 0;
  const send = (text: string, actor = "viewer") => service.handleMessage({ senderId: actor, replyTargetId: "chat", id: String(n++), text, raw: {} });
  await send("/sessions size 8");
  assert.equal(cards[0].table.rows.length, 8);
  assert.equal(cards[0].table.columns.length, 4);
  assert.equal(cards[0].table.rows[0][1].length, 28);
  assert.doesNotMatch(cards[0].fallbackText, /full-thread-|\/secret\/path/);
  assert.ok(cards[0].fallbackText.length < 1200);
  assert.equal(cards[0].actionGroups.flat()[0].value.arg, "full-thread-0 --host local");
  const before = store.snapshot;
  await send("/session detail R1");
  assert.match(texts.at(-1)!, /full-thread-0/);
  assert.match(texts.at(-1)!, /\/secret\/path/);
  assert.match(texts.at(-1)!, /长标题测试.*长标题测试/);
  assert.deepEqual(store.snapshot.activeSessionIds, before.activeSessionIds);
  assert.equal(store.listProjects().length, 0);
  await send("/sessions detail R1", "someone-else");
  assert.match(texts.at(-1)!, /已过期/);
  await send("/sessions more");
  assert.equal(cards.at(-1).table.rows[0][0], "R9");
  await send("/sessions detail R1");
  assert.match(texts.at(-1)!, /full-thread-0/);
  await send("/sessions search nonexistent");
  assert.equal(cards.at(-1).table, undefined);
  assert.match(cards.at(-1).fallbackText, /没有符合条件/);
});
