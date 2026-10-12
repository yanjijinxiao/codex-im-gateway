import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelTurnTextStream } from "../src/channels/progress.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import type { CodexThreadSnapshot } from "../src/codex/backend.js";

function fixture(t: test.TestContext, cards = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-result-delivery-"));
  const filePath = path.join(root, "delivery.json");
  const opens: Array<{ streamId?: string; text: string }> = [];
  const finals: Array<{ messageId: string; text: string }> = [];
  const texts: string[] = [], notices: string[] = [];
  const failedCards = new Set<string>();
  let failOpen = false;
  const sub: ThreadSubscription = { key: "account/chat", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
    client: { resumableTextStream: cards,
      async sendText(input) { texts.push(input.text); return { messageId: "text-receipt" }; },
      async sendProgressText(input) { notices.push(input.text); return { messageId: "notice-receipt" }; },
      ...(cards ? {
        async startTextStream(input: { streamId?: string; text: string }) {
          opens.push(input);
          if (failOpen) throw new Error("temporary card creation failure");
          return { messageId: input.streamId! };
        },
        async updateTextStream(input: { messageId: string; text: string; finalize?: boolean }) {
          if (input.finalize && failedCards.has(input.messageId)) throw new Error("temporary final frame failure");
          if (input.finalize) finals.push(input);
        }
      } : {})
    }
  };
  let snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }, turns: [] };
  const options = { filePath, subscriptions: () => [sub], backend: () => ({ async readThreadSnapshot() { return snapshot; } }) };
  let hub = new ThreadEventHub(options);
  t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { filePath, sub, opens, finals, texts, notices, failedCards,
    get hub() { return hub; }, setFailOpen(value: boolean) { failOpen = value; },
    setSnapshot(value: CodexThreadSnapshot) { snapshot = value; },
    state() { return JSON.parse(fs.readFileSync(filePath, "utf8"))[sub.key]; },
    async restart() { await hub.stop(); hub = new ThreadEventHub(options); }
  };
}

test("a final-only card opens directly with its answer, and retries retain the logical card identity", async t => {
  const f = fixture(t);
  const stream = new ChannelTurnTextStream(f.sub.client, "chat", { save() {} });
  assert.equal(await stream.finalize("短任务最终结果"), true);
  assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].text, "短任务最终结果");
  assert.equal(f.finals[0].messageId, f.opens[0].streamId);
  assert.equal(await stream.finalize("迟到重复结果"), true);
  assert.equal(f.finals.length, 1);
  await stream.suspend();
});

test("missing card receipts and delivery-error notices never count as successful final delivery", async t => {
  const f = fixture(t);
  f.setFailOpen(true);
  await f.hub.started("local", "thread", "turn", new Date().toISOString());
  await f.hub.completion("local", "thread", "turn", "最终结果");
  assert.equal(f.finals.length, 0);
  assert.equal(f.notices.length, 1);
  assert.equal(f.state().completed.includes("turn"), false);
  assert.equal(f.state().terminalPending.turnId, "turn");
  assert.equal(f.hub.status(f.sub.key).resultDelivery?.pending, 1);
  const status = await f.hub.synchronize(f.sub.key);
  assert.equal(status.status, "failed");
  assert.equal(status.failure?.code, "presentation");
  assert.equal(f.notices.length, 1);
  const identity = f.opens[0].streamId;
  await f.restart();
  f.setFailOpen(false);
  await f.hub.synchronize(f.sub.key);
  assert.ok(f.opens.every(input => input.streamId === identity));
  assert.equal(f.finals.length, 1);
  assert.equal(f.finals[0].text, "最终结果");
  assert.equal(f.state().completed.includes("turn"), true);
  assert.equal(f.hub.status(f.sub.key).resultDelivery?.pending, 0);
});

test("a failed managed turn cannot poison a new card; pending old results survive restart independently", async t => {
  const f = fixture(t);
  f.sub.managed = true;
  const old = f.hub.managedStream(f.sub);
  await old.progress("旧任务进度");
  f.hub.managedStarted(f.sub, "old-turn");
  const oldCard = old.checkpoint().messageId!;
  f.failedCards.add(oldCard);
  assert.equal(await f.hub.managedCompletion(f.sub, "old-turn", "旧轮次答案"), false);
  const next = f.hub.managedStream(f.sub);
  await next.progress("新任务进度");
  f.hub.managedStarted(f.sub, "new-turn");
  assert.notEqual(next.checkpoint().messageId, oldCard);
  assert.equal(await f.hub.managedCompletion(f.sub, "new-turn", "新轮次答案"), true);
  assert.deepEqual(f.finals.map(frame => frame.text), ["新轮次答案"]);
  assert.equal(f.state().pendingTerminals["old-turn"].checkpoint.messageId, oldCard);
  assert.equal(f.state().completed.includes("old-turn"), false);
  await f.restart();
  f.sub.managed = false;
  f.failedCards.clear();
  await f.hub.refresh();
  await f.hub.refresh();
  assert.deepEqual(f.finals.map(frame => frame.text), ["新轮次答案", "旧轮次答案"]);
  assert.equal(f.finals[1].messageId, oldCard);
  assert.equal(f.opens.length, 2);
  assert.equal(f.notices.length, 1);
  assert.equal(f.hub.status(f.sub.key).resultDelivery?.pending, 0);
});

test("legacy false completion repairs only the exact latest loaded turn, never saved stale text", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, JSON.stringify({ [f.sub.key]: {
    eventVersion: 2, hostId: "local", threadId: "thread", turnId: "latest", sequence: 1, initialized: true,
    delivered: [], completed: ["historical", "latest"], baseline: ["historical"],
    checkpoint: { streamId: "polluted", startedAt: Date.now(), progressEntries: [], thought: "", answerPreview: "",
      finished: false, terminal: { text: "STALE_SECRET_MUST_NOT_REPLAY", error: false }, terminalNoticeSent: true }
  } }));
  await f.restart();
  f.setSnapshot({ state: { threadId: "thread", persistence: "active", runtimeStatus: "notLoaded", activeFlags: [] }, turns: [
    { id: "latest", status: "completed", messages: [{ id: "a", role: "assistant", text: "unconfirmed" }] }
  ] });
  await f.hub.refresh();
  assert.equal(f.opens.length, 0);
  assert.equal(f.hub.status(f.sub.key).resultDelivery?.pending, 1);
  f.setSnapshot({ state: { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }, turns: [
    { id: "historical", status: "completed", messages: [{ id: "h", role: "assistant", text: "HISTORY_MUST_NOT_REPLAY" }] },
    { id: "latest", status: "completed", messages: [{ id: "a", role: "assistant", text: "精确核对的新结果" }] }
  ] });
  await f.hub.refresh();
  await f.hub.refresh();
  assert.deepEqual(f.finals.map(frame => frame.text), ["精确核对的新结果"]);
  assert.equal(f.hub.status(f.sub.key).resultDelivery?.pending, 0);
});

test("preparing a new managed card waits for the previous final acknowledgement", async t => {
  const f = fixture(t);
  f.sub.managed = true;
  const old = await f.hub.prepareManagedStream(f.sub);
  await old.progress("旧进展");
  await f.hub.managedTurnStarted(f.sub, "old");
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = f.sub.client.updateTextStream!;
  f.sub.client.updateTextStream = async input => {
    if (input.finalize) { started.resolve(); await release.promise; }
    await original(input);
  };
  const finalizing = f.hub.managedCompletion(f.sub, "old", "旧结果");
  await started.promise;
  let prepared = false;
  const preparing = f.hub.prepareManagedStream(f.sub).then(stream => { prepared = true; return stream; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(prepared, false);
  release.resolve();
  assert.equal(await finalizing, true);
  const next = await preparing;
  await next.progress("新进展");
  await f.hub.managedTurnStarted(f.sub, "next");
  assert.equal(await f.hub.managedCompletion(f.sub, "next", "新结果"), true);
  assert.deepEqual(f.finals.map(frame => frame.text), ["旧结果", "新结果"]);
  assert.equal(f.opens.length, 2);
  assert.equal(f.state().checkpoint.messageId, next.checkpoint().messageId);
});

test("a backend returning a final turn ID without a start notification still uses the prepared card", async t => {
  const f = fixture(t);
  f.sub.managed = true;
  const stream = await f.hub.prepareManagedStream(f.sub);
  await stream.progress("进展");
  assert.equal(await f.hub.managedCompletion(f.sub, "turn", "结果"), true);
  assert.equal(f.opens.length, 1);
  assert.equal(f.finals.length, 1);
});

test("legacy native-text acknowledgements are not mistaken for failed cards or replayed", async t => {
  const f = fixture(t, false);
  fs.writeFileSync(f.filePath, JSON.stringify({ [f.sub.key]: {
    eventVersion: 2, hostId: "local", threadId: "thread", turnId: "turn", sequence: 1, initialized: true,
    delivered: [], completed: ["turn"], baseline: [], checkpoint: {
      startedAt: Date.now(), progressEntries: [], thought: "", answerPreview: "", finished: false,
      terminal: { text: "ALREADY_DELIVERED_TEXT", error: false }
    }
  } }));
  await f.restart();
  f.setSnapshot({ state: { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }, turns: [
    { id: "turn", status: "completed", messages: [{ id: "a", role: "assistant", text: "ALREADY_DELIVERED_TEXT" }] }
  ] });
  await f.hub.refresh();
  assert.deepEqual(f.texts, []);
  assert.equal(f.hub.status(f.sub.key).resultDelivery?.pending, 0);
});

for (const channel of ["dingtalk", "feishu", "weixin"] as const) {
  test(`${channel}: managed execution and following share final acknowledgements and do not resend`, async t => {
    const f = fixture(t, channel === "dingtalk");
    f.sub.managed = true;
    if (channel === "dingtalk") await f.hub.managedStream(f.sub).progress("正在执行");
    f.hub.managedStarted(f.sub, "turn");
    assert.equal(await f.hub.managedCompletion(f.sub, "turn", "最终答案"), true);
    f.sub.managed = false;
    await f.hub.completion("local", "thread", "turn", "最终答案");
    await f.restart();
    await f.hub.completion("local", "thread", "turn", "最终答案");
    assert.equal(f.finals.length + f.texts.length, 1);
    assert.equal(f.hub.status(f.sub.key).resultDelivery?.pending, 0);
  });
}
