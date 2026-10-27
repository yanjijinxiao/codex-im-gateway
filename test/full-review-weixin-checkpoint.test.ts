import assert from "node:assert/strict";
import test from "node:test";
import { monitorWeixin } from "../src/weixin/monitor.js";
import type { WeixinApiClient } from "../src/weixin/api.js";

test("polling continues for approvals while a task keeps its source cursor uncommitted", async () => {
  const abort = new AbortController(), release = Promise.withResolvers<void>();
  const checkpoints: string[] = []; let keysWhilePending: string[] = [], polls = 0;
  const monitor = monitorWeixin({ signal: abort.signal, initialSyncKey: "old", pollIntervalMs: 0,
    client: { async getUpdates(cursor: string) {
      if (++polls === 1) return { get_updates_buf: "new", msgs: [{ message_id: "task", from_user_id: "actor", text: "task" }] };
      assert.equal(cursor, "new"); keysWhilePending = [...checkpoints];
      release.resolve(); abort.abort(); return { msgs: [] };
    } } as unknown as WeixinApiClient,
    onSyncKey(key) { checkpoints.push(key); }, async onMessage() { await release.promise; } });
  await monitor; assert.deepEqual(keysWhilePending, []);
});

test("a receipt claim failure keeps the old source cursor for provider redelivery", async () => {
  const abort = new AbortController(), cursors: unknown[] = [], keys: string[] = [];
  let claims = 0, messages = 0;
  const work = monitorWeixin({ signal: abort.signal, initialSyncKey: "old", pollIntervalMs: 1,
    client: { async getUpdates(cursor?: string) {
      cursors.push(cursor); if (cursors.length > 1) abort.abort();
      return { get_updates_buf: "new", msgs: [{ message_id: "task", from_user_id: "actor", text: "task" }] };
    } } as unknown as WeixinApiClient,
    claimMessage() { if (++claims === 1) throw Error("receipt fsync failed"); return true; },
    onSyncKey(key) { keys.push(key); }, async onMessage() { messages++; } });
  await work; assert.deepEqual(cursors, ["old", "old"]); assert.equal(messages, 1);
});

test("finished later batches cannot commit past an earlier unfinished message", async () => {
  const abort = new AbortController(), release = Promise.withResolvers<void>(), committed = Promise.withResolvers<void>();
  const keys: string[] = []; let polls = 0, beforeRelease: string[] = [];
  await monitorWeixin({ signal: abort.signal, pollIntervalMs: 0,
    client: { async getUpdates() {
      if (++polls <= 2) return { get_updates_buf: `batch-${polls}`, msgs: [{ message_id: `message-${polls}`, from_user_id: "actor", text: "hello" }] };
      await new Promise(resolve => setImmediate(resolve)); beforeRelease = [...keys]; release.resolve();
      await committed.promise; abort.abort(); return { msgs: [] };
    } } as unknown as WeixinApiClient,
    onSyncKey(key) { keys.push(key); if (key === "batch-2") committed.resolve(); },
    async onMessage(message) { if (message.id === "message-1") await release.promise; } });
  assert.deepEqual(beforeRelease, []); assert.equal(keys.at(-1), "batch-2");
});

test("coalescing completed cursors cannot remove a cursor being persisted", async () => {
  const abort = new AbortController(), release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), last = Promise.withResolvers<void>();
  const keys: string[] = []; let polls = 0;
  await monitorWeixin({ signal: abort.signal, pollIntervalMs: 0,
    client: { async getUpdates() {
      polls++;
      if (polls === 2) await entered.promise;
      if (polls <= 3) return { get_updates_buf: `batch-${polls}`, msgs: [{ message_id: `m-${polls}`, from_user_id: "actor", text: "hello" }] };
      await new Promise(resolve => setImmediate(resolve)); release.resolve(); await last.promise; abort.abort(); return { msgs: [] };
    } } as unknown as WeixinApiClient,
    async onSyncKey(key) { keys.push(key); if (key === "batch-1") { entered.resolve(); await release.promise; } if (key === "batch-3") last.resolve(); },
    async onMessage() {} });
  assert.equal(keys[0], "batch-1"); assert.equal(keys.at(-1), "batch-3");
});

test("failed checkpoint writes remain retryable without dispatching the message twice", async () => {
  const abort = new AbortController(), saved = Promise.withResolvers<void>(); let polls = 0, writes = 0, handled = 0;
  await monitorWeixin({ signal: abort.signal, pollIntervalMs: 0,
    client: { async getUpdates() {
      if (++polls === 1) return { get_updates_buf: "next", msgs: [{ message_id: "one", from_user_id: "actor", text: "hello" }] };
      await new Promise(resolve => setImmediate(resolve));
      if (polls > 2) { await saved.promise; abort.abort(); } return { get_updates_buf: "next", msgs: [] };
    } } as unknown as WeixinApiClient,
    onSyncKey() { if (++writes === 1) throw Error("disk unavailable"); saved.resolve(); }, async onMessage() { handled++; } });
  assert.equal(handled, 1); assert.ok(writes >= 2);
});
