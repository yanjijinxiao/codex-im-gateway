import assert from "node:assert/strict";
import test from "node:test";
import { ChannelTurnTextStream } from "../src/channels/progress.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { ChannelCapabilityError, ChannelProgressError, channelProgressError } from "../src/channels/errors.js";
import { TextProgressBatcher } from "../src/channels/text-progress.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function transport() {
  const starts: Array<{ text: string; streamId?: string }> = [];
  const frames: Array<{ messageId: string; text: string; finalize?: boolean; error?: boolean }> = [];
  const texts: string[] = [];
  let offline = false;
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true }, {
    async sendText() { throw new Error("progress must use the explicit plain-text operation"); },
    async sendProgressText(input) { texts.push(input.text); return { messageId: "plain" }; },
    async startTextStream(input) {
      starts.push(input);
      if (offline) throw Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" });
      return { messageId: "original-card" };
    },
    async updateTextStream(input) {
      frames.push(input);
      if (offline) throw Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" });
    }
  });
  return { client, starts, frames, texts, setOffline(value: boolean) { offline = value; } };
}

test("recovers the original card with the newest state and drops queued fallback progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const io = transport();
  const stream = new ChannelTurnTextStream(io.client, "chat");
  t.after(() => stream.suspend());
  await stream.progress("任务已提交");
  io.setOffline(true);
  await stream.progress("旧进度");
  await stream.flush();
  assert.equal(io.frames.length, 1);
  assert.equal(io.texts.length, 0); // Allow a short outage to recover quietly.
  await stream.progress("🤔 Waiting on session");
  await stream.progress("最新公开进度");
  const fallbackCount = io.texts.length;
  io.setOffline(false);
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(io.starts.length, 1);
  assert.equal(io.frames.length, 2);
  assert.equal(io.frames[1].messageId, "original-card");
  assert.match(io.frames[1].text, /最新公开进度/);
  t.mock.timers.tick(25_000);
  await settle();
  assert.equal(io.texts.length, fallbackCount);
  assert.equal(await stream.finalize("最终结果"), true);
  assert.deepEqual(io.frames.at(-1), { toUserId: "chat", messageId: "original-card", text: "最终结果", finalize: true });
});

test("retries opening after DNS failure with a stable per-turn stream identity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const io = transport();
  io.setOffline(true);
  const stream = new ChannelTurnTextStream(io.client, "chat");
  t.after(() => stream.suspend());
  await stream.progress("开始任务");
  io.setOffline(false);
  await stream.progress("网络恢复后的新进度");
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(io.starts.length, 2);
  assert.ok(io.starts[0].streamId);
  assert.equal(io.starts[0].streamId, io.starts[1].streamId);
  assert.match(io.starts[1].text, /网络恢复后的新进度/);
  assert.equal(await stream.finalize("结果"), true);
});

test("outage backoff is bounded and thinking titles cannot flood plain-text progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const io = transport();
  const stream = new ChannelTurnTextStream(io.client, "chat");
  t.after(() => stream.suspend());
  await stream.progress("开始任务");
  io.setOffline(true);
  await stream.progress("断网前最后状态");
  await stream.flush();
  for (let i = 0; i < 12; i++) {
    await stream.progress(`🤔 Internal heading ${i}`);
    await stream.progress(`公开进度 ${i}`);
    t.mock.timers.tick(5_000);
    await settle();
  }
  assert.equal(io.starts.length, 1);
  assert.equal(io.frames.length, 4); // Initial failure, then 5s, 10s and 20s backoffs.
  assert.ok(io.texts.length <= 3);
  assert.ok(io.texts.every((text) => !text.includes("Internal heading")));
  assert.ok(io.texts.some((text) => text.includes("公开进度")));
});

test("permission failures stop automatic card retries while fallback progress stays bounded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  let attempts = 0;
  const texts: string[] = [];
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, progress: "available" }, {
    async sendText() { throw new Error("must not send ordinary cards"); },
    async sendProgressText(input) { texts.push(input.text); return { messageId: "plain" }; },
    async startTextStream() { attempts++; throw new Error("HTTP 403 Forbidden.AccessDenied"); },
    async updateTextStream() { throw new Error("unexpected update"); }
  });
  const stream = new ChannelTurnTextStream(client, "chat");
  await stream.progress("开始任务");
  for (let i = 0; i < 20; i++) await stream.progress(`进度 ${i}`);
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(attempts, 1);
  assert.ok(texts.length <= 2);
  assert.match(texts[0], /权限或配置/);
  assert.equal(await stream.finalize("最终回复由普通消息发送"), false);
  await stream.suspend();
});

test("terminal failure stops every progress timer and a later retry only closes the original card", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const io = transport();
  const stream = new ChannelTurnTextStream(io.client, "chat");
  await stream.progress("开始任务");
  io.setOffline(true);
  await stream.progress("进度");
  await stream.flush();
  assert.equal(await stream.fail("执行失败"), false);
  const count = io.frames.length;
  await stream.progress("迟到的摘要");
  await stream.answer("迟到的答案片段");
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(io.frames.length, count);
  assert.equal(io.texts.length, 0);
  io.setOffline(false);
  assert.equal(await stream.fail("执行失败"), true);
  assert.deepEqual(io.frames.at(-1), { toUserId: "chat", messageId: "original-card", text: "执行失败", finalize: true, error: true });
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(io.frames.length, count + 1);
  await stream.suspend();
});

test("completion arriving during card creation cannot restart progress or create another card", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const opening = Promise.withResolvers<{ messageId: string }>();
  const frames: Array<{ text: string; finalize?: boolean }> = [];
  const stream = new ChannelTurnTextStream({
    async sendText() { throw new Error("no late fallback"); },
    async startTextStream() { return opening.promise; },
    async updateTextStream(input) { frames.push(input); }
  }, "chat");
  const progress = stream.progress("开始");
  const final = stream.finalize("完成");
  await stream.progress("迟到进展");
  opening.resolve({ messageId: "original" });
  await progress;
  assert.equal(await final, true);
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].finalize, true);
  assert.equal(frames[0].text, "完成");
  await stream.suspend();
});

test("a restored failed terminal checkpoint cannot resume thinking updates", async () => {
  const io = transport();
  const stream = new ChannelTurnTextStream(io.client, "chat", {
    restore: { messageId: "original-card", startedAt: Date.now(), thought: "旧摘要", progressEntries: [],
      answerPreview: "", finished: false, terminal: { text: "最终结果", error: false } },
    save() {}
  });
  await stream.progress("重启后迟到进度");
  assert.equal(io.frames.length, 0);
  assert.equal(await stream.finalize("最终结果"), true);
  assert.equal(io.starts.length, 0);
  await stream.suspend();
});

test("slow card updates serialize and coalesce intervening progress into the latest snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const blocked = Promise.withResolvers<void>();
  const frames: string[] = [];
  const stream = new ChannelTurnTextStream({
    async sendText() { throw new Error("no fallback expected"); },
    async startTextStream() { return { messageId: "card" }; },
    async updateTextStream(input) {
      frames.push(input.text);
      if (frames.length === 1) await blocked.promise;
    }
  }, "chat");
  t.after(() => stream.suspend());
  await stream.progress("开始");
  await stream.progress("较早的进度");
  const flushing = stream.flush();
  await settle();
  for (let i = 0; i < 20; i++) await stream.progress(`最新状态 ${i}`);
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(frames.length, 1);
  blocked.resolve();
  await flushing;
  t.mock.timers.tick(500);
  await settle();
  assert.equal(frames.length, 2);
  assert.match(frames[1], /最新状态 19/);
  assert.ok(!frames[1].includes("较早的进度"));
});

test("concurrent text-only progress calls enforce the same 30-second window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const writes: string[] = [];
  const batch = new TextProgressBatcher(async (text) => { writes.push(text); });
  await Promise.all(Array.from({ length: 100 }, (_, index) => batch.push(`进度 ${index}`)));
  assert.equal(writes.length, 1);
  await batch.push("最新状态");
  t.mock.timers.tick(29_999);
  await settle();
  assert.equal(writes.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(writes.length, 2);
  assert.match(writes[1], /最新状态/);
  await batch.close();
});

test("the contract never substitutes one-shot card sending for explicit progress text", async () => {
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, progress: "available" }, {
    async sendText() { throw new Error("must not call"); }
  });
  await assert.rejects(client.sendProgressText({ toUserId: "chat", text: "进度" }), ChannelCapabilityError);
  assert.equal(channelProgressError(new Error("HTTP 429 rate limited")).retryable, true);
  assert.equal(channelProgressError(new Error("HTTP 503 service unavailable")).retryable, true);
  assert.equal(channelProgressError(new Error("HTTP 403 permission denied")).retryable, false);
  assert.ok(channelProgressError(new Error("HTTP 400 InvalidParameter")) instanceof ChannelProgressError);
});
