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
import { feishuActionCard } from "../src/channels/feishu-action-card.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { renderMarkdownTable, renderTextTable } from "../src/channels/table.js";
import { normalizeDingTalkCardContent } from "../src/channels/dingtalk.js";

for (const backend of ["exec", "app-server"] as const) {
  test(`${backend}: 103 sessions fit four default pages; resizing preserves identity, filter and preferences`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-session-density-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = resolveStatePaths(root), store = new RuntimeStateStore(paths);
    const cards: ChannelActionCard[] = [], texts: string[] = [];
    let lists = 0, inspections = 0, seq = 0;
    const states = Array.from({ length: 103 }, (_, i) => ({
      threadId: `task-${i}`, title: `任务 ${i}`, cwd: root, persistence: "active", runtimeStatus: "idle",
      activeFlags: [], updatedAt: new Date(1000000 - i).toISOString()
    }));
    const service = new BridgeService({ config: { ...defaultConfig(root), codexBackend: backend, allowedSenderIds: ["chat", "other"] }, stateStore: store,
      listCodexProjects: () => [],
      weixin: { async sendActionCard(x) { cards.push(x.card); return { messageId: "m" }; }, async sendText(x) { texts.push(x.text); return { messageId: "t" }; } },
      runner: { async listThreads() { lists++; return states; }, async inspectThread() { inspections++; throw new Error("Listing must not bind"); } } as never });
    const send = (text: string, actor = "alice", chat = "chat") => service.handleMessage({ senderId: actor, replyTargetId: chat, id: String(seq++), text, raw: {} });
    await send("/sessions");
    assert.match(cards[0].title, /103 个.*第 1\/4 页/);
    assert.equal(cards[0].table!.rows.length, 30);
    const numbers = cards[0].table!.rows.map(r => r[0]);
    for (let i = 0; i < 3; i++) {
      await send("/sessions more");
      numbers.push(...cards.at(-1)!.table!.rows.map(r => r[0]));
    }
    assert.deepEqual(numbers, Array.from({ length: 103 }, (_, i) => `R${i + 1}`));
    assert.equal(lists, 1, "paging never rediscovers the catalog");
    states.reverse();
    await send("/sessions size 50");
    assert.match(cards.at(-1)!.title, /第 2\/3 页/);
    assert.equal(cards.at(-1)!.table!.rows[0][0], "R51", "new page contains the old anchor R91");
    assert.equal(cards.at(-1)!.table!.rows.length, 50);
    assert.equal(cards.at(-1)!.actionGroups.flat()[0].value.arg, "task-50 --host local");
    assert.equal(lists, 1, "resizing uses exactly the same snapshot");
    const fifty = cards.at(-1)!;
    await send("/sessions page 3");
    assert.deepEqual(cards.at(-1)!.table!.rows.map(r => r[0]), ["R101", "R102", "R103"]);
    await send("/sessions detail R51");
    assert.match(texts.at(-1)!, /ID：task-50/);
    for (const value of ["", "0", "4", "51", "999999999999999999999", "-1", "1.5", "abc", "50 extra"]) {
      await send(`/sessions size ${value}`);
      assert.match(texts.at(-1)!, /用法：\/sessions size 5-50/);
      assert.equal(store.getSessionPageSize("chat", "alice"), 50);
    }
    assert.equal(lists, 1);
    assert.equal(inspections, 0);
    assert.equal(store.listProjects().length, 0);
    assert.equal(store.listSessions().length, 0);
    assert.equal(new RuntimeStateStore(paths).getSessionPageSize("chat", "alice"), 50);
    await send("/sessions", "bob");
    assert.equal(cards.at(-1)!.table!.rows.length, 30, "another actor retains default");
    await send("/sessions", "alice", "other");
    assert.equal(cards.at(-1)!.table!.rows.length, 30, "another chat retains default");
    await send("/sessions search 任务 10");
    assert.equal(cards.at(-1)!.table!.rows.length, 4);
    assert.match(cards.at(-1)!.note!, /每页 50 条/);
    const calls = lists;
    await send("/sessions size 5");
    assert.match(cards.at(-1)!.title, /搜索：任务 10.*4 个/);
    assert.equal(lists, calls, "size change keeps the search filter without rediscovery");
    await send("/sessions search not-found");
    await send("/sessions size 30");
    assert.match(cards.at(-1)!.title, /0 个.*第 1\/1 页/);
    assert.equal(cards.at(-1)!.table, undefined);

    const markdown = normalizeDingTalkCardContent(renderMarkdownTable(fifty.table!));
    assert.equal(markdown.split("\n").filter(l => l.startsWith("|")).length, 52);
    const native = feishuActionCard(fifty) as any;
    const tables = native.body.elements.filter((e: any) => e.tag === "table");
    assert.equal(tables.length, 5);
    assert.ok(tables.every((e: any) => e.rows.length === 10 && e.page_size === 10));
    assert.deepEqual(tables.flatMap((e: any) => e.rows.map((r: any) => r.col_0)), fifty.table!.rows.map(r => r[0]));
    assert.ok(Buffer.byteLength(JSON.stringify(native)) < 28000, "ordinary 50-row cards remain bounded");
    for (const channel of ["weixin", "wecom"] as const) {
      const parts: string[] = [];
      const client = createChannelClient(channel, TEXT_CAPABILITIES, { async sendText(x) { parts.push(x.text); return { messageId: String(parts.length) }; } });
      await client.sendActionCard({ toUserId: "chat", card: fifty });
      const visible = parts.join("\n").match(/\[R\d+\]/g);
      assert.deepEqual(visible, fifty.table!.rows.map(r => `[${r[0]}]`), "text transport must not drop large-page rows");
      assert.equal(renderTextTable(fifty.table!).split("\n").length, 50);
    }
  });
}

test("saved page sizes reject invalid values and keep defaults for old state files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-session-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root), store = new RuntimeStateStore(paths);
  assert.equal(store.getSessionPageSize("chat", "actor"), 30);
  for (const size of [0, 51, NaN, Infinity, 7.5]) assert.throws(() => store.setSessionPageSize("chat", "actor", size));
  fs.writeFileSync(paths.statePath, JSON.stringify({ sessionPageSizes: { '["chat","actor"]': 10000 } }));
  assert.equal(new RuntimeStateStore(paths).getSessionPageSize("chat", "actor"), 30);
  fs.writeFileSync(paths.statePath, "{}");
  assert.equal(new RuntimeStateStore(paths).getSessionPageSize("chat", "actor"), 30);
});
