import assert from "node:assert/strict";
import test from "node:test";
import { ChannelTurnPresentation, nextTurnCheckpoint } from "../src/channels/turn-presentation.js";
import type { ChannelStreamCheckpoint } from "../src/channels/progress.js";
import { ChannelProgressError } from "../src/channels/errors.js";
import type { ChannelTextClient } from "../src/channels/types.js";

async function until(condition: () => boolean) {
  for (let n = 0; n < 100 && !condition(); n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(condition());
}
function fixture(t: test.TestContext) {
  const starts: Array<{ streamId?: string; text: string }> = [];
  const updates: Array<{ messageId: string; text: string; finalize?: boolean }> = [];
  const saves: ChannelStreamCheckpoint[] = [];
  let failCreate = false, failSummary = false;
  let holdSummary: Promise<void> | undefined;
  const client: ChannelTextClient = { resumableTextStream: true,
    async sendText() { throw new Error("must not send fallback notices"); },
    async startTextStream(input) { starts.push(input); if (failCreate) throw new ChannelProgressError(false);
      return { messageId: input.streamId! }; },
    async updateTextStream(input) { updates.push(input); if (input.text.includes("**阶段小结**")) {
      if (holdSummary) await holdSummary;
      if (failSummary) throw new ChannelProgressError(false, input.messageId);
    } }
  };
  let stream = new ChannelTurnPresentation(client, "room", { save: value => saves.push(structuredClone(value)) });
  t.after(() => stream.suspend());
  return { starts, updates, saves, get stream() { return stream; },
    failCreation(value: boolean) { failCreate = value; }, failSummary(value: boolean) { failSummary = value; },
    holdSummary(value: Promise<void>) { holdSummary = value; },
    async restart() { const restore = stream.checkpoint(); await stream.suspend();
      stream = new ChannelTurnPresentation(client, "room", { restore, save: value => saves.push(structuredClone(value)) }); }
  };
}

for (const kind of ["answer", "steer"] as const) test(`${kind}: old card gets a factual stage summary, next card owns subsequent progress/final`, async t => {
  const f = fixture(t);
  await f.stream.progress("✅ 已完成本地回归"); const original = f.stream.checkpoint().messageId;
  assert.equal(await f.stream.startSegment({ id: "input-1", kind }), true);
  await until(() => f.updates.some(update => update.messageId === original && update.finalize));
  const summary = f.updates.find(update => update.messageId === original && update.finalize)!.text;
  assert.match(summary, /阶段小结/); assert.match(summary, /已完成本地回归/); assert.match(summary, /不会停止原任务/);
  const current = f.stream.checkpoint().messageId; assert.notEqual(current, original);
  assert.equal(f.stream.checkpoint().finished, false); assert.equal(f.stream.checkpoint().terminal, undefined);
  await f.stream.progress("开始部署下一阶段"); await f.stream.flush();
  assert.equal(f.updates.at(-1)?.messageId, current);
  assert.equal(await f.stream.finalize("完整最终结果"), true);
  assert.equal(f.updates.at(-1)?.text, "完整最终结果"); assert.equal(f.updates.at(-1)?.messageId, current);
  assert.equal(f.starts.length, 2);
});

test("rotation intent precedes new-card creation; restart and repeated native receipts cannot create duplicate cards", async t => {
  const f = fixture(t); await f.stream.progress("第一阶段");
  await f.stream.startSegment({ id: "stable-native-id", kind: "answer" });
  await until(() => f.stream.checkpoint().segments?.previous.length === 0);
  const current = f.stream.checkpoint().streamId;
  assert.ok(f.saves.some(saved => saved.streamId === current && !saved.creationAttempted && saved.segments?.acceptedInputs.includes("stable-native-id")));
  await f.restart();
  assert.equal(await f.stream.startSegment({ id: "stable-native-id", kind: "answer" }), false);
  await f.stream.progress("重启后继续"); await f.stream.flush();
  assert.equal(f.stream.checkpoint().streamId, current); assert.equal(f.starts.length, 2);
});

test("lost new-card create receipt keeps its stable attempt and never creates another card for the same input", async t => {
  const f = fixture(t); await f.stream.progress("之前的进展"); f.failCreation(true);
  await f.stream.startSegment({ id: "input", kind: "steer" });
  const failed = f.stream.checkpoint(); assert.equal(failed.creationAttempted, true); assert.equal(failed.messageId, undefined);
  await f.restart(); f.failCreation(false);
  assert.equal(await f.stream.startSegment({ id: "input", kind: "steer" }), false);
  await f.stream.progress("后续仍应保留未知创建，不自动重建");
  assert.equal(f.starts.length, 2); assert.equal(f.stream.checkpoint().streamId, failed.streamId);
});

test("failed/late old-summary acknowledgements do not block or overwrite the new card; recovery only updates the old handle", async t => {
  const f = fixture(t); await f.stream.progress("旧阶段内容"); const original = f.stream.checkpoint().messageId;
  let release!: () => void; f.holdSummary(new Promise(resolve => { release = resolve; }));
  f.failSummary(true);
  await f.stream.startSegment({ id: "answer", kind: "answer" });
  const current = f.stream.checkpoint().messageId;
  await f.stream.progress("新阶段不中断"); await f.stream.flush();
  assert.equal(f.updates.at(-1)?.messageId, current); assert.notEqual(current, original);
  release(); await until(() => Boolean(f.stream.checkpoint().segments?.previous[0]?.checkpoint.presentationFailure) || f.updates.length > 1);
  await f.restart(); f.failSummary(false); await f.stream.synchronize();
  await until(() => f.stream.checkpoint().segments?.previous.length === 0);
  assert.equal(f.starts.length, 2); assert.equal(f.stream.checkpoint().messageId, current);
  assert.ok(f.updates.some(update => update.messageId === original && update.finalize));
  assert.equal(f.stream.checkpoint().finished, false);
});

test("a card for a consumed queued turn is created only on progress after its real native start", async t => {
  const f = fixture(t); await f.stream.progress("上一轮公开进展"); const original = f.stream.checkpoint().messageId;
  await f.stream.nextTurn("queued-native-turn");
  assert.equal(f.starts.length, 1); assert.equal(f.stream.checkpoint().messageId, undefined);
  await until(() => f.updates.some(update => update.messageId === original && update.finalize));
  assert.match(f.updates.find(update => update.messageId === original && update.finalize)!.text, /已开始新的任务轮次/);
  await f.stream.progress("原生队列任务已开始"); assert.equal(f.starts.length, 2);
  await f.stream.nextTurn("queued-native-turn"); assert.equal(f.starts.length, 2);
});

test("answer streaming after a split does not copy the previous accumulated preview into the new card, while final output remains complete", async t => {
  const f = fixture(t); await f.stream.progress("开始"); await f.stream.answer("旧阶段的回复");
  await f.stream.startSegment({ id: "input", kind: "steer" }); await f.restart();
  await f.stream.answer("旧阶段的回复新阶段的回复"); await f.stream.flush();
  assert.equal(f.stream.checkpoint().answerPreview, "新阶段的回复");
  await f.stream.finalize("未经裁剪的完整最终回复"); assert.equal(f.updates.at(-1)?.text, "未经裁剪的完整最终回复");
});

test("turn checkpoint carryover preserves only failed stage summaries, never an old task's terminal payload", () => {
  const frame: ChannelStreamCheckpoint = { startedAt: 1, progressEntries: [], thought: "", answerPreview: "", finished: true,
    terminal: { text: "OLD_MODEL_FINAL", error: false }, segments: { acceptedInputs: ["old-input"], previous: [{
      inputId: "old-input", attempts: 1, checkpoint: { startedAt: 1, messageId: "old-card", progressEntries: [], thought: "", answerPreview: "",
        finished: false, terminal: { text: "旧阶段小结", error: false } }
    }] } };
  const next = nextTurnCheckpoint(frame)!;
  assert.equal(next.finished, false); assert.equal(next.terminal, undefined);
  assert.deepEqual(next.segments?.acceptedInputs, []); assert.equal(next.segments?.previous[0].checkpoint.messageId, "old-card");
  assert.doesNotMatch(JSON.stringify(next), /OLD_MODEL_FINAL/);
});
