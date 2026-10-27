import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";

function fixture(t: test.TestContext, decorateFinal?: () => Promise<string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-hub-owner-"));
  const writes = { old: [] as any[], current: [] as any[] };
  const client = (name: keyof typeof writes) => ({ resumableTextStream: true,
    async sendText(input: unknown) { writes[name].push(input); return { messageId: "text" }; },
    async startTextStream(input: unknown) { writes[name].push({ ...input as object, create: true }); return { messageId: "card" }; },
    async updateTextStream(input: unknown) { writes[name].push(input); } });
  let sub: ThreadSubscription = { key: "same-binding", hostId: "local", threadId: "thread", recipientId: "chat", client: client("old"), managed: false };
  const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), subscriptions: () => [sub], backend: () => ({}), decorateFinal });
  t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { hub, writes, replace() { sub = { ...sub, client: client("current") }; } };
}

test("a pending result cannot publish through a retired channel client", async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = fixture(t, async () => { entered.resolve(); await release.promise; return "result"; });
  await f.hub.started("local", "thread", "turn", new Date().toISOString());
  const pending = f.hub.completion("local", "thread", "turn", "result"); await entered.promise;
  f.replace(); release.resolve(); await pending;
  assert.equal(f.writes.old.length, 0); assert.equal(f.writes.current.length, 0);
});

test("fresh progress after a channel replacement resumes the handle using the new client", async t => {
  const f = fixture(t);
  await f.hub.started("local", "thread", "turn", new Date().toISOString());
  await f.hub.activity("local", "thread", "turn", "first progress");
  const oldCount = f.writes.old.length; f.replace();
  await f.hub.activity("local", "thread", "turn", "new progress");
  await (f.hub as any).streams.get("same-binding").flush();
  assert.equal(f.writes.old.length, oldCount);
  assert.ok(f.writes.current.some(write => write.messageId === "card" && /new progress/.test(write.text)));
  assert.equal(f.writes.current.some(write => write.create), false);
});

test("historical card repair cannot publish through a replaced client before its queued write", async t => {
  const f = fixture(t), wire = f.hub as any;
  const sub = wire.options.subscriptions()[0], state = wire.state(sub);
  state.pendingTerminals = { old: { text: "old result", checkpoint: { streamId: "old", messageId: "old-card",
    startedAt: Date.now(), progressEntries: [], thought: "", answerPreview: "", finished: false } } };
  wire.retryPreviousTerminals(sub, true);
  f.replace();
  await Promise.all([...wire.previousRecoveries.values()]);
  assert.equal(f.writes.old.length, 0); assert.equal(f.writes.current.length, 0);
  assert.ok(state.pendingTerminals.old);
});
