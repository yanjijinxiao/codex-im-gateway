import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexDesktopRequestMonitor, type CodexDesktopRequestMonitorOptions, type CodexDesktopUserInput } from "../src/server/codex-desktop-request-monitor.js";
import { asyncUserInputReply, type NativeAsyncAnswerReceipt } from "../src/codex/async-user-input.js";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("question fixture condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function frame(socket: net.Socket, data: unknown) {
  const payload = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
  socket.write(Buffer.concat([header, payload]));
}
async function fixture(t: test.TestContext, options: Partial<CodexDesktopRequestMonitorOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-question-"));
  const socketPath = path.join(root, "ipc.sock");
  const messages: Array<Record<string, any>> = [];
  const inputs: CodexDesktopUserInput[] = [];
  const results: string[] = [];
  const sockets = new Set<net.Socket>();
  let peer!: net.Socket;
  const server = net.createServer(socket => {
    peer = socket; sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) break;
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
        buffer = buffer.subarray(length + 4); messages.push(message);
        if (message.method === "initialize") frame(socket, { type: "response", method: "initialize",
          requestId: message.requestId, resultType: "success", result: { clientId: "test-client" } });
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  const monitor = new CodexDesktopRequestMonitor({ socketPath, reconnectDelayMs: 10_000, decisionTimeoutMs: 100,
    onApproval: async () => { throw new Error("question is not an approval"); }, ...options,
    onUserInput: async input => {
      inputs.push(input);
      return options.onUserInput ? options.onUserInput(input) : { [input.request.questions[0].id]: { answers: ["我的回答"] } };
    },
    onUserInputResult: async (input, result) => { results.push(result); await options.onUserInputResult?.(input, result); }
  });
  t.after(() => { monitor.stop(); for (const socket of sockets) socket.destroy(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  monitor.followThread("thread"); monitor.start();
  await waitFor(() => messages.some(m => m.method === "thread-stream-following-changed"));
  const send = (change: unknown, hostId = "local") => frame(peer, { type: "broadcast", method: "thread-stream-state-changed",
    params: { conversationId: "thread", hostId, change } });
  const snapshot = (state: unknown, hostId = "local") => send({ type: "snapshot", conversationState: state }, hostId);
  const patches = (patches: unknown[], hostId = "local") => send({ type: "patches", patches }, hostId);
  const writes = () => messages.filter(m => ["thread-follower-submit-user-input", "thread-follower-steer-turn"].includes(m.method));
  const respond = (result: unknown, includeMethod = true) => { const m = writes().at(-1)!;
    frame(peer, { type: "response", ...(includeMethod ? { method: m.method } : {}), requestId: m.requestId, resultType: "success", result }); };
  return { monitor, peer, messages, inputs, results, snapshot, patches, writes, respond };
}

const native = { id: 42, method: "item/tool/requestUserInput", params: {
  threadId: "thread", turnId: "turn", itemId: "item", autoResolutionMs: null,
  questions: [{ id: "native-question", header: "问题", question: "目录在哪？" }]
} };
const asyncTurn = { turnId: "turn", status: "inProgress", items: [{ type: "agentMessage", id: "call",
  questions: [{ title: "farming 在哪里？" }] }] };
function asyncState(canonical = false) {
  return { requests: [], threadRuntimeStatus: { type: "active" }, ...(canonical
    ? { turnHistory: { history: { entitiesByKey: { turn: asyncTurn } } } } : { turns: [asyncTurn] }) };
}

test("an unrouted question is retried only after a fresh native snapshot and then submitted once", async t => {
  let routable = false;
  const f = await fixture(t, { deferredRetryDelayMs: 10, onUserInput: async input => routable
    ? { [input.request.questions[0].id]: { answers: ["明确回答"] } } : undefined });
  f.snapshot(asyncState()); await waitFor(() => f.inputs.length === 1);
  await waitFor(() => f.messages.filter(m => m.method === "thread-stream-following-changed").length >= 2);
  routable = true;
  f.patches([{ op: "add", path: ["cwd"], value: "/tmp/project" }]);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.inputs.length, 1, "cached patches cannot authorize a deferred delivery");
  assert.equal(f.writes().length, 0);
  f.snapshot(asyncState()); await waitFor(() => f.writes().length === 1);
  f.respond({ turnId: "turn" }); await waitFor(() => f.results.includes("confirmed"));
  f.snapshot(asyncState()); await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.inputs.length, 2); assert.equal(f.writes().length, 1);
});

test("primary/binding refresh rechecks native state and never forwards a question already removed in the App", async t => {
  const f = await fixture(t, { onUserInput: async () => undefined });
  f.snapshot(asyncState()); await waitFor(() => f.inputs.length === 1);
  const count = f.messages.filter(m => m.method === "thread-stream-following-changed").length;
  f.monitor.setFollowedThreads(["thread"]);
  await waitFor(() => f.messages.filter(m => m.method === "thread-stream-following-changed").length > count);
  assert.equal(f.inputs.length, 1);
  f.snapshot({ requests: [], threadRuntimeStatus: { type: "idle" }, turns: [] });
  await waitFor(() => f.results.includes("withdrawn"));
  assert.equal(f.inputs.length, 1); assert.equal(f.writes().length, 0);
});

test("a stopped monitor cancels deferred rerouting probes without sending an answer", async t => {
  const f = await fixture(t, { deferredRetryDelayMs: 15, onUserInput: async () => undefined });
  f.snapshot(asyncState()); await waitFor(() => f.inputs.length === 1);
  f.monitor.stop();
  const count = f.messages.length;
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.messages.length, count); assert.equal(f.writes().length, 0);
});

test("deferred routing never retries an answer whose native submission receipt became unknown", async t => {
  let routable = false;
  const f = await fixture(t, { deferredRetryDelayMs: 5, decisionTimeoutMs: 20,
    onUserInput: async input => routable ? { [input.request.questions[0].id]: { answers: ["回答"] } } : undefined });
  f.snapshot(asyncState()); await waitFor(() => f.inputs.length === 1);
  await waitFor(() => f.messages.filter(m => m.method === "thread-stream-following-changed").length >= 2);
  routable = true; f.snapshot(asyncState()); await waitFor(() => f.results.includes("failed"));
  assert.equal(f.writes().length, 1);
  f.monitor.setFollowedThreads(["thread"]); f.snapshot(asyncState());
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.inputs.length, 2); assert.equal(f.writes().length, 1);
});

test("remote async answers use host-scoped follower v2 and cannot be confirmed by a local twin", async t => {
  const remote = "remote-ssh-discovered:test";
  const f = await fixture(t);
  f.monitor.followThread("thread", remote);
  await waitFor(() => f.messages.some(m => m.method === "thread-stream-following-changed" && m.params.hostId === remote));
  f.snapshot(asyncState(), remote); await waitFor(() => f.writes().length === 1);
  const rpc = f.writes()[0];
  assert.equal(f.inputs[0].hostId, remote); assert.equal(f.inputs[0].request.hostId, remote);
  assert.equal(rpc.hostId, remote); assert.equal(rpc.version, 2); assert.equal(rpc.params.hostId, undefined);
  assert.deepEqual(rpc.params.restoreMessage, { context: {} });
  const answered = { ...asyncState(), turns: [{ ...asyncTurn, items: [...asyncTurn.items,
    { type: "steeringUserMessage", status: "accepted", input: rpc.params.input }] }] };
  f.snapshot(answered, "local"); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.results, []);
  f.snapshot(answered, remote); await waitFor(() => f.results.length === 1);
  assert.deepEqual(f.results, ["confirmed"]); assert.equal(f.writes().length, 1);
});

test("unfollowing a local twin does not withdraw a pending remote question", async t => {
  const remote = "remote-host";
  let answer!: (value: Record<string, { answers: string[] }>) => void;
  const f = await fixture(t, { onUserInput: async () => new Promise(resolve => { answer = resolve; }) });
  f.monitor.followThread("thread", remote); f.snapshot(asyncState(), remote);
  await waitFor(() => f.inputs.length === 1);
  f.monitor.setFollowedThreads([{ threadId: "thread", hostId: remote }]);
  assert.deepEqual(f.results, []);
  answer({ [f.inputs[0].request.questions[0].id]: { answers: ["回答"] } });
  await waitFor(() => f.writes().length === 1); f.respond({ result: { turnId: "turn" } });
  await waitFor(() => f.results.length === 1); assert.deepEqual(f.results, ["confirmed"]);
});

for (const includeMethod of [true, false]) test(`flat async receipts require the same turn: method=${includeMethod}`, async t => {
  const f = await fixture(t); f.snapshot(asyncState()); await waitFor(() => f.writes().length === 1);
  f.respond({ turnId: "turn" }, includeMethod); await waitFor(() => f.results.length === 1);
  assert.deepEqual(f.results, ["confirmed"]); assert.equal(f.writes().length, 1);
});

test("async answer provides Desktop restore context without overriding native settings", async t => {
  const f = await fixture(t); f.snapshot(asyncState()); await waitFor(() => f.writes().length === 1);
  const params = f.writes()[0].params;
  assert.deepEqual(params.restoreMessage, { context: {} });
  // The native owner dereferences both objects before accepting an answer.
  // Optional values must fall back to the existing native conversation.
  const cwd = params.restoreMessage.cwd ?? "native-cwd";
  const mode = params.restoreMessage.context.collaborationMode ?? "native-mode";
  assert.equal(cwd, "native-cwd"); assert.equal(mode, "native-mode");
  assert.equal(params.toolOutput, undefined);
  f.respond({ result: { turnId: "turn" } }); await waitFor(() => f.results.length === 1);
  assert.deepEqual(f.results, ["confirmed"]); assert.equal(f.writes().length, 1);
});

test("matching accepted native answer settles a missing RPC receipt without resending the answer", async t => {
  const receipts: NativeAsyncAnswerReceipt[] = [];
  const f = await fixture(t, { onObservedUserInputAnswers: values => { receipts.push(...values); } });
  f.snapshot(asyncState()); await waitFor(() => f.writes().length === 1);
  f.patches([{ op: "add", path: ["turns", 0, "items", 1], value: { type: "userMessage", content: [{ type: "text", text: f.writes()[0].params.input[0].text }] } }]);
  await waitFor(() => f.results.length === 1);
  assert.deepEqual(f.results, ["confirmed"]); assert.equal(receipts.length, 1); assert.equal(f.writes().length, 1);
  await new Promise(resolve => setTimeout(resolve, 110)); assert.deepEqual(f.results, ["confirmed"]);
});

test("different accepted answer cannot acknowledge our submitted answer", async t => {
  const f = await fixture(t, { decisionTimeoutMs: 25 }); f.snapshot(asyncState());
  await waitFor(() => f.writes().length === 1);
  f.patches([{ op: "add", path: ["turns", 0, "items", 1], value: { type: "userMessage", content: [{ type: "text",
    text: f.writes()[0].params.input[0].text.replace("我的回答", "不同回答") }] } }]);
  await waitFor(() => f.results.length > 0); assert.deepEqual(f.results, ["failed"]);
});

test("native pending request replies by requestId and waits for an explicit receipt", async t => {
  const f = await fixture(t);
  f.snapshot({ requests: [native] }); f.snapshot({ requests: [native] });
  await waitFor(() => f.writes().length === 1);
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.writes()[0].params, { conversationId: "thread", requestId: 42,
    response: { answers: { "native-question": { answers: ["我的回答"] } } } });
  assert.deepEqual(f.results, []);
  f.snapshot({ requests: [] }); f.respond({ ok: true });
  await waitFor(() => f.results.length === 1);
  assert.deepEqual(f.results, ["confirmed"]);
});

for (const canonical of [false, true]) test(`screenshot-style async widget uses native questionItemId: canonical=${canonical}`, async t => {
  const f = await fixture(t);
  f.snapshot(asyncState(canonical));
  await waitFor(() => f.writes().length === 1);
  const rpc = f.writes()[0];
  assert.equal(rpc.method, "thread-follower-steer-turn");
  // Legacy native schema does not support a compare-and-steer parameter.
  assert.equal(rpc.params.expectedTurnId, undefined);
  assert.match(rpc.params.input[0].text, /^<send_user_message_question_reply>/);
  const row = JSON.parse(rpc.params.input[0].text.split("\n")[1])[0];
  assert.equal(row.questionItemId, '["request_user_input_async","call",0]');
  assert.equal(row.question, "farming 在哪里？");
  assert.equal(row.answer, "我的回答");
  f.respond({ result: { turnId: "turn" } });
  await waitFor(() => f.results.length === 1);
  assert.deepEqual(f.results, ["confirmed"]);
  f.snapshot(asyncState(canonical)); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.writes().length, 1);
});

for (const failure of ["missing-receipt", "wrong-turn", "timeout", "disconnect"] as const) {
  test(`async answer remains unconfirmed and is never retried after ${failure}`, async t => {
    const f = await fixture(t, { decisionTimeoutMs: 25 });
    f.snapshot(asyncState()); await waitFor(() => f.writes().length === 1);
    if (failure === "missing-receipt") f.respond({});
    if (failure === "wrong-turn") f.respond({ result: { turnId: "another-turn" } });
    if (failure === "disconnect") f.peer.destroy();
    await waitFor(() => f.results.length > 0);
    assert.deepEqual(f.results, ["failed"]);
    if (failure !== "disconnect") {
      f.snapshot(asyncState()); await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.writes().length, 1);
  });
}

for (const reason of ["App-answer", "turn-end", "unfollow", "disconnect"] as const) {
  test(`pending async question is invalidated without sending a late answer: ${reason}`, async t => {
    let answer!: (value: Record<string, { answers: string[] }>) => void;
    const f = await fixture(t, { onUserInput: async () => new Promise(resolve => { answer = resolve; }) });
    f.snapshot(asyncState(true)); await waitFor(() => f.inputs.length === 1);
    if (reason === "App-answer") f.patches([{ op: "add", path: ["turnHistory", "history", "entitiesByKey", "turn", "items", 1],
      value: { type: "steeringUserMessage", status: "accepted", input: [{ type: "text", text: asyncUserInputReply(f.inputs[0].request,
        { [f.inputs[0].request.questions[0].id]: { answers: ["来自 App"] } }) }] } }]);
    if (reason === "turn-end") f.patches([{ op: "replace", path: ["turnHistory", "history", "entitiesByKey", "turn", "status"], value: "completed" }]);
    if (reason === "unfollow") f.monitor.setFollowedThreads([]);
    if (reason === "disconnect") f.peer.destroy();
    await waitFor(() => f.results.length > 0);
    assert.equal(f.results[0], reason === "unfollow" || reason === "disconnect" ? "suspended" : "withdrawn");
    answer({ [f.inputs[0].request.questions[0].id]: { answers: ["too late"] } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.writes().length, 0);
  });
}

test("a sibling async question survives another question being answered in the App", async t => {
  const f = await fixture(t, { onUserInput: async () => undefined });
  const state = asyncState();
  state.turns![0] = structuredClone(asyncTurn);
  state.turns![0].items[0].questions.push({ title: "第二个问题？" });
  f.snapshot(state); await waitFor(() => f.inputs.length === 2);
  f.patches([{ op: "add", path: ["turns", 0, "items", 1], value: { type: "userMessage", content: [{ type: "text",
    text: asyncUserInputReply(f.inputs[0].request, { [f.inputs[0].request.questions[0].id]: { answers: ["App"] } }) }] } }]);
  await waitFor(() => f.results.length === 1);
  assert.equal(f.inputs.length, 2);
  assert.deepEqual(f.results, ["withdrawn"]);
});

test("pending sync request removal cancels the handler rather than manufacturing skip", async t => {
  let answer!: (value: Record<string, { answers: string[] }>) => void;
  const f = await fixture(t, { onUserInput: async () => new Promise(resolve => { answer = resolve; }) });
  f.snapshot({ requests: [native] }); await waitFor(() => f.inputs.length === 1);
  f.patches([{ op: "remove", path: ["requests", 0] }]);
  await waitFor(() => f.results.length === 1);
  answer({ "native-question": { answers: ["late"] } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.results, ["withdrawn"]); assert.equal(f.writes().length, 0);
});

test("native question without an ok receipt is not marked confirmed", async t => {
  const f = await fixture(t); f.snapshot({ requests: [native] });
  await waitFor(() => f.writes().length === 1); f.respond({});
  await waitFor(() => f.results.length === 1);
  assert.deepEqual(f.results, ["failed"]);
});

test("invalid patch suspends a stale question and requests a fresh snapshot without submitting an answer", async t => {
  let answer!: (value: Record<string, { answers: string[] }>) => void;
  const f = await fixture(t, { onUserInput: async () => new Promise(resolve => { answer = resolve; }) });
  f.snapshot({ requests: [native] }); await waitFor(() => f.inputs.length === 1);
  f.patches([{ op: "replace", path: ["requests", 4], value: native }]);
  await waitFor(() => f.results.length === 1);
  assert.deepEqual(f.results, ["suspended"]);
  answer({ "native-question": { answers: ["late answer"] } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.writes().length, 0);
  assert.ok(f.messages.filter(message => message.method === "thread-stream-following-changed").length >= 2);
});

test("patching a question never mutates the request already presented to the human", async t => {
  const f = await fixture(t, { onUserInput: async () => undefined });
  f.snapshot({ requests: [native], turnHistory: { largeUntouched: "x".repeat(1024 * 1024) } });
  await waitFor(() => f.inputs.length === 1);
  f.patches([{ op: "replace", path: ["requests", 0, "params", "questions", 0, "question"], value: "新问题" }]);
  await waitFor(() => f.inputs.length === 2);
  assert.equal(f.inputs[0].request.questions[0].question, "目录在哪？");
  assert.equal(f.inputs[1].request.questions[0].question, "新问题");
  assert.equal(f.writes().length, 0);
});
