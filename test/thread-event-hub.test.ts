import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import type { CodexThreadSnapshot } from "../src/codex/backend.js";

test("a loaded snapshot can deliver a short next turn completed between polling ticks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-short-turn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes: string[] = [];
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "main", recipientId: "chat", managed: false,
    client: { async sendText(x) { writes.push(x.text); return { messageId: "text" }; } }
  };
  let turns: CodexThreadSnapshot["turns"] = [];
  const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), subscriptions: () => [sub],
    backend: () => ({ async readThreadSnapshot() {
      return { state: { threadId: "main", persistence: "active", runtimeStatus: "idle", activeFlags: [] }, turns };
    } })
  });
  await hub.refresh();
  await hub.started("local", "main", "first", "2026-09-10T00:00:00Z");
  await hub.completion("local", "main", "first", "第一轮完成");
  turns = [{ id: "second", status: "completed", messages: [{ id: "answer", role: "assistant", text: "快速第二轮完成" }] }];
  await hub.refresh();
  await hub.refresh();
  assert.deepEqual(writes, ["第一轮完成", "快速第二轮完成"]);
  await hub.stop();
});

test("foreign and delayed turn events cannot replace an active card or emit internal results", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-turn-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes: Array<{ text: string; finalize?: boolean }> = [];
  let starts = 0;
  const sub: ThreadSubscription = {
    key: "binding", hostId: "local", threadId: "main", recipientId: "chat", managed: false,
    client: {
      async sendText(input) { writes.push(input); return { messageId: "text" }; },
      async startTextStream(input) { starts++; writes.push(input); return { messageId: `card-${starts}` }; },
      async updateTextStream(input) { writes.push(input); }
    }
  };
  const options = { filePath: path.join(root, "follow.json"), subscriptions: () => [sub],
    backend: () => ({ async readThreadSnapshot(): Promise<CodexThreadSnapshot> {
      return { state: { threadId: "main", persistence: "active", runtimeStatus: "notLoaded", activeFlags: [] }, turns: [] };
    } })
  };
  const hub = new ThreadEventHub(options);
  await hub.started("local", "main", "user-turn", "2026-09-10T01:00:00Z");
  await hub.activity("local", "main", "user-turn", "正常进展");
  const count = writes.length;
  for (let i = 0; i < 20; i++) {
    await hub.activity("local", "main", `review-${i}`, "INTERNAL_PROGRESS");
    await hub.completion("local", "main", `review-${i}`, '{"outcome":"allow"}');
  }
  assert.equal(writes.length, count);
  assert.equal(starts, 1);
  await hub.completion("local", "main", "user-turn", "真实结论");
  await hub.started("local", "main", "next-turn", "2026-09-10T01:01:00Z");
  await hub.activity("local", "main", "next-turn", "下一轮进展");
  const nextCount = writes.length;
  await hub.started("local", "main", "unknown-old-turn", "2026-09-10T00:59:00Z");
  await hub.activity("local", "main", "user-turn", "旧进展");
  await hub.completion("local", "main", "user-turn", "旧结论");
  assert.equal(writes.length, nextCount);
  assert.equal(starts, 2);
  assert.equal(writes.filter((x) => x.finalize).length, 1);
  assert.equal(writes.find((x) => x.finalize)?.text, "真实结论");
  await hub.stop();
  const restarted = new ThreadEventHub(options);
  await restarted.activity("local", "main", "user-turn", "重启后的旧进展");
  assert.equal(writes.length, nextCount);
  await restarted.stop();
});

test("legacy polluted checkpoints are not replayed after upgrading the event boundary", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-legacy-checkpoint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "follow.json");
  const leaked = "INTERNAL_REVIEW_MUST_NOT_REPLAY";
  fs.writeFileSync(filePath, JSON.stringify({ binding: {
    hostId: "local", threadId: "main", turnId: "review-turn", sequence: 1, initialized: true,
    completed: [], baseline: [], delivered: [],
    terminalPending: { turnId: "review-turn", text: leaked, fallbackSent: false },
    checkpoint: { messageId: "old-card", startedAt: Date.now(), progressEntries: [leaked],
      thought: leaked, answerPreview: leaked, finished: false }
  } }));
  const writes: string[] = [];
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "main", recipientId: "chat", managed: false,
    client: { resumableTextStream: true,
      async sendText(x) { writes.push(x.text); return { messageId: "text" }; },
      async startTextStream(x) { writes.push(x.text); return { messageId: "new-card" }; },
      async updateTextStream(x) { writes.push(x.text); }
    }
  };
  const hub = new ThreadEventHub({ filePath, subscriptions: () => [sub], backend: () => ({
    async readThreadSnapshot() { return { state: { threadId: "main", persistence: "active", runtimeStatus: "notLoaded", activeFlags: [] }, turns: [] }; }
  }) });
  await hub.refresh();
  assert.equal(writes.length, 0);
  await hub.started("local", "main", "real-turn", new Date().toISOString());
  await hub.activity("local", "main", "real-turn", "正常进度");
  assert.ok(writes.some((x) => x.includes("正常进度")));
  assert.ok(writes.every((x) => !x.includes(leaked)));
  assert.ok(!fs.readFileSync(filePath, "utf8").includes(leaked));
  await hub.stop();
});

test("recovers a managed turn that completed offline before the first snapshot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-managed-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let starts = 0;
  const finalized: string[] = [];
  const sub: ThreadSubscription = {
    key: "binding", hostId: "local", threadId: "", recipientId: "chat", managed: true,
    client: {
      resumableTextStream: true,
      async startTextStream() { starts++; return { messageId: "original" }; },
      async updateTextStream(input) {
        if (input.finalize) { assert.equal(input.messageId, "original"); finalized.push(input.text); }
      },
      async sendText() { throw new Error("must reuse original card"); }
    }
  };
  const options = { filePath: path.join(root, "follow.json"), subscriptions: () => [sub],
    backend: () => ({ async readThreadSnapshot(): Promise<CodexThreadSnapshot> {
      return {
        state: { threadId: "created-thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] },
        turns: [{ id: "new-turn", status: "completed", messages: [{ id: "final", role: "assistant", text: "离线完成的结果" }] }]
      };
    } })
  };
  const first = new ThreadEventHub(options);
  await first.managedStream(sub).progress("任务已提交");
  sub.threadId = "created-thread";
  first.managedStarted(sub, "new-turn");
  await first.stop();
  sub.managed = false;
  const restarted = new ThreadEventHub(options);
  await restarted.refresh();
  await restarted.refresh();
  assert.equal(starts, 1);
  assert.deepEqual(finalized, ["离线完成的结果"]);
  await restarted.stop();
});

test("notLoaded snapshots never finalize a Desktop-owned turn and late progress cannot reopen it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-not-loaded-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes: Array<{ text: string; finalize?: boolean }> = [];
  let starts = 0;
  const sub: ThreadSubscription = {
    key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
    client: {
      resumableTextStream: true,
      async sendText(input) { writes.push(input); return { messageId: "text" }; },
      async startTextStream(input) { starts++; writes.push(input); return { messageId: "card" }; },
      async updateTextStream(input) { writes.push(input); }
    }
  };
  const hub = new ThreadEventHub({
    filePath: path.join(root, "follow.json"), subscriptions: () => [sub],
    backend: () => ({ async readThreadSnapshot() {
      return { state: { threadId: "thread", persistence: "active", runtimeStatus: "notLoaded", activeFlags: [] },
        turns: [{ id: "turn", status: "interrupted", messages: [] }] };
    } })
  });
  await hub.refresh();
  await hub.activity("local", "thread", "turn", "检查实际进展");
  await hub.refresh();
  assert.equal(writes.filter((write) => write.finalize).length, 0);
  await hub.completion("local", "thread", "turn", "最终结果");
  const count = writes.length;
  await hub.activity("local", "thread", "turn", "延迟到达的旧进展");
  await hub.refresh();
  assert.equal(writes.length, count);
  assert.equal(starts, 1);
  assert.equal(writes.at(-1)?.text, "最终结果");
  await hub.stop();
});

test("recovers the original card after a turn completes offline and suppresses repeated final events", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-follow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes: Array<{ messageId?: string; text: string; finalize?: boolean }> = [];
  let starts = 0;
  const sub: ThreadSubscription = {
    key: "account/chat", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
    client: {
      resumableTextStream: true,
      async sendText(input) { writes.push(input); return { messageId: "text" }; },
      async startTextStream(input) { starts++; writes.push(input); return { messageId: "card-original" }; },
      async updateTextStream(input) { writes.push(input); }
    }
  };
  let snapshot: CodexThreadSnapshot = {
    state: { threadId: "thread", persistence: "active", runtimeStatus: "active", activeFlags: [], activeTurnId: "turn" },
    turns: [
      { id: "old", status: "completed", messages: [{ id: "old-answer", role: "assistant", text: "OLD_HISTORY" }] },
      { id: "turn", status: "inProgress", messages: [{ id: "p", role: "assistant", kind: "progress", text: "检查测试结果" }] }
    ]
  };
  const options = { filePath: path.join(root, "follow.json"), subscriptions: () => [sub],
    backend: () => ({ async readThreadSnapshot() { return snapshot; } }) };
  const first = new ThreadEventHub(options);
  await first.refresh();
  assert.equal(starts, 1);
  assert.ok(writes.some((write) => write.text.includes("检查测试结果")));
  assert.ok(writes.every((write) => !write.text.includes("OLD_HISTORY")));
  await first.stop();
  snapshot = {
    state: { ...snapshot.state, runtimeStatus: "idle", activeTurnId: undefined },
    turns: [{ id: "turn", status: "completed", messages: [{ id: "answer", role: "assistant", text: "真实结论" }] }]
  };
  const restarted = new ThreadEventHub(options);
  await restarted.refresh();
  assert.equal(starts, 1, "restart must reuse the original persisted card");
  assert.deepEqual(writes.at(-1), { toUserId: "chat", messageId: "card-original", text: "真实结论", finalize: true });
  const count = writes.length;
  await restarted.refresh();
  await restarted.completion("local", "thread", "turn", "真实结论");
  assert.equal(writes.length, count);
  await restarted.stop();
});

test("isolates identical thread ids by host and closes a card when follow is disabled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-host-follow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputs: string[] = [];
  const sub: ThreadSubscription = {
    key: "remote-binding", hostId: "ssh:one", threadId: "same-id", recipientId: "chat", managed: false,
    client: {
      resumableTextStream: true,
      async sendText(input) { outputs.push(input.text); return { messageId: "plain" }; },
      async startTextStream(input) { outputs.push(input.text); return { messageId: "card" }; },
      async updateTextStream(input) { outputs.push(input.text); }
    }
  };
  let subscriptions = [sub];
  const hub = new ThreadEventHub({
    filePath: path.join(root, "follow.json"), subscriptions: () => subscriptions,
    backend: () => ({ async readThreadSnapshot() {
      return { state: { threadId: "same-id", persistence: "active", runtimeStatus: "active", activeFlags: [] }, turns: [] };
    } })
  });
  await hub.activity("local", "same-id", "t", "WRONG_HOST");
  assert.equal(outputs.length, 0);
  await hub.activity("ssh:one", "same-id", "t", "远程进展");
  assert.equal(outputs.length, 1);
  subscriptions = [];
  await hub.refresh();
  assert.match(outputs.at(-1)!, /已停止跟随/);
  const count = outputs.length;
  await hub.activity("ssh:one", "same-id", "t", "不再投递");
  assert.equal(outputs.length, count);
  await hub.stop();
});

test("retries a failed terminal card update after restart without repeating its fallback answer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-terminal-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fail = true, starts = 0, texts = 0, finalized = 0;
  const sub: ThreadSubscription = {
    key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
    client: {
      resumableTextStream: true,
      async startTextStream() { starts++; return { messageId: "original" }; },
      async sendText() { texts++; return { messageId: "fallback" }; },
      async updateTextStream(input) {
        if (input.finalize && fail) throw new Error("temporary failure");
        if (input.finalize) { assert.equal(input.messageId, "original"); finalized++; }
      }
    }
  };
  const options = { filePath: path.join(root, "follow.json"), subscriptions: () => [sub],
    backend: () => ({ async readThreadSnapshot(): Promise<CodexThreadSnapshot> {
      return {
        state: { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] },
        turns: [{ id: "turn", status: "completed", messages: [{ id: "final", role: "assistant", text: "结果" }] }]
      };
    } })
  };
  const first = new ThreadEventHub(options);
  await first.activity("local", "thread", "turn", "正在运行");
  await first.completion("local", "thread", "turn", "结果");
  assert.equal(texts, 1);
  await first.stop();
  fail = false;
  const restarted = new ThreadEventHub(options);
  await restarted.refresh();
  await restarted.refresh();
  assert.equal(finalized, 1);
  assert.equal(starts, 1);
  assert.equal(texts, 1);
  await restarted.stop();
});
