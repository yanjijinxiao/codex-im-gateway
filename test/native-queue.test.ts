import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NativeQueueCoordinator, type QueueOrigin } from "../src/bridge/native-queue.js";
import { APP_SERVER_BACKEND_CAPABILITIES, EXEC_BACKEND_CAPABILITIES,
  type CodexBridgeBackend, type CodexHistoryMessage, type CodexQueuedSubmission } from "../src/codex/backend.js";

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-native-queue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "receipts.json");
  const items: CodexQueuedSubmission[] = [];
  let adds = 0, loseAck = false;
  let history: CodexHistoryMessage[] = [];
  const origin: QueueOrigin = { accountId: "ding", conversationId: "group", actorId: "alice", messageId: "im-1",
    sessionId: "managed-original", threadId: "original", hostId: "local", backend: "app-server" };
  const backend = {
    backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
    async addQueuedSubmission(input: { clientUserMessageId: string; prompt: string }) {
      assert.equal(Object.values(JSON.parse(fs.readFileSync(file, "utf8")).receipts).some((r: any) =>
        r.clientUserMessageId === input.clientUserMessageId && r.status === "submitting"), true, "persist before write");
      adds++;
      const item = { id: "q-" + adds, clientUserMessageId: input.clientUserMessageId,
        input: [{ type: "text", text: input.prompt }] };
      items.push(item); if (loseAck) throw new Error("ack lost after server acceptance"); return item;
    },
    async listQueuedSubmissions() { return { data: structuredClone(items) }; },
    async deleteQueuedSubmission(_thread: string, id: string) {
      const i = items.findIndex(x => x.id === id); if (i < 0) return false; items.splice(i, 1); return true;
    },
    async inspectThread() { return { threadId: "original", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
    async readTurnLifecycle(_thread: string, turnId: string) {
      const turn = history.find(message => message.turnId === turnId);
      return { status: turn?.turnStatus ?? "unknown", source: "owner" };
    },
    async getHistoryPage(_thread: string, input: { cursor?: string }) {
      return input.cursor ? { messages: history } : { messages: [], nextCursor: "older" };
    }
  } as unknown as CodexBridgeBackend;
  return { file, origin, backend, items, get adds() { return adds; }, loseAck() { loseAck = true; },
    setHistory(messages: CodexHistoryMessage[]) { history = messages; },
    journal() { return new NativeQueueCoordinator(file); } };
}

test("native queue owns prompts; receipts retain identity and dedupe across restart", async t => {
  const f = fixture(t); let j = f.journal();
  const r = await j.enqueue(f.origin, "same text", f.backend);
  j = f.journal();
  const repeated = await j.enqueue(f.origin, "same text", f.backend);
  assert.equal(repeated.queuedSubmissionId, r.queuedSubmissionId); assert.equal(f.adds, 1);
  const disk = fs.readFileSync(f.file, "utf8"); assert.ok(!disk.includes("same text")); assert.ok(!disk.includes('"input"'));
  await j.enqueue({ ...f.origin, messageId: "im-2" }, "same text", f.backend);
  await j.enqueue({ ...f.origin, accountId: "feishu" }, "same text", f.backend);
  await j.enqueue({ ...f.origin, actorId: "bob" }, "same text", f.backend);
  assert.equal(f.adds, 4); assert.equal(new Set(f.items.map(x => x.clientUserMessageId)).size, 4);
  await assert.rejects(j.enqueue({ ...f.origin, threadId: "new-binding" }, "same text", f.backend), /原会话/);
});

test("lost add acknowledgement recovers exact client id, never adds again", async t => {
  const f = fixture(t); f.loseAck();
  await assert.rejects(f.journal().enqueue(f.origin, "payload", f.backend), /ack lost/);
  const j = f.journal(); await j.reconcile("ding", f.backend);
  assert.equal(j.list("ding")[0].status, "queued");
  await j.enqueue(f.origin, "payload", f.backend); assert.equal(f.adds, 1);
});

test("a consumed item is reconciled against older history by id, not similar text", async t => {
  const f = fixture(t); const j = f.journal(); const r = await j.enqueue(f.origin, "payload", f.backend);
  f.items.length = 0;
  f.setHistory([{ id: "user", role: "user", text: "different representation", clientUserMessageId: r.clientUserMessageId,
    turnId: "accepted-turn", turnStatus: "inProgress" }]);
  const restored = f.journal(); await restored.reconcile("ding", f.backend);
  assert.equal(restored.list("ding")[0].status, "running"); assert.equal(restored.list("ding")[0].turnId, "accepted-turn");
  f.setHistory([{ id: "user", role: "user", text: "different representation", clientUserMessageId: r.clientUserMessageId,
    turnId: "accepted-turn", turnStatus: "completed" }]);
  await restored.reconcile("ding", f.backend); assert.equal(restored.list("ding")[0].status, "completed");
  assert.equal(f.adds, 1);
});

test("absence in queue/history is uncertain, not permission to replay", async t => {
  const f = fixture(t); const j = f.journal(); await j.enqueue(f.origin, "payload", f.backend); f.items.length = 0;
  f.setHistory([{ id: "lookalike", role: "user", text: "payload", turnId: "unrelated", turnStatus: "completed" }]);
  const restored = f.journal(); await restored.reconcile("ding", f.backend);
  assert.equal(restored.list("ding")[0].status, "uncertain");
  await restored.enqueue(f.origin, "payload", f.backend);
  await restored.dispatch("ding", f.backend, async () => { assert.fail("must not dispatch uncertain records"); });
  assert.equal(f.adds, 1);
});

for (const status of ["inProgress", "unknown", "completed"] as const) test(`foreign interrupted history is identity only; authoritative observation=${status}`, async t => {
  const f = fixture(t), journal = f.journal(), receipt = await journal.enqueue(f.origin, "payload", f.backend);
  f.items.length = 0;
  f.setHistory([{id:"input",role:"user",text:"payload",clientUserMessageId:receipt.clientUserMessageId,turnId:"accepted",turnStatus:"interrupted"}]);
  const backend = {...f.backend,
    async readTurnLifecycle() { return {status, source: status === "unknown" ? "unknown" as const : "owner" as const}; },
    async inspectThread() { return {threadId:"original",persistence:"active" as const,runtimeStatus:"active" as const,executionOwner:"desktop" as const,activeFlags:[],activeTurnId:"accepted"}; }
  } as CodexBridgeBackend;
  const restored = f.journal();
  await restored.reconcile("ding", backend);
  const updated = restored.list("ding")[0];
  assert.equal(updated.turnId,"accepted");
  assert.equal(updated.status,status === "inProgress" ? "running" : status === "completed" ? "completed" : "uncertain");
  await restored.dispatch("ding",backend,async()=>{assert.fail("live owner prevents terminal dispatch even after an observation race");});
  assert.equal(f.adds,1);
  assert.equal(restored.list("ding")[0].delivered,undefined);
});

test("lost add acknowledgement after consumption can observe its exact turn without a queue id", async t => {
  const f = fixture(t); f.loseAck();
  await assert.rejects(f.journal().enqueue(f.origin, "payload", f.backend), /ack lost/);
  const r = f.journal().list("ding")[0];
  assert.equal(r.queuedSubmissionId, undefined);
  f.items.length = 0;
  f.setHistory([{ id: "user", role: "user", text: "payload", clientUserMessageId: r.clientUserMessageId,
    turnId: "auto-consumed", turnStatus: "completed" }]);
  const restored = f.journal(); await restored.reconcile("ding", f.backend);
  await restored.dispatch("ding", f.backend, async (receipt, _starting, started, item) => {
    assert.equal(receipt.turnId, "auto-consumed"); assert.equal(item, undefined);
    started(receipt.turnId!);
  });
  assert.equal(restored.list("ding")[0].delivered, true); assert.equal(f.adds, 1);
});

test("an unavailable thread does not starve recovery or dispatch on another thread", async t => {
  const f = fixture(t), j = f.journal();
  await j.enqueue(f.origin, "first", f.backend);
  await j.enqueue({ ...f.origin, messageId: "im-other", threadId: "healthy" }, "second", f.backend);
  const backend = { ...f.backend, async listQueuedSubmissions(threadId: string) {
    if (threadId === "original") throw new Error("host unavailable");
    return { data: [f.items[1]] };
  } } as CodexBridgeBackend;
  await assert.rejects(j.reconcile("ding", backend), /host unavailable/);
  let delivered = false;
  await assert.rejects(j.dispatch("ding", backend, async (receipt, starting, started) => {
    assert.equal(receipt.threadId, "healthy"); starting(); started("healthy-turn"); delivered = true;
  }), /host unavailable/);
  assert.equal(delivered, true);
  assert.equal(j.list("ding").find(r => r.threadId === "healthy")?.delivered, true);
});

test("different threads dispatch concurrently; same thread cannot be dispatched twice", async t => {
  const f = fixture(t), j = f.journal();
  await j.enqueue(f.origin, "first", f.backend);
  await j.enqueue({ ...f.origin, messageId: "im-other", threadId: "healthy" }, "second", f.backend);
  const backend = { ...f.backend, async listQueuedSubmissions(threadId: string) {
    return { data: [f.items[threadId === "original" ? 0 : 1]] };
  } } as CodexBridgeBackend;
  let release!: () => void, arrived!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const secondStarted = new Promise<void>(resolve => { arrived = resolve; });
  const dispatch = j.dispatch("ding", backend, async (r, starting, started) => {
    starting(); started(r.threadId + "-turn");
    if (r.threadId === "original") await blocked;
    else arrived();
  });
  await secondStarted;
  await j.dispatch("ding", backend, async () => { assert.fail("duplicate dispatch"); });
  release(); await dispatch;
  assert.ok(j.list("ding").every(r => r.delivered));
});

test("terminal results can be recovered read-only after ownership changes", async t => {
  const f = fixture(t), j = f.journal(); const r = await j.enqueue(f.origin, "payload", f.backend);
  f.items.length = 0;
  f.setHistory([{ id: "user", role: "user", text: "payload", clientUserMessageId: r.clientUserMessageId,
    turnId: "finished-turn", turnStatus: "completed" }]);
  await j.reconcile("ding", f.backend);
  const backend = { ...f.backend, async inspectThread() {
    return { threadId: "original", persistence: "active", runtimeStatus: "active", executionOwner: "desktop", activeFlags: [] };
  } } as CodexBridgeBackend;
  await j.dispatch("ding", backend, async (receipt, _starting, started) => {
    assert.equal(receipt.status, "completed"); assert.equal(receipt.turnId, "finished-turn");
    started(receipt.turnId!);
  });
  assert.equal(j.list("ding")[0].delivered, true); assert.equal(f.adds, 1);
});

test("shared dispatch preserves native FIFO, keeps origin, and consumes each item once", async t => {
  const f = fixture(t), j = f.journal(); await j.enqueue(f.origin, "payload", f.backend);
  const foreign = { id: "foreign", clientUserMessageId: "codex-ui", input: [] };
  f.items.unshift(foreign);
  let starts = 0;
  const execute = async (r: any, starting: () => void, started: (id: string) => void) => {
    assert.equal(r.threadId, "original"); assert.equal(r.conversationId, "group"); starting();
    assert.equal(f.journal().list("ding")[0].status, "starting");
    starts++; f.items.shift(); started("real-turn");
    await j.enqueue({ ...f.origin, messageId: "im-2", accountId: "weixin" }, "next", f.backend);
    await j.dispatch("weixin", f.backend, async () => { assert.fail("same thread already dispatching"); });
  };
  await j.dispatch("ding", f.backend, execute); assert.equal(starts, 0);
  f.items.shift(); await j.dispatch("ding", f.backend, execute);
  assert.equal(starts, 1); assert.equal(j.list("ding")[0].status, "completed");
  await j.dispatch("ding", f.backend, execute); assert.equal(starts, 1);
});

test("start acknowledgement loss is reconciled, never submits or starts it again", async t => {
  const f = fixture(t), j = f.journal(); const r = await j.enqueue(f.origin, "payload", f.backend);
  await assert.rejects(j.dispatch("ding", f.backend, async (_receipt, starting) => {
    starting(); f.items.length = 0; throw new Error("start ack lost");
  }), /start ack lost/);
  f.setHistory([{ id: "user", role: "user", text: "payload", clientUserMessageId: r.clientUserMessageId,
    turnId: "actually-started", turnStatus: "completed" }]);
  const restored = f.journal(); await restored.reconcile("ding", f.backend);
  let observations = 0;
  await restored.dispatch("ding", f.backend, async (receipt, _starting, started) => {
    observations++; assert.equal(receipt.turnId, "actually-started");
    started(receipt.turnId!); // Observe the accepted turn, never add/start it.
  });
  await restored.dispatch("ding", f.backend, async () => { assert.fail("no repeated delivery"); });
  assert.equal(observations, 1);
  assert.equal(restored.list("ding")[0].status, "completed"); assert.equal(f.adds, 1);
});

test("cancellation enforces account/conversation/actor and does not interrupt active turns", async t => {
  const f = fixture(t), j = f.journal(); const r = await j.enqueue(f.origin, "payload", f.backend);
  await assert.rejects(j.cancel("ding", "other", "alice", r.queuedSubmissionId!, f.backend), /不属于/);
  await assert.rejects(j.cancel("ding", "group", "bob", r.queuedSubmissionId!, f.backend), /不属于/);
  assert.equal(await j.cancel("ding", "group", "alice", r.queuedSubmissionId!, f.backend), true);
  assert.equal(j.list("ding")[0].status, "cancelled"); assert.equal(f.items.length, 0);
});

test("exec cannot borrow native queue from another backend", async t => {
  const f = fixture(t); const backend = { ...f.backend, backendInfo: () => ({ id: "exec", capabilities: EXEC_BACKEND_CAPABILITIES }) } as CodexBridgeBackend;
  await assert.rejects(f.journal().enqueue({ ...f.origin, backend: "exec" }, "payload", backend), /does not support nativeQueue/);
  assert.equal(f.adds, 0);
});

test("interactive queue reconciliation is conversation-scoped, single-flight and backend-specific", async t => {
  const f = fixture(t), journal = f.journal();
  await journal.enqueue(f.origin, "one", f.backend);
  await journal.enqueue({ ...f.origin, conversationId: "other", messageId: "other", threadId: "other-thread" }, "two", f.backend);
  const release = Promise.withResolvers<void>(), reads: string[] = [];
  const backend = { ...f.backend, async listQueuedSubmissions(threadId: string) { reads.push(threadId); await release.promise; return { data: f.items }; } } as CodexBridgeBackend;
  const a = journal.reconcile("ding", backend, { conversationId: "group" });
  const b = journal.reconcile("ding", backend, { conversationId: "group" });
  assert.equal(a, b);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(reads, ["original"]);
  const replacement = { ...f.backend } as CodexBridgeBackend;
  const c = journal.reconcile("ding", replacement, { conversationId: "group" }); assert.notEqual(c, a);
  release.resolve(); await Promise.all([a, c]); assert.deepEqual(reads, ["original"]);
});

test("read-only queue history reconciliation cannot hold up a new native queue submission", async t => {
  const f = fixture(t), journal = f.journal(); await journal.enqueue(f.origin, "first", f.backend); f.items.length = 0;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const backend = { ...f.backend, async getHistoryPage() { entered.resolve(); await release.promise; return { messages: [] }; } } as CodexBridgeBackend;
  const reading = journal.reconcile("ding", backend); await entered.promise;
  let accepted = false;
  const next = journal.enqueue({ ...f.origin, messageId: "im-2" }, "second", f.backend).then(() => { accepted = true; });
  try { await new Promise(r => setTimeout(r, 30)); assert.equal(accepted, true); }
  finally { release.resolve(); await Promise.all([reading, next]); }
  assert.equal(journal.list("ding").find(r => r.messageId === "im-2")?.status, "queued");
});
test("a late queue observation cannot restore a cancelled native input", async t => {
  const f = fixture(t), journal = f.journal(), receipt = await journal.enqueue(f.origin, "first", f.backend);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), snapshot = structuredClone(f.items);
  const backend = { ...f.backend, async listQueuedSubmissions() { entered.resolve(); await release.promise; return { data: snapshot }; } } as CodexBridgeBackend;
  const reading = journal.reconcile("ding", backend); await entered.promise;
  let cancelled = false; const cancellation = journal.cancel("ding", "group", "alice", receipt.queuedSubmissionId!, f.backend).then(() => { cancelled = true; });
  try { await new Promise(r => setTimeout(r, 30)); assert.equal(cancelled, true); }
  finally { release.resolve(); await Promise.all([reading, cancellation]); }
  assert.equal(journal.list("ding")[0].status, "cancelled"); assert.equal(f.items.length, 0);
});
test("queue observation deadlines preserve uncertainty and ignore late read results", async t => {
  const f = fixture(t), journal = new NativeQueueCoordinator(f.file, { observationTimeoutMs: 20 });
  await journal.enqueue(f.origin, "first", f.backend); f.items.length = 0;
  const release = Promise.withResolvers<void>();
  const backend = { ...f.backend, async getHistoryPage() { await release.promise; return { messages: [] }; } } as CodexBridgeBackend;
  let settled = false;
  const read = journal.reconcile("ding", backend).then(() => { settled = true; }, () => { settled = true; });
  await new Promise(r => setTimeout(r, 40));
  try { assert.equal(settled, true); }
  finally { release.resolve(); await read; }
  assert.equal(journal.list("ding")[0].status, "queued", "a read deadline is not evidence of native rejection or completion");
});
