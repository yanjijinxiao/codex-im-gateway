import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import type { CodexThreadSnapshot } from "../src/codex/backend.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-confirmed-system-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "follow.json");
  const state = {
    eventVersion: 2, deliveryVersion: 1, hostId: "local", threadId: "thread", turnId: "turn",
    checkpointTurnId: "turn", sequence: 0, initialized: true, delivered: [] as string[], completed: [] as string[],
    baseline: [] as string[], retired: [] as string[],
    historyBoundary: { version: 1, turnId: "turn", startedAt: "2026-10-26T03:52:41.000Z" },
    checkpoint: { streamId: "original", messageId: "original", startedAt: Date.now(), progressEntries: [],
      thought: "", answerPreview: "", statusHeader: true, finished: false }
  };
  const snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "systemError",
    activeFlags: [], lastTurnFailure: { turnId: "turn", code: "upstream-connection" } },
    turns: [{ id: "turn", status: "failed", startedAt: "2026-10-26T03:52:41.000Z",
      messages: [{ id: "answer", role: "assistant", text: "在的，你说。" }] }] };
  const updates: Array<{ messageId: string; text: string; finalize?: boolean; error?: boolean }> = [];
  const texts: string[] = [];
  let failUpdate = false;
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
    client: { resumableTextStream: true,
      async sendText(input) { texts.push(input.text); return { messageId: "notice" }; },
      async startTextStream() { assert.fail("must reuse the original card"); },
      async updateTextStream(input) {
        assert.equal(input.messageId, "original");
        if (failUpdate) throw new Error("temporary connection timeout");
        updates.push(input);
      }
    }
  };
  const save = (value: unknown = state) => fs.writeFileSync(filePath, JSON.stringify({ binding: value }));
  const read = () => JSON.parse(fs.readFileSync(filePath, "utf8")).binding;
  const create = (options: Partial<ConstructorParameters<typeof ThreadEventHub>[0]> = {}) => {
    const hub = new ThreadEventHub({ filePath, subscriptions: () => [{ ...sub }],
      backend: () => ({ async readThreadSnapshot() { return snapshot; } }), ...options });
    t.after(() => hub.stop());
    return hub;
  };
  save();
  return { state, snapshot, sub, updates, texts, save, read, create, failUpdates: (fail: boolean) => { failUpdate = fail; } };
}

test("systemError settles an explicitly failed tracked turn on the original card exactly once", async t => {
  const f = fixture(t), hub = f.create();
  await hub.refresh();
  await hub.synchronize("binding");
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].finalize, true);
  assert.equal(f.updates[0].error, true);
  assert.match(f.updates[0].text, /执行失败/);
  assert.match(f.updates[0].text, /原生轮次已确认失败/);
  assert.match(f.updates[0].text, /已生成的回复（本轮未成功完成）/);
  assert.match(f.updates[0].text, /在的，你说/);
  assert.deepEqual(f.texts, []);
  assert.equal(f.read().checkpoint.finished, true);
  assert.equal(f.read().checkpoint.terminal.outcome, "failed");
  assert.deepEqual(f.read().completed, ["turn"]);
  assert.equal(hub.status("binding").runtime?.runtimeStatus, "systemError");
  assert.equal(hub.status("binding").failure?.code, "unavailable");
  assert.equal(hub.status("binding").resultDelivery?.pending, 0);
  assert.equal(hub.status("binding").resultDelivery?.lastDeliveredTurnId, "turn");
});

test("confirmed failure without an answer uses only the normalized failure summary", async t => {
  const f = fixture(t);
  f.snapshot.turns[0].messages = [{ id: "progress", role: "assistant", kind: "progress", text: "not a final answer" }];
  const hub = f.create();
  await hub.synchronize("binding");
  assert.equal(f.updates.length, 1);
  assert.match(f.updates[0].text, /连接、响应流或超时错误/);
  assert.doesNotMatch(f.updates[0].text, /not a final answer|已生成的回复/);
});

test("failed terminal delivery persists and retries the same card after restart", async t => {
  const f = fixture(t), first = f.create();
  f.failUpdates(true);
  await first.synchronize("binding");
  assert.equal(f.read().checkpoint.finished, false);
  assert.equal(f.read().terminalPending.turnId, "turn");
  assert.equal(f.read().terminalPending.outcome, "failed");
  await first.stop();
  f.failUpdates(false);
  const resumed = f.create();
  await resumed.synchronize("binding");
  await resumed.synchronize("binding");
  assert.equal(f.updates.length, 1);
  assert.equal(f.read().checkpoint.messageId, "original");
  assert.equal(f.read().checkpoint.finished, true);
  assert.equal(f.read().terminalPending, undefined);
  assert.equal(resumed.status("binding").resultDelivery?.lastDeliveredTurnId, "turn");
});

for (const reason of ["no-failure-id", "other-failure-id", "no-history", "other-history", "inProgress", "completed",
  "baseline", "retired", "delivered", "other-card", "other-pending", "managed", "cannot-resume", "archived", "missing"] as const) {
  test(`systemError does not settle untrusted or differently owned failure: ${reason}`, async t => {
    const f = fixture(t);
    if (reason === "no-failure-id") delete f.snapshot.state.lastTurnFailure;
    if (reason === "other-failure-id") f.snapshot.state.lastTurnFailure!.turnId = "other";
    if (reason === "no-history") f.snapshot.turns = [];
    if (reason === "other-history") f.snapshot.turns[0].id = "other";
    if (reason === "inProgress" || reason === "completed") f.snapshot.turns[0].status = reason;
    if (reason === "baseline") f.state.baseline.push("turn");
    if (reason === "retired") f.state.retired.push("turn");
    if (reason === "delivered") f.state.completed.push("turn");
    if (reason === "other-card") f.state.checkpointTurnId = "other";
    if (reason === "managed") f.sub.managed = true;
    if (reason === "cannot-resume") f.sub.client.resumableTextStream = false;
    if (reason === "archived" || reason === "missing") f.snapshot.state.persistence = reason;
    f.save({ ...f.state, ...(reason === "other-pending" ? {
      terminalPending: { turnId: "other", text: "other result", fallbackSent: false, outcome: "failed" }
    } : {}) });
    const hub = f.create();
    await hub.synchronize("binding");
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.texts, []);
    assert.equal(f.read().checkpoint.finished, false);
  });
}

test("confirmed systemError failure retains the existing capacity recovery owner", async t => {
  const f = fixture(t);
  f.snapshot.state.lastTurnFailure!.code = "model-capacity";
  let deferred = 0;
  const hub = f.create({ onCapacityFailure(scope) { assert.equal(scope.turnId, "turn"); deferred++; return true; } });
  await hub.synchronize("binding");
  assert.equal(deferred, 1);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.texts, []);
  assert.equal(f.read().checkpoint.finished, false);
});

test("native-text channels receive a confirmed tracked failure exactly once without a card", async t => {
  const f = fixture(t);
  f.save({ ...f.state, checkpoint: undefined });
  f.sub.client = { async sendText(input) { f.texts.push(input.text); return { messageId: "final" }; } };
  const hub = f.create();
  await hub.synchronize("binding");
  await hub.synchronize("binding");
  assert.equal(f.texts.length, 1);
  assert.match(f.texts[0], /原生轮次已确认失败/);
  assert.equal(hub.status("binding").resultDelivery?.lastDeliveredTurnId, "turn");
});

test("a binding change during final decoration cannot deliver into the replacement conversation", async t => {
  const f = fixture(t);
  const hub = f.create({ async decorateFinal(_sub, text) { f.sub.threadId = "replacement"; return text; } });
  await hub.synchronize("binding");
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.texts, []);
});
