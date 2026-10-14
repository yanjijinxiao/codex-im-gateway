import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelUserInputController } from "../src/bridge/user-input-controller.js";
import type { CodexUserInputRequest } from "../src/codex/backend.js";
import { parseUserInputRequest } from "../src/codex/user-input.js";
import { desktopAsyncUserInputs, asyncUserInputReply, asyncAnswerDigest, desktopAsyncAnswerReceipts } from "../src/codex/async-user-input.js";
import { formatChannelActionCommand, parseChannelActionValue, type ChannelActionCard } from "../src/channels/action-card.js";
import { feishuActionCard } from "../src/channels/feishu-action-card.js";
import { parseCommand } from "../src/bridge/channel-commands.js";

const request: CodexUserInputRequest = { hostId: "local", requestId: 42, threadId: "thread", turnId: "turn", itemId: "item",
  questions: [{ id: "native-question", header: "问题", question: "farming 是项目还是目录？" }], autoResolutionMs: null };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "question notice fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fixture(t: test.TestContext, options: ConstructorParameters<typeof ChannelUserInputController>[2] = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "question-journal-"));
  const filePath = path.join(root, "questions.json");
  const cards: ChannelActionCard[] = [];
  const notices: string[] = [];
  const controllers: ChannelUserInputController[] = [];
  const create = () => {
    const controller = new ChannelUserInputController(async (_sender, card) => {
    cards.push(card); return { messageId: `card-${cards.length}` };
  }, undefined, { filePath, sendNotice: async (_sender, text) => { notices.push(text); }, ...options });
    controllers.push(controller); return controller;
  };
  const controller = create();
  t.after(() => { for (const instance of controllers) instance.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { controller, create, filePath, cards, notices };
}

test("free-form question includes all IM instructions, form and durable native identity", async t => {
  const f = fixture(t);
  const result = f.controller.request("room", request);
  assert.match(f.cards[0].fallbackText, /farming 是项目还是目录/);
  assert.match(f.cards[0].fallbackText, /\/answer Q1 回答内容/);
  assert.match(f.cards[0].fallbackText, /\/skip Q1/);
  assert.equal(f.cards[0].form?.submit.value.version, 4);
  assert.match(f.controller.answer("room", "Q1 我已创建 farming\n路径含  两个空格"), /回执/);
  assert.deepEqual(await result, { "native-question": { answers: ["我已创建 farming\n路径含  两个空格"] } });
  assert.match(f.controller.answer("room", "Q1 再次回答"), /未提交/);
  const journal = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  assert.equal(journal.records[0].threadId, "thread");
  assert.equal(journal.records[0].status, "submitting");
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
  await f.controller.reportResult("room", request, "confirmed");
  assert.match(f.notices[0], /Codex 已确认/);
  assert.ok(!fs.readFileSync(f.filePath, "utf8").includes("我已创建"));
});

test("literal numeric answer is not silently interpreted as an option", async t => {
  const f = fixture(t);
  const r = { ...request, questions: [{ ...request.questions[0], options: [{ label: "目录", description: "文件夹" }] }] };
  const result = f.controller.request("room", r);
  f.controller.answer("room", "Q1 1");
  assert.deepEqual(await result, { "native-question": { answers: ["1"] } });
  await f.controller.reportResult("room", r, "confirmed");
  const r2 = { ...r, requestId: "second" };
  const selected = f.controller.request("room", r2);
  assert.match(f.controller.answer("room", "Q2 --option 3"), /选项不存在/);
  f.controller.answer("room", "Q2 --option 1");
  assert.deepEqual(await selected, { "native-question": { answers: ["目录"] } });
});

test("wrong conversation or switched binding cannot answer or skip a question", async t => {
  let bound = true;
  const f = fixture(t, { validate: () => bound });
  const result = f.controller.request("room", request);
  assert.match(f.controller.answer("other-room", "Q1 answer"), /未提交/);
  bound = false;
  assert.match(f.controller.answer("room", "Q1 answer"), /未提交/);
  assert.match(f.controller.skip("room", "Q1"), /未提交/);
  bound = true;
  f.controller.skip("room", "Q1");
  assert.deepEqual(await result, {});
});

test("secret question never includes content, options or answer form in IM", async t => {
  const f = fixture(t);
  const result = f.controller.request("room", { ...request, questions: [{ ...request.questions[0], isSecret: true }] });
  assert.doesNotMatch(f.cards[0].fallbackText, /farming/);
  assert.equal(f.cards[0].form, undefined);
  assert.equal(f.cards[0].actionGroups.length, 0);
  assert.match(f.controller.answer("room", "Q1 secret"), /敏感/);
  f.controller.close();
  assert.equal(await result, undefined);
  assert.ok(!fs.readFileSync(f.filePath, "utf8").includes('"answer":"secret"'));
});

test("App withdrawal releases the handler without sending a synthetic skip", async t => {
  const f = fixture(t);
  const result = f.controller.request("room", request);
  await f.controller.reportResult("room", request, "withdrawn");
  assert.equal(await result, undefined);
  assert.match(f.controller.answer("room", "Q1 late"), /未提交/);
  assert.match(f.notices[0], /已失效/);
});

test("switching a binding releases its waiting handler so another correct route can attach", async t => {
  let bound = true; const f = fixture(t, { validate: () => bound });
  const pending = f.controller.request("room", request);
  bound = false; f.controller.suspendInvalidBindings();
  assert.equal(await pending, undefined);
  assert.match(f.controller.answer("room", "Q1 late"), /未提交/);
  bound = true;
  const resumed = f.controller.request("room", request);
  f.controller.answer("room", "Q1 correct");
  assert.deepEqual(await resumed, { "native-question": { answers: ["correct"] } });
  assert.equal(f.cards.length, 1);
});

test("restart resumes the same Q ID, does not repeat its card or a partial answer", async t => {
  const f = fixture(t);
  const r = { ...request, questions: [...request.questions, { id: "second", header: "路径", question: "路径在哪？" }] };
  const old = f.controller.request("room", r);
  assert.equal(f.controller.request("room", r), old);
  f.controller.answer("room", "Q1 目录");
  await tick();
  assert.equal(f.cards.length, 2);
  f.controller.close();
  assert.equal(await old, undefined);
  const restarted = f.create();
  const resumed = restarted.request("room", r);
  assert.equal(f.cards.length, 2);
  assert.match(restarted.answer("room", "list"), /Q2/);
  restarted.answer("room", "Q2 /workspace/farming");
  assert.deepEqual(await resumed, { "native-question": { answers: ["目录"] }, second: { answers: ["/workspace/farming"] } });
  restarted.close();
});

test("restart never replays a submission without a native receipt", async t => {
  const f = fixture(t);
  const initial = f.controller.request("room", request);
  f.controller.answer("room", "Q1 answer");
  await initial;
  f.controller.close();
  const restarted = f.create();
  assert.equal(restarted.hasRequest("room", request), true);
  assert.equal(await restarted.request("room", request), undefined);
  assert.equal(f.cards.length, 1);
  assert.match(restarted.answer("room", "Q1 answer"), /未提交/);
  restarted.close();
});

test("failed notice delivery leaves the native request unanswered and manually discoverable", async () => {
  const controller = new ChannelUserInputController(async () => { throw new Error("provider timeout"); });
  const pending = controller.request("room", request);
  await tick();
  assert.match(controller.answer("room", "list"), /farming/);
  controller.close();
  assert.equal(await pending, undefined);
});

test("only an explicit native timeout expires a question; null has no default expiry", async t => {
  const cards: ChannelActionCard[] = [];
  const controller = new ChannelUserInputController(async (_, card) => { cards.push(card); }, 1);
  const first = controller.request("room", request);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(controller.answer("room", "list"), /Q1/);
  controller.close();
  assert.equal(await first, undefined);
  // close ends this controller's lifetime; a restarted account creates a new
  // controller rather than reopening old callbacks against its replacement.
  const restored = new ChannelUserInputController(async (_, card) => { cards.push(card); }, 1);
  const timed = restored.request("room", { ...request, requestId: 99, autoResolutionMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(await timed, {});
  assert.match(restored.answer("room", "Q1 late"), /未提交/);
  assert.equal(await controller.request("room", request), undefined);
  restored.close();
});

test("question form actions validate exact Q IDs and preserve free text/newlines", () => {
  const value = parseChannelActionValue({ version: 4, command: "answer", arg: "submit", questionId: "Q7" })!;
  const command = formatChannelActionCommand(value, { answer: "我增加了目录\n里面有  两个文件" })!;
  assert.deepEqual(parseCommand(command), { name: "answer", arg: "Q7 我增加了目录\n里面有  两个文件" });
  assert.equal(formatChannelActionCommand(value, { answer: " " }), undefined);
  assert.equal(formatChannelActionCommand(value, { answer: "x".repeat(2001) }), undefined);
  assert.equal(parseChannelActionValue({ ...value, questionId: "A1" }), undefined);
});

test("Feishu question form uses the shared callback payload and never hides text instructions", async () => {
  let card!: ChannelActionCard;
  const controller = new ChannelUserInputController(async (_, value) => { card = value; });
  const pending = controller.request("room", request);
  const payload = feishuActionCard(card);
  const form = payload.elements.find(element => element.tag === "form") as { elements: Array<Record<string, unknown>> };
  assert.equal(form.elements[0].name, "answer");
  assert.equal(form.elements[1].action_type, "form_submit");
  assert.deepEqual(form.elements[1].value, card.form?.submit.value);
  assert.ok(JSON.stringify(payload).includes("/answer Q1"));
  controller.close(); await pending;
});

test("native request parser preserves free-form/secret semantics and rejects malformed identities", () => {
  assert.equal(parseUserInputRequest(request)?.autoResolutionMs, null);
  assert.equal(parseUserInputRequest({ ...request, questions: [{ ...request.questions[0], isSecret: true }] })?.questions[0].isSecret, true);
  for (const invalid of [{ ...request, turnId: "" }, { ...request, questions: [request.questions[0], request.questions[0]] },
    { ...request, autoResolutionMs: -1 }, { ...request, questions: [{ ...request.questions[0], options: "wrong" }] }]) {
    assert.equal(parseUserInputRequest(invalid), undefined);
  }
});

function asyncState() {
  return { threadRuntimeStatus: { type: "active" }, turns: [{ turnId: "old", status: "completed", items: [] },
    { turnId: "turn", status: "inProgress", items: [{ type: "agentMessage", id: "call_123",
      questions: [{ title: "farming 在哪里？" }, { title: "继续吗？", options: ["继续", "停止"] }] }] }] };
}

test("native answer evidence requires the original widget, exact question and accepted structured envelope", () => {
  const state = asyncState(); const r = desktopAsyncUserInputs("thread", state)[0];
  const text = asyncUserInputReply(r, { [r.questions[0].id]: { answers: ["目录"] } });
  const accepted = { type: "steeringUserMessage", status: "accepted", input: [{ type: "text", text }] };
  state.turns[1].items.push(accepted as never);
  const receipts = desktopAsyncAnswerReceipts("thread", state);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].digest, asyncAnswerDigest(r.questions[0].id, r.questions[0].question, "目录"));
  accepted.status = "pending"; assert.equal(desktopAsyncAnswerReceipts("thread", state).length, 0);
  accepted.status = "accepted";
  accepted.input[0].text = `quoted ${text}`; assert.equal(desktopAsyncAnswerReceipts("thread", state).length, 0);
  accepted.input[0].text = text.replace("farming 在哪里？", "另一个问题"); assert.equal(desktopAsyncAnswerReceipts("thread", state).length, 0);
  accepted.input[0].text = text;
  state.turns[1].status = "completed";
  assert.equal(desktopAsyncAnswerReceipts("thread", { threadRuntimeStatus: { type: "idle" }, turnHistory: { history: {
    entitiesByKey: { turn: state.turns[1] } } } }).length, 1);
});

test("native evidence repairs an uncertain answer after restart without replay and confirmation never regresses", async t => {
  const f = fixture(t); const r = desktopAsyncUserInputs("thread", asyncState())[0];
  const pending = f.controller.request("room", r);
  f.controller.answer("room", "Q1 目录"); await pending;
  await f.controller.reportResult("room", r, "failed");
  assert.doesNotMatch(fs.readFileSync(f.filePath, "utf8"), /\"answer\"\s*:/);
  f.controller.close(); const restored = f.create(); t.after(() => restored.close());
  const receipt = { hostId: "local" as const, threadId: r.threadId, turnId: r.turnId, questionId: r.questions[0].id,
    digest: asyncAnswerDigest(r.questions[0].id, r.questions[0].question, "目录") };
  for (const wrong of [{ ...receipt, turnId: "other" }, { ...receipt, threadId: "other" },
    { ...receipt, digest: "wrong" }, { ...receipt, questionId: "other" }]) await restored.observeNativeAnswers([wrong]);
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].status, "unconfirmed");
  await restored.observeNativeAnswers([receipt]);
  await restored.observeNativeAnswers([receipt]);
  await restored.reportResult("room", r, "failed"); await restored.reportResult("room", r, "withdrawn");
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].status, "confirmed");
  assert.equal(f.cards.length, 1); assert.equal(f.notices.filter(n => n.includes("已确认接收")).length, 1);
});

test("native evidence cannot confirm a never-submitted answer or cross a changed binding", async t => {
  let bound = true; const f = fixture(t, { validate: () => bound });
  const r = desktopAsyncUserInputs("thread", asyncState())[0];
  const pending = f.controller.request("room", r);
  const receipt = { hostId: "local" as const, threadId: r.threadId, turnId: r.turnId, questionId: r.questions[0].id,
    digest: asyncAnswerDigest(r.questions[0].id, r.questions[0].question, "目录") };
  await f.controller.observeNativeAnswers([receipt]);
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].status, "pending");
  f.controller.answer("room", "Q1 目录"); await pending; await f.controller.reportResult("room", r, "failed");
  bound = false; await f.controller.observeNativeAnswers([receipt]);
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].status, "unconfirmed");
});

test("native acceptance survives acknowledgement-card failure and retries only the same question card", async t => {
  const updates: Array<{ id: string; title: string }> = [];
  const f = fixture(t, { noticeRetryDelayMs: 5, updateCard: async (id, card) => {
    updates.push({ id, title: card.title });
    if (updates.length === 1) throw new Error("HTTP 503");
  } });
  const pending = f.controller.request("room", request);
  f.controller.answer("room", "Q1 回答"); await pending;
  await f.controller.reportResult("room", request, "confirmed");
  let row = JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0];
  assert.equal(row.status, "confirmed"); assert.equal(row.noticeDelivery, "unconfirmed");
  assert.match(f.controller.answer("room", "list"), /Codex 已确认.*IM 确认通知尚未送达/);
  assert.match(f.controller.answer("room", "Q1 再次回答"), /已确认.*未提交/);
  await until(() => JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].noticeDelivery === "delivered");
  row = JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0];
  assert.equal(row.status, "confirmed"); assert.equal(row.noticeAttempts, 2);
  assert.deepEqual(updates.map(update => update.id), ["card-1", "card-1"]);
  assert.ok(updates.every(update => update.title.includes("回答已接收")));
  assert.equal(f.cards.length, 1); assert.equal(f.notices.length, 0);
  assert.equal(await f.controller.request("room", request), undefined, "the native answer is never resubmitted");
});

test("restart restores an unsent confirmation-card update without replaying the native answer", async t => {
  let attempts = 0, recovered = false;
  const f = fixture(t, { noticeRetryDelayMs: 10_000, updateCard: async id => {
    assert.equal(id, "card-1"); attempts++;
    if (!recovered) throw new Error("connection disconnected");
  } });
  const pending = f.controller.request("room", request);
  f.controller.answer("room", "Q1 回答"); await pending;
  await f.controller.reportResult("room", request, "confirmed");
  f.controller.close();
  // Model a crash during a replace-card request; its retry is idempotent.
  const journal = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  journal.records[0].noticeDelivery = "pending";
  fs.writeFileSync(f.filePath, JSON.stringify(journal));
  recovered = true;
  const restored = f.create(); t.after(() => restored.close());
  await until(() => JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].noticeDelivery === "delivered");
  assert.equal(attempts, 2); assert.equal(f.cards.length, 1); assert.equal(f.notices.length, 0);
  assert.equal(await restored.request("room", request), undefined);
});

test("failed plain acknowledgement is recorded as uncertain, not resent after restart", async t => {
  let sends = 0;
  const f = fixture(t, { sendNotice: async () => { sends++; throw new Error("lost response"); } });
  const pending = f.controller.request("room", request);
  f.controller.answer("room", "Q1 回答"); await pending;
  await f.controller.reportResult("room", request, "confirmed");
  f.controller.close(); const restored = f.create(); t.after(() => restored.close());
  await restored.reportResult("room", request, "confirmed");
  await tick(); assert.equal(sends, 1);
  const row = JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0];
  assert.equal(row.status, "confirmed"); assert.equal(row.noticeDelivery, "unconfirmed");
  assert.equal(row.noticeRetryAt, undefined);
});

test("confirmation-card retries stop for a changed binding and do not leak into another conversation", async t => {
  let bound = true, attempts = 0;
  const f = fixture(t, { noticeRetryDelayMs: 5, validate: () => bound, updateCard: async () => { attempts++; throw new Error("HTTP 503"); } });
  const pending = f.controller.request("room", request);
  f.controller.answer("room", "Q1 回答"); await pending;
  await f.controller.reportResult("room", request, "confirmed");
  bound = false; f.controller.suspendInvalidBindings();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(attempts, 1);
  assert.doesNotMatch(f.controller.answer("other-room", "list"), /Q1/);
  assert.doesNotMatch(f.controller.answer("room", "list"), /Q1/);
});

test("confirmation-card retry is bounded and permanent rejection is not retried", async t => {
  for (const detail of ["HTTP 503", "HTTP 403"]) {
    let attempts = 0;
    const f = fixture(t, { noticeRetryDelayMs: 5, updateCard: async () => { attempts++; throw new Error(detail); } });
    const pending = f.controller.request("room", request);
    f.controller.answer("room", "Q1 回答"); await pending;
    await f.controller.reportResult("room", request, "confirmed");
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(attempts, detail === "HTTP 503" ? 3 : 1);
    const row = JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0];
    assert.equal(row.status, "confirmed"); assert.equal(row.noticeRetryAt, undefined);
  }
});

test("unconfirmed answer and later acceptance use distinct truthful question-card statuses", async t => {
  const titles: string[] = [];
  const f = fixture(t, { updateCard: async (_id, card) => { titles.push(card.title); } });
  const pending = f.controller.request("room", request);
  f.controller.answer("room", "Q1 回答"); await pending;
  await f.controller.reportResult("room", request, "failed");
  assert.match(titles[0], /等待接收确认/);
  assert.match(f.controller.answer("room", "list"), /未获 Codex 确认/);
  await f.controller.reportResult("room", request, "confirmed");
  await f.controller.reportResult("room", request, "failed");
  assert.deepEqual(titles.map(title => title.split(" · ")[1]), ["等待接收确认", "回答已接收"]);
});

test("late acknowledgement updates cannot overwrite a restarted question journal", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, { updateCard: async () => { await gate; } });
  const pending = f.controller.request("room", request);
  f.controller.answer("room", "Q1 回答"); await pending;
  const acknowledgement = f.controller.reportResult("room", request, "confirmed");
  await tick(); f.controller.close();
  const restored = f.create();
  const next = restored.request("room", { ...request, requestId: "new-request" });
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records.length, 2);
  release(); await acknowledgement;
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records.length, 2);
  await f.controller.reportResult("room", request, "failed");
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].status, "confirmed");
  assert.equal(await f.controller.request("room", request), undefined);
  restored.close(); assert.equal(await next, undefined);
});

test("a stale failed-state update cannot supersede the newer native confirmation", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const titles: string[] = [];
  const f = fixture(t, { updateCard: async (_id, card) => {
    titles.push(card.title); if (titles.length === 1) await gate;
  } });
  const pending = f.controller.request("room", request);
  f.controller.answer("room", "Q1 回答"); await pending;
  const failed = f.controller.reportResult("room", request, "failed");
  await tick(); const confirmed = f.controller.reportResult("room", request, "confirmed");
  release(); await Promise.all([failed, confirmed]);
  assert.deepEqual(titles.map(title => title.split(" · ")[1]), ["等待接收确认", "回答已接收"]);
  const row = JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0];
  assert.equal(row.status, "confirmed"); assert.equal(row.noticeOutcome, "confirmed"); assert.equal(row.noticeDelivery, "delivered");
});

test("Desktop async widgets have independent stable identities and the exact native answer envelope", () => {
  const state = asyncState();
  const requests = desktopAsyncUserInputs("thread", state);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].kind, "async");
  assert.equal(requests[0].turnId, "turn");
  assert.equal(requests[0].questions[0].id, '["request_user_input_async","call_123",0]');
  const reply = asyncUserInputReply(requests[0], { [requests[0].questions[0].id]: { answers: ["目录"] } });
  assert.match(reply, /^<send_user_message_question_reply>/);
  const row = JSON.parse(reply.split("\n")[1])[0];
  assert.deepEqual(row, { questionItemId: requests[0].questions[0].id, question: "farming 在哪里？", answer: "目录" });
  state.turns[1].items.push({ type: "steeringUserMessage", id: "answer", status: "accepted",
    input: [{ type: "text", text: reply }] } as never);
  const remaining = desktopAsyncUserInputs("thread", state);
  assert.deepEqual(remaining.map(r => r.requestId), [requests[1].requestId]);
  assert.throws(() => asyncUserInputReply(requests[0], { wrong: { answers: ["bad"] } }), /another question/);
  const skip = JSON.parse(asyncUserInputReply(requests[1], {}).split("\n")[1]);
  assert.equal(skip[0].answer, "");
});

test("only live unanswered async widgets are forwarded; canonical turn history wins over old turns", () => {
  const state = asyncState();
  assert.equal(desktopAsyncUserInputs("thread", { ...state, threadRuntimeStatus: { type: "idle" } }).length, 0);
  assert.equal(desktopAsyncUserInputs("thread", { ...state, turnHistory: { history: { entitiesByKey: {} } } }).length, 0);
  assert.equal(desktopAsyncUserInputs("thread", { ...state, turns: [], turnHistory: { history: {
    entitiesByKey: { turn: state.turns[1] } } } }).length, 2);
  state.turns[1].status = "completed";
  assert.equal(desktopAsyncUserInputs("thread", state).length, 0);
});

test("an editable answered widget is not redispatched; optimistic or mismatched answers are not confirmations", () => {
  const state = asyncState();
  const request = desktopAsyncUserInputs("thread", state)[0];
  const text = asyncUserInputReply(request, { [request.questions[0].id]: { answers: ["钉钉答案"] } });
  const answer = { type: "steeringUserMessage", id: "answer", status: "pending", input: [{ type: "text", text }] };
  state.turns[1].items.push(answer as never);
  assert.equal(desktopAsyncUserInputs("thread", state).length, 2);
  answer.status = "accepted";
  assert.equal(desktopAsyncUserInputs("thread", state).length, 1);
  assert.equal(desktopAsyncAnswerReceipts("thread", state).length, 1);
  answer.input[0].text = text.replace("farming 在哪里？", "不同的问题");
  assert.equal(desktopAsyncUserInputs("thread", state).length, 2);
  assert.equal(desktopAsyncAnswerReceipts("thread", state).length, 0);
});
