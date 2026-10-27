import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelApprovalController } from "../src/bridge/approval.js";
import { ChannelUserInputController } from "../src/bridge/user-input-controller.js";
import type { CodexUserInputRequest } from "../src/codex/backend.js";

const request: CodexUserInputRequest = { requestId: 1, threadId: "thread", turnId: "turn", itemId: "item",
  autoResolutionMs: null, questions: [{ id: "question", header: "确认", question: "继续吗？" }] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-interaction-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function failWrites(file: string) {
  const original = fs.renameSync;
  fs.renameSync = ((from, to) => { if (to === file) throw Error("injected journal failure"); return original(from, to); }) as typeof fs.renameSync;
  return () => { fs.renameSync = original; };
}
async function within<T>(promise: Promise<T>): Promise<T | "blocked"> {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([promise, new Promise<"blocked">(resolve => { timer = setTimeout(() => resolve("blocked"), 100); })]); }
  finally { clearTimeout(timer!); }
}

test("a hung question card send cannot block an answer, and its late receipt updates the resolved card", async t => {
  const filePath = path.join(fixture(t), "questions.json"), updates: string[] = [];
  let sent!: (receipt: {messageId: string}) => void;
  const controller = new ChannelUserInputController(() => new Promise(resolve => { sent = resolve; }), undefined,
    { filePath, updateCard: async id => { updates.push(id); }, sendNotice: async () => {} });
  t.after(() => controller.close());
  const answer = controller.request("room", request);
  controller.answer("room", "Q1 继续");
  assert.deepEqual(await within(answer), { question: { answers: ["继续"] } });
  await controller.reportResult("room", request, "confirmed");
  sent({messageId: "late-card"}); await tick(); await tick();
  assert.deepEqual(updates, ["late-card"]);
});
test("a native question timeout is independent of an unacknowledged send", async t => {
  const controller = new ChannelUserInputController(() => new Promise(() => {}));
  t.after(() => controller.close());
  assert.deepEqual(await within(controller.request("room", { ...request, autoResolutionMs: 5 })), {});
});
test("late question delivery receipts cannot overwrite a replacement controller's journal", async t => {
  const filePath = path.join(fixture(t), "questions.json"); let sent!: (receipt: {messageId: string}) => void;
  const old = new ChannelUserInputController(() => new Promise(resolve => { sent = resolve; }), undefined, { filePath });
  const answer = old.request("room", request); old.close();
  const current = new ChannelUserInputController(async () => ({messageId: "current"}), undefined, { filePath });
  t.after(() => current.close());
  const before = fs.readFileSync(filePath, "utf8"); sent({messageId: "old"}); await answer; await tick();
  assert.equal(fs.readFileSync(filePath, "utf8"), before);
});
test("an answer with a failed audit commit remains pending and acquires no audience hold", async t => {
  const filePath = path.join(fixture(t), "questions.json"); let holds = 0;
  const controller = new ChannelUserInputController(async () => {}, undefined,
    { filePath, holdAudience: () => { holds++; return () => {}; } });
  t.after(() => controller.close());
  const answer = controller.request("room", request); await tick();
  const restore = failWrites(filePath);
  try { assert.throws(() => controller.answer("room", "Q1 yes", { bindingKey: "b", conversationId: "room", actorId: "person" }), /injected/); }
  finally { restore(); }
  assert.equal(holds, 0); assert.match(controller.answer("room", "list"), /Q1/);
  controller.answer("room", "Q1 retry"); assert.deepEqual(await answer, { question: { answers: ["retry"] } });
});
test("expiry persistence failure releases the native waiter without submitting an answer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const filePath = path.join(fixture(t), "questions.json");
  const controller = new ChannelUserInputController(async () => {}, undefined, { filePath });
  t.after(() => controller.close());
  const answer = controller.request("room", { ...request, autoResolutionMs: 10 }); await tick();
  const restore = failWrites(filePath);
  try { t.mock.timers.tick(11); assert.equal(await answer, undefined); }
  finally { restore(); }
});
test("audit failures prohibit approval but cannot block denial of remaining native waiters", async t => {
  const file = path.join(fixture(t), "approvals.json");
  const controller = new ChannelApprovalController(async () => {}, 60000, undefined, file);
  const one = controller.request("room", {kind: "command", threadId: "thread", command: "echo one"});
  const two = controller.request("room", {kind: "command", threadId: "thread", command: "echo two"});
  const restore = failWrites(file);
  try {
    assert.throws(() => controller.decide("room", "A1", "accept"), /injected/);
    assert.equal(controller.list().length, 2);
    assert.doesNotThrow(() => controller.declineAll("room"));
    assert.deepEqual(await Promise.all([one, two]), ["decline", "decline"]);
  } finally { restore(); controller.declineAll("room"); }
});
test("closing native questions releases every waiter even if audience cleanup throws", async () => {
  const controller = new ChannelUserInputController(async () => {}, undefined,
    { holdAudience() { return () => { throw Error("release journal unavailable"); }; } });
  const answered = controller.request("room", request);
  controller.answer("room", "Q1 yes", { bindingKey: "binding", conversationId: "room", actorId: "actor" }); await answered;
  const pending = controller.request("room", { ...request, requestId: 2, itemId: "other" });
  assert.doesNotThrow(() => controller.close()); assert.equal(await within(pending), undefined);
});
test("approval timeout delivery failure is contained and the notice awaits native confirmation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notices: string[] = []; let sends = 0;
  const controller = new ChannelApprovalController((_to, notice) => {
    notices.push(notice.text); if (++sends === 2) throw Error("synchronous transport failure"); return Promise.resolve();
  }, 10);
  const pending = controller.request("room", { kind: "command", threadId: "thread", command: "echo test" });
  assert.doesNotThrow(() => t.mock.timers.tick(11)); assert.equal(await pending, "decline");
  await tick(); assert.match(notices.at(-1)!, /等待.*确认|以.*回执/); assert.doesNotMatch(notices.at(-1)!, /已自动拒绝/);
});
test("an optional audience hold failure cannot strand a durably accepted answer", async t => {
  const controller = new ChannelUserInputController(async () => {}, undefined,
    { holdAudience() { throw Error("audience journal unavailable"); } });
  t.after(() => controller.close());
  const result = controller.request("room", request);
  assert.doesNotThrow(() => controller.answer("room", "Q1 yes", { bindingKey: "binding", conversationId: "room", actorId: "person" }));
  assert.deepEqual(await within(result), { question: { answers: ["yes"] } });
});
test("an unsent question whose delivery-intent commit failed can retry after storage recovers", async t => {
  const filePath = path.join(fixture(t), "questions.json"); let sent = 0, writes = 0;
  const controller = new ChannelUserInputController(async () => { sent++; }, undefined, { filePath });
  t.after(() => controller.close());
  const rename = fs.renameSync, mock = t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === filePath && ++writes === 2) throw Error("delivery intent not committed");
    return rename(from, to);
  });
  await assert.rejects(controller.request("room", request), /not committed/); mock.mock.restore();
  assert.equal(sent, 0);
  const result = controller.request("room", request); await tick();
  assert.equal(sent, 1); controller.answer("room", "Q1 yes"); await result;
});
test("long native deadlines use bounded timers and cannot auto-resolve before the original deadline", async t => {
  let now = 1000;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
    timers.push({ callback, delay }); return { unref() {} };
  }) as unknown as typeof setTimeout);
  const controller = new ChannelUserInputController(async () => {});
  t.after(() => controller.close());
  const pending = controller.request("room", { ...request, autoResolutionMs: 3_000_000_000 });
  assert.ok(timers[0].delay <= 2_147_483_647);
  now += timers[0].delay; timers[0].callback();
  assert.match(controller.answer("room", "list"), /Q1/);
  assert.equal(timers.length, 2); now = 3_000_001_000; timers[1].callback();
  assert.deepEqual(await pending, {});
});
