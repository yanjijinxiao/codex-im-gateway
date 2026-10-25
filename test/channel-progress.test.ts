import assert from "node:assert/strict";
import test from "node:test";
import { ChannelTurnTextStream } from "../src/channels/progress.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { ChannelCapabilityError, ChannelProgressError, channelProgressError } from "../src/channels/errors.js";
import { TextProgressBatcher } from "../src/channels/text-progress.js";
import { summarizeProgress } from "../src/channels/progress-summary.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("legacy page layouts retain activity metadata and update waiting/running text on the same card", async t => {
  const frames: any[] = [];
  const client = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available",
    turnStatusHeader: "available", resumableProgress: true }, {
    async sendText() { throw new Error("no duplicate notice"); },
    async startTextStream() { throw new Error("must keep the restored card"); },
    async updateTextStream(input) { frames.push(input); }
  });
  const stream = new ChannelTurnTextStream(client, "chat", { save() {}, restore: {
    streamId: "old-stream", messageId: "old-card", startedAt: Date.now(), progressEntries: [],
    thought: "仍在处理", answerPreview: "", finished: false, resultPageBytes: 1024
  } });
  t.after(() => stream.suspend());
  await stream.synchronize();
  assert.equal(frames.at(-1).activity, "running");
  for (const activity of ["waiting-approval", "waiting-input", "running"] as const) {
    await stream.setActivity(activity); await stream.flush();
    assert.equal(frames.at(-1).messageId, "old-card");
    assert.equal(frames.at(-1).activity, activity);
    assert.match(frames.at(-1).text, activity === "waiting-approval" ? /等待审批/ : activity === "waiting-input" ? /等你回答/ : /进行中/);
    assert.doesNotMatch(frames.at(-1).text, /^## /m);
    assert.equal(stream.checkpoint().resultPageBytes, 1024);
    assert.equal(stream.checkpoint().statusHeader, undefined, "do not change existing final-page boundaries");
    assert.equal(stream.checkpoint().activity, activity);
  }
});

test("quiet historical recovery never creates a card, native text or missing continuation pages", async t => {
  const io = transport();
  for (const messageId of [undefined, "original"]) {
    const stream = new ChannelTurnTextStream(io.client, "chat", { save() {}, restore: {
      streamId: "historical", messageId, startedAt: Date.now(), progressEntries: [], thought: "", answerPreview: "", finished: false,
      resultPageBytes: 1024, terminal: { text: "历史结果很长。".repeat(200), error: false }
    } });
    t.after(() => stream.suspend());
    assert.equal(await stream.finalize("历史结果很长。".repeat(200), false, { existingOnly: true }), false);
  }
  assert.equal(io.starts.length, 0); assert.equal(io.frames.length, 0); assert.equal(io.texts.length, 0);
});

test("quiet historical recovery updates an existing short-result card without a new notification", async t => {
  const io = transport();
  const stream = new ChannelTurnTextStream(io.client, "chat", { save() {}, restore: {
    streamId: "historical", messageId: "original", startedAt: Date.now(), progressEntries: [], thought: "", answerPreview: "", finished: false
  } });
  t.after(() => stream.suspend());
  assert.equal(await stream.finalize("旧结果", false, { existingOnly: true }), true);
  assert.equal(io.starts.length, 0); assert.equal(io.texts.length, 0);
  assert.equal(io.frames.length, 1); assert.equal(io.frames[0].messageId, "original");
});

test("locally rejected legacy route restores automatically without replacing or notifying a nonexistent card", async t => {
  const io = transport();
  const stream = new ChannelTurnTextStream(io.client, "chat", { save() {}, restore: {
    streamId: "preserved-logical-id", creationAttempted: true, startedAt: Date.now(),
    progressEntries: [], thought: "", answerPreview: "", finished: false,
    bootstrap: { version: 1, instanceId: "preserved-logical-id", recipientId: "chat", stage: "create-rejected",
      failure: { operation: "create", code: "RouteUnconfirmed", uncertain: false } },
    terminal: { text: "result", error: false }
  } });
  t.after(() => stream.suspend());
  assert.equal(await stream.reportTerminalFailure(), false); assert.equal(io.texts.length, 0);
  assert.equal(await stream.finalize("result"), true);
  assert.equal(io.starts.length, 1); assert.equal(io.starts[0].streamId, "preserved-logical-id");
  assert.equal(io.frames.at(-1)?.finalize, true);
  assert.equal(await stream.finalize("result"), true); assert.equal(io.starts.length, 1);
});

for (const stage of ["create-unconfirmed", "delivery-unconfirmed", "create-rejected"] as const) {
  test(`background recovery never replays ${stage} provider requests`, async t => {
    const io = transport();
    const stream = new ChannelTurnTextStream(io.client, "chat", { save() {}, restore: {
      streamId: "original", creationAttempted: true, startedAt: Date.now(), progressEntries: [],
      thought: "", answerPreview: "", finished: false,
      bootstrap: { version: 1, instanceId: "original", recipientId: "chat", stage,
        failure: { operation: "create", code: stage === "create-rejected" ? "PermissionDenied" : "TransportUnconfirmed", uncertain: stage !== "create-rejected" } },
      terminal: { text: "result", error: false }
    } });
    t.after(() => stream.suspend());
    assert.equal(await stream.finalize("result"), false); assert.equal(io.starts.length, 0);
    await stream.reportTerminalFailure(); assert.doesNotMatch(io.texts[0] ?? "", /未能更新原 AI Card/);
  });
}

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

test("shutdown suspension cannot finalize the persisted card as a failed task", async t => {
  const io = transport();
  const stream = new ChannelTurnTextStream(io.client, "chat");
  t.after(() => stream.suspend());
  await stream.progress("任务仍在 Codex 中执行");
  await stream.suspend();
  const writes = io.frames.length;
  assert.equal(await stream.fail("Gateway connection closed"), false);
  assert.equal(await stream.reportTerminalFailure(), false);
  assert.equal(stream.checkpoint().terminal, undefined);
  assert.equal(stream.checkpoint().finished, false);
  assert.equal(io.frames.length, writes);
});

test("recovers the original card with the newest state without sending text progress", async (t) => {
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

test("outage backoff is bounded and no thinking, tool or commentary events become plain-text progress", async (t) => {
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
  assert.equal(io.texts.length, 0);
  assert.ok(stream.checkpoint().progressEntries.some((text) => text.includes("公开进度")));
});

test("permission failures stop card retries without sending any text progress", async (t) => {
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
  assert.equal(texts.length, 0);
  assert.equal(await stream.finalize("不应作为普通消息发送的最终回复"), false);
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

test("concurrent text-only progress calls preserve the native 30-second window", async (t) => {
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

test("route-dependent rejection recovers only the original card without text degradation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const io = transport();
  const originalUpdate = io.client.updateTextStream;
  let rejected = true;
  io.client.updateTextStream = async (input) => {
    if (rejected) throw new ChannelProgressError(false, input.messageId, 30_000, undefined, true);
    return originalUpdate(input);
  };
  const stream = new ChannelTurnTextStream(io.client, "chat");
  t.after(() => stream.suspend());
  await stream.progress("开始任务");
  await stream.progress("旧状态");
  await stream.flush();
  for (let i = 0; i < 30; i++) await stream.progress(`最新状态 ${i}`);
  assert.equal(io.texts.length, 0);
  rejected = false;
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(io.starts.length, 1);
  assert.equal(io.frames.length, 1);
  assert.equal(io.frames[0].messageId, "original-card");
  assert.match(io.frames[0].text, /最新状态 29/);
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(io.texts.length, 0);
  assert.equal(await stream.finalize("最终答案"), true);
});

test("route rejection probes are bounded at 30, 60 and 120 seconds, without opening replacements", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const io = transport();
  let attempts = 0;
  io.client.updateTextStream = async (input) => {
    attempts++;
    throw new ChannelProgressError(false, input.messageId, 30_000, undefined, true);
  };
  const stream = new ChannelTurnTextStream(io.client, "chat");
  t.after(() => stream.suspend());
  await stream.progress("开始任务");
  await stream.progress("开始检查");
  await stream.flush();
  for (const delay of [30_000, 60_000, 120_000]) {
    t.mock.timers.tick(delay - 1);
    await settle();
    const count = attempts;
    t.mock.timers.tick(1);
    await settle();
    assert.equal(attempts, count + 1);
  }
  assert.equal(attempts, 4);
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(attempts, 4);
  assert.equal(io.starts.length, 1);
  assert.equal(io.texts.length, 0, "exhausting probes must not switch presentation");
});

test("a probe hint without an acknowledged card cannot retry creation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const io = transport();
  let attempts = 0;
  io.client.startTextStream = async () => {
    attempts++;
    throw new ChannelProgressError(false, undefined, 30_000, undefined, true);
  };
  const stream = new ChannelTurnTextStream(io.client, "chat");
  t.after(() => stream.suspend());
  await stream.progress("开始任务");
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(attempts, 1);
});

test("completion cancels allowlist probes before closing the original card", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const io = transport();
  const originalUpdate = io.client.updateTextStream;
  let rejected = true;
  let attempts = 0;
  io.client.updateTextStream = async (input) => {
    attempts++;
    if (rejected) throw new ChannelProgressError(false, input.messageId, 30_000, undefined, true);
    return originalUpdate(input);
  };
  const stream = new ChannelTurnTextStream(io.client, "chat");
  await stream.progress("开始任务");
  await stream.progress("正在检查");
  await stream.flush();
  await stream.progress("即将完成");
  rejected = false;
  assert.equal(await stream.finalize("已完成"), true);
  const count = attempts;
  await stream.progress("迟到命令状态");
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(attempts, count);
  assert.equal(io.texts.length, 0);
  assert.equal(io.starts.length, 1);
  await stream.suspend();
});

test("command summaries remove heredoc scripts and arguments from cards and native text progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const source = "🔎 正在执行命令：`/bin/zsh -lc \"ssh admin@example python3 - <<'PY'\nprint('SECRET_ARGUMENT')\nPY\"`";
  const done = "✅ 命令完成：`python3 - <<'PY'\nprint('SECRET_ARGUMENT')\nPY`，退出码 0，1.0s";
  assert.equal(summarizeProgress(source), "🔎 正在执行远程命令");
  assert.equal(summarizeProgress(done), "✅ Python 脚本完成，退出码 0，耗时 1.0s");
  assert.equal(summarizeProgress("已定位调度缺陷，需要补充回归测试。"), "已定位调度缺陷，需要补充回归测试。");
  const io = transport();
  io.setOffline(true);
  const stream = new ChannelTurnTextStream(io.client, "chat");
  t.after(() => stream.suspend());
  await stream.progress(source);
  for (let i = 0; i < 20; i++) await stream.progress(source.replace("SECRET_ARGUMENT", `PRIVATE_${i}`));
  await stream.progress(done);
  assert.equal(io.texts.length, 0);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(io.texts.length, 0);
  assert.ok(stream.checkpoint().progressEntries.every((entry) => !entry.includes("SECRET_ARGUMENT")));
  const texts: string[] = [];
  const textOnly = new ChannelTurnTextStream(createChannelClient("generic", TEXT_CAPABILITIES, {
    async sendText(input) { texts.push(input.text); return { messageId: "text" }; }
  }), "chat");
  t.after(() => textOnly.suspend());
  await textOnly.progress(source);
  await textOnly.progress(done);
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(texts.length, 0); // Routine tool receipts no longer occupy native progress messages.
  await textOnly.progress("已定位调度缺陷，需要补充回归测试。");
  assert.equal(texts.length, 1);
  assert.ok(texts.every((text) => text.length < 650 && !text.includes("SECRET_ARGUMENT") && !text.includes("/bin/zsh")));
});

test("closing waits for in-flight fallback and discards queued progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const sending = Promise.withResolvers<void>();
  const writes: string[] = [];
  const batch = new TextProgressBatcher(async (text) => { writes.push(text); await sending.promise; });
  const progress = batch.push("正在检查");
  await settle();
  await batch.push("不得迟到的进度");
  let closed = false;
  const closing = batch.close().then(() => { closed = true; });
  await settle();
  assert.equal(closed, false);
  sending.resolve();
  await Promise.all([progress, closing]);
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(writes.length, 1);
  assert.ok(!writes[0].includes("不得迟到"));
});

test("terminal card delivery failures produce one error notice, never a replacement answer, even after restart", async () => {
  const io = transport();
  const stream = new ChannelTurnTextStream(io.client, "chat");
  await stream.progress("开始任务");
  io.setOffline(true);
  assert.equal(await stream.finalize("PRIVATE_FINAL_ANSWER"), false);
  await Promise.all([stream.reportTerminalFailure(), stream.reportTerminalFailure()]);
  assert.equal(io.texts.length, 1);
  assert.match(io.texts[0], /最终答复未能更新原 AI Card/);
  assert.ok(!io.texts[0].includes("PRIVATE_FINAL_ANSWER"));
  const checkpoint = stream.checkpoint();
  assert.equal(checkpoint.terminalNoticeSent, true);
  await stream.suspend();
  const restored = new ChannelTurnTextStream(io.client, "chat", { restore: checkpoint, save() {} });
  assert.equal(await restored.reportTerminalFailure(), true);
  assert.equal(io.texts.length, 1);
  io.setOffline(false);
  assert.equal(await restored.finalize("PRIVATE_FINAL_ANSWER"), true);
  assert.equal(io.starts.length, 1);
  await restored.suspend();
});

test("restored cards do not degrade to text when their template is no longer configured", async () => {
  const texts: string[] = [];
  const stream = new ChannelTurnTextStream(createChannelClient("generic", { ...TEXT_CAPABILITIES, progress: "not-configured" }, {
    async sendText(input) { texts.push(input.text); return { messageId: "text" }; }
  }), "chat", { restore: { messageId: "existing", startedAt: Date.now(), progressEntries: [], thought: "旧状态", answerPreview: "", finished: false }, save() {} });
  assert.equal(stream.supported, true);
  await stream.progress("新进展");
  await stream.flush();
  assert.equal(texts.length, 0);
  await stream.suspend();
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
