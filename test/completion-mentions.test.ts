import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completedCardForMentions } from "../src/channels/completion-mentions.js";
import type { ChannelStreamCheckpoint } from "../src/channels/progress.js";
import type { ChannelMentionInput } from "../src/channels/types.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { TurnAudienceJournal, type TurnAudienceScope } from "../src/bridge/turn-audience.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import type { CodexRunnerInput } from "../src/codex/backend.js";

const checkpoint = (): ChannelStreamCheckpoint => ({ streamId: "current-segment", messageId: "current-card", startedAt: 1,
  progressEntries: ["earlier", "checked", "tested", "finished"], thought: "", answerPreview: "", finished: true,
  resultPageBytes: 6000, resultPresentation: "card", terminal: { text: "complete answer", error: false },
  terminalPages: [{ messageId: "current-card", delivered: true }],
  segments: { acceptedInputs: ["steer"], previous: [{ inputId: "steer", attempts: 1,
    checkpoint: { streamId: "old", messageId: "old-card", startedAt: 1, progressEntries: [], thought: "", answerPreview: "", finished: true } }] } });
const scope: TurnAudienceScope = { bindingKey: "binding", conversationId: "group", hostId: "local", threadId: "thread", turnId: "turn" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const outcome of ["failed", "interrupted", "detached", "continued"] as const) test(`archived progress retains the actual ${outcome} outcome without success copy`, () => {
  const c = checkpoint(); c.terminal = { text: "上游报告所选模型当前容量不足。", error: outcome === "failed", outcome };
  const card = completedCardForMentions(c)!;
  assert.doesNotMatch(card.summary, /完整结果与参与者|本轮处理已结束/);
  assert.match(card.summary, outcome === "failed" ? /本轮执行失败/ : outcome === "detached" ? /已退出当前绑定/ : outcome === "continued" ? /已转入后续卡片/ : /本轮已停止/);
  if (outcome === "failed") assert.match(card.summary, /模型当前容量不足/);
  assert.equal(card.text, c.terminal.text);
});
function journal(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-completion-mentions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "audience.json");
  return { dir, file, audience: new TurnAudienceJournal(file) };
}
function channel(writes: ChannelMentionInput[]) {
  return createChannelClient("generic", { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true,
    mentions: "available", mentionBatchSize: 50, completionMentionCard: "available" }, {
    async sendText() { return { messageId: "text" }; },
    async sendMentionNotification(input) { writes.push(input); return { messageId: "combined-result" }; }
  });
}
function record(audience: TurnAudienceJournal, actor = "alice") {
  audience.record(scope, { bindingKey: scope.bindingKey, conversationId: scope.conversationId, actorId: actor, mention: { userId: actor } });
}

test("combined result uses only the acknowledged current segment, with a bounded phase summary", () => {
  const result = completedCardForMentions(checkpoint())!;
  assert.equal(result.messageId, "current-card"); assert.equal(result.text, "complete answer");
  assert.match(result.summary, /checked[\s\S]*tested[\s\S]*finished/);
  assert.doesNotMatch(result.summary, /earlier|complete answer|old-card/);
  for (const mutate of [
    (c: ChannelStreamCheckpoint) => { c.finished = false; },
    (c: ChannelStreamCheckpoint) => { c.resultPresentation = "native-text"; },
    (c: ChannelStreamCheckpoint) => { c.terminalPages![0].delivered = false; },
    (c: ChannelStreamCheckpoint) => { c.terminalPages![0].messageId = "another-card"; },
    (c: ChannelStreamCheckpoint) => { c.terminalPages!.push({ messageId: "page-2", delivered: true }); },
    (c: ChannelStreamCheckpoint) => { delete c.terminal; }
  ]) { const c = checkpoint(); mutate(c); assert.equal(completedCardForMentions(c), undefined); }
  assert.equal(completedCardForMentions(), undefined);
});

test("completion merge is capability-gated and rejects oversized or incomplete result context", async () => {
  const writes: ChannelMentionInput[] = [], client = channel(writes);
  const input = { toUserId: "group", text: "notice", mentions: [{ userId: "alice" }], completedCard: completedCardForMentions(checkpoint())! };
  for (const card of [{ ...input.completedCard, text: "x".repeat(7000) }, { ...input.completedCard, messageId: "" },
    { ...input.completedCard, summary: "" }, { ...input.completedCard, text: "" }]) {
    await assert.rejects(client.sendMentionNotification({ ...input, completedCard: card }));
  }
  const unsupported = createChannelClient("generic", { ...TEXT_CAPABILITIES, mentions: "available" }, {
    async sendText() { return { messageId: "x" }; }, async sendMentionNotification(i) { writes.push(i); return { messageId: "x" }; }
  });
  await assert.rejects(unsupported.sendMentionNotification(input), /completionMentionCard/);
  assert.equal(writes.length, 0);
});

test("journal sends one combined result, records the actual text, and never replays it after restart", async t => {
  const { audience, file } = journal(t), writes: ChannelMentionInput[] = [], client = channel(writes);
  record(audience); record(audience, "bob");
  const delivered: string[] = [], options = { isCurrent: () => true, completedCard: completedCardForMentions(checkpoint()),
    onTextDelivered: (part: { text: string }) => { delivered.push(part.text); } };
  await Promise.all([audience.notify(scope, client, options), audience.notify(scope, client, options)]);
  await new TurnAudienceJournal(file).notify(scope, client, options);
  assert.equal(writes.length, 1); assert.equal(writes[0].text, "complete answer");
  assert.deepEqual(writes[0].mentions.map(item => item.userId), ["alice", "bob"]);
  assert.equal(writes[0].completedCard?.messageId, "current-card");
  assert.deepEqual(delivered, ["complete answer"]);
  const saved = fs.readFileSync(file, "utf8");
  assert.match(saved, /current-card|combined-result/); assert.doesNotMatch(saved, /complete answer|最近进展/);
});

test("an unknown combined-card receipt is never replaced by webhook, fallback notification or a replay", async t => {
  const { audience, file } = journal(t), writes: ChannelMentionInput[] = [], client = channel(writes);
  record(audience); client.sendMentionNotification = async input => { writes.push(input); throw new Error("lost receipt"); };
  const options = { isCurrent: () => true, completedCard: completedCardForMentions(checkpoint()) };
  await audience.notify(scope, client, options);
  await new TurnAudienceJournal(file).notify(scope, channel(writes), options);
  assert.equal(writes.length, 1); assert.match(fs.readFileSync(file, "utf8"), /unconfirmed/);
});

test("a persisted unattempted merge requires the exact source card after restart", async t => {
  const { audience, file } = journal(t), writes: ChannelMentionInput[] = [];
  record(audience);
  // Stop between the durable plan and the write-ahead claim.
  let checks = 0;
  const options = { isCurrent: () => ++checks === 1, completedCard: completedCardForMentions(checkpoint()) };
  await audience.notify(scope, channel(writes), options); assert.equal(writes.length, 0);
  const recovered = new TurnAudienceJournal(file);
  await recovered.notify(scope, channel(writes), { isCurrent: () => true });
  await recovered.notify(scope, channel(writes), { isCurrent: () => true,
    completedCard: { ...options.completedCard!, messageId: "wrong-segment" } });
  assert.equal(writes.length, 0);
  await recovered.notify(scope, channel(writes), { ...options, isCurrent: () => true });
  assert.equal(writes.length, 1); assert.equal(writes[0].completedCard?.messageId, "current-card");
});

test("multi-batch audiences keep one short notification per batch instead of copying the full answer", async t => {
  const { audience } = journal(t), writes: ChannelMentionInput[] = [];
  for (let i = 0; i < 51; i++) record(audience, `member-${i}`);
  await audience.notify(scope, channel(writes), { isCurrent: () => true, completedCard: completedCardForMentions(checkpoint()) });
  assert.deepEqual(writes.map(item => item.mentions.length), [50, 1]);
  assert.ok(writes.every(item => !item.completedCard && !item.text.includes("complete answer")));
});

test("provider overhead is preflighted before freezing a merge; restart cannot promote the short plan", async t => {
  const { audience, file } = journal(t), writes: ChannelMentionInput[] = [];
  record(audience);
  const client = channel(writes);
  client.canCombineCompletionMentionCard = () => false;
  let current = 0;
  await audience.notify(scope, client, { isCurrent: () => ++current === 1, completedCard: completedCardForMentions(checkpoint()) });
  const saved = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(saved, /completedCardId/);
  await new TurnAudienceJournal(file).notify(scope, channel(writes), { isCurrent: () => true, completedCard: completedCardForMentions(checkpoint()) });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].completedCard, undefined);
  assert.equal(writes[0].text, "本轮最终答复已更新，请查看上方完整结果。");
});

test("in-flight accepted input joins the merge, but detaching before receipt release stays quiet", async t => {
  const { audience } = journal(t), writes: ChannelMentionInput[] = [];
  const release = audience.hold(scope); record(audience);
  await audience.notify(scope, channel(writes), { isCurrent: () => true, completedCard: completedCardForMentions(checkpoint()) });
  assert.equal(writes.length, 0); record(audience, "bob"); release(); await tick();
  assert.deepEqual(writes[0].mentions.map(item => item.userId), ["alice", "bob"]);
  const other = { ...scope, turnId: "next" }; const done = audience.hold(other); let live = true;
  audience.record(other, { bindingKey: other.bindingKey, conversationId: other.conversationId, actorId: "alice", mention: { userId: "alice" } });
  await audience.notify(other, channel(writes), { isCurrent: () => live, completedCard: completedCardForMentions(checkpoint()) });
  live = false; done(); await tick(); assert.equal(writes.length, 1);
});

test("follow hub supplies the active segment result only after all final acknowledgements and stays deduplicated", async t => {
  const { dir, file, audience } = journal(t), writes: ChannelMentionInput[] = [], base = channel(writes);
  let nextCard = 0, allowFinal = false;
  const driver = { ...base, async startTextStream() { return { messageId: `card-${++nextCard}` }; },
    async updateTextStream(input: { finalize?: boolean; text: string }) {
      if (input.finalize && input.text === "complete answer" && !allowFinal) throw new Error("unconfirmed final");
    } };
  const sub: ThreadSubscription = { key: scope.bindingKey, hostId: scope.hostId, threadId: scope.threadId,
    recipientId: scope.conversationId, client: driver, managed: false };
  record(audience);
  const options = { filePath: path.join(dir, "follow.json"), turnAudience: audience, subscriptions: () => [sub],
    backend: () => ({ async readThreadSnapshot(): Promise<never> { throw new Error("not needed"); } }) };
  let hub = new ThreadEventHub(options); t.after(() => hub.stop());
  await hub.started("local", "thread", "turn", new Date().toISOString());
  await hub.activity("local", "thread", "turn", "first segment progress");
  await hub.acceptedInput({ id: "steer", kind: "steer", hostId: "local", threadId: "thread", turnId: "turn", acceptedAt: Date.now() + 1,
    origin: { bindingKey: scope.bindingKey, conversationId: scope.conversationId, actorId: "bob", mention: { userId: "bob" } } });
  await hub.completion("local", "thread", "turn", "complete answer"); await tick();
  assert.equal(writes.length, 0);
  allowFinal = true; await hub.completion("local", "thread", "turn", "complete answer"); await tick();
  assert.equal(writes.length, 1); assert.equal(writes[0].completedCard?.messageId, "card-2");
  assert.deepEqual(writes[0].mentions.map(item => item.userId), ["alice", "bob"]);
  await hub.stop(); hub = new ThreadEventHub({ ...options, turnAudience: new TurnAudienceJournal(file) });
  await hub.completion("local", "thread", "turn", "complete answer"); await tick(); assert.equal(writes.length, 1);
});

test("standalone Bridge passes the confirmed result card to the same shared completion contract", async t => {
  const { dir, audience } = journal(t), store = new RuntimeStateStore(resolveStatePaths(path.join(dir, "state")));
  const project = store.createProject("Project", dir);
  const session = store.createSession("group", dir, "Session", project.id); store.setSessionThread(session.id, "thread");
  const writes: ChannelMentionInput[] = [], base = channel(writes);
  const service = new BridgeService({ accountId: "account", turnAudience: audience, stateStore: store,
    config: { ...defaultConfig(dir), allowedSenderIds: ["alice"] },
    channel: { ...base, async startTextStream() { return { messageId: "standalone-card" }; }, async updateTextStream() {} },
    runner: { async run(input: CodexRunnerInput) {
      await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" });
      return { threadId: "thread", turnId: "turn", text: "standalone result", raw: "" };
    } } as never });
  await service.handleMessage({ id: "initial", senderId: "alice", replyTargetId: "group", mention: { userId: "alice" },
    text: "do work", attachments: [], raw: {} }); await tick();
  assert.equal(writes.length, 1); assert.equal(writes[0].completedCard?.messageId, "standalone-card");
  assert.equal(writes[0].text, "standalone result");
});

test("paged results retain their original complete pages and use only the short native @ notice", async t => {
  const { audience } = journal(t), writes: ChannelMentionInput[] = [];
  record(audience); const c = checkpoint(); c.terminalPages!.push({ messageId: "page-2", delivered: true });
  await audience.notify(scope, channel(writes), { isCurrent: () => true, completedCard: completedCardForMentions(c) });
  assert.equal(writes.length, 1); assert.equal(writes[0].completedCard, undefined);
  assert.equal(writes[0].text, "本轮最终答复已更新，请查看上方完整结果。");
});
