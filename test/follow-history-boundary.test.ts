import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { afterFollowBoundary, followBoundary } from "../src/server/follow-history-boundary.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import type { CodexThreadSnapshot } from "../src/codex/backend.js";

type Turn = CodexThreadSnapshot["turns"][number];
const turn = (id: string, startedAt?: string): Turn => ({ id, status: "completed", ...(startedAt ? { startedAt } : {}),
  messages: [{ id: id + "-answer", role: "assistant", text: id + " result" }] });

test("history classification requires native order or start time, never UUID order or absence from an ID set", () => {
  const old = turn("z-old", "2026-10-01T00:00:00Z"), anchor = turn("a-anchor", "2026-10-02T00:00:00Z");
  const next = turn("0-next", "2026-10-03T00:00:00Z"), unknown = turn("unknown");
  assert.equal(afterFollowBoundary(old, [old, anchor, next], followBoundary(anchor)), false);
  assert.equal(afterFollowBoundary(next, [next], followBoundary(anchor)), true);
  assert.equal(afterFollowBoundary(unknown, [unknown], followBoundary(anchor)), false);
  assert.equal(afterFollowBoundary(unknown, [anchor, unknown], followBoundary(anchor)), true);
  assert.equal(afterFollowBoundary(anchor, [anchor], followBoundary(anchor)), false);
  assert.equal(afterFollowBoundary(old, [anchor, old], followBoundary(anchor)), false, "older native time cannot advance a cursor");
});

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-history-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes: string[] = [];
  let creates = 0;
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
    client: { resumableTextStream: true,
      async sendText(input) { writes.push(input.text); return { messageId: "notice" }; },
      async startTextStream(input) { creates++; writes.push(input.text); return { messageId: input.streamId! }; },
      async updateTextStream(input) { if (input.finalize) writes.push(input.text); }
    } };
  let snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }, turns: [] };
  const filePath = path.join(root, "follow.json");
  const make = () => new ThreadEventHub({ filePath, subscriptions: () => [sub], backend: () => ({ async readThreadSnapshot() { return snapshot; } }) });
  return { make, writes, filePath, creates: () => creates, set(turns: Turn[]) { snapshot = { ...snapshot, turns }; } };
}

test("partial history expanding by 1000 older turns cannot create cards, including forced sync and restart", async t => {
  const f = fixture(t), recent = turn("recent");
  let hub = f.make();
  f.set([recent]); await hub.refresh();
  f.set([recent, turn("new")]); await hub.refresh();
  assert.equal(f.creates(), 1);
  const older = Array.from({ length: 1000 }, (_, i) => turn(`historical-${i}`));
  f.set([...older, recent, turn("new")]);
  await hub.refresh(); await hub.synchronize("binding");
  await hub.stop(); hub = f.make();
  await hub.refresh(); await hub.synchronize("binding"); await hub.stop();
  assert.equal(f.creates(), 1);
  assert.ok(f.writes.every(text => !text.includes("historical-")));
});

test("legacy migration protects old history but recovers the exact tracked offline result and future turns", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, JSON.stringify({ binding: { eventVersion: 2, deliveryVersion: 1, hostId: "local", threadId: "thread",
    initialized: true, sequence: 0, baseline: ["known"], completed: [], delivered: [], turnId: "tracked", checkpointTurnId: "tracked",
    checkpoint: { streamId: "original", messageId: "original", startedAt: Date.now(), progressEntries: [], thought: "", answerPreview: "", finished: false }
  } }));
  f.set([turn("old"), turn("known"), turn("tracked")]);
  const hub = f.make(); await hub.refresh();
  assert.equal(f.creates(), 0, "reuse the original card for the tracked result");
  assert.deepEqual(f.writes, ["tracked result"]);
  f.set([turn("much-older"), turn("tracked"), turn("future")]); await hub.refresh(); await hub.stop();
  assert.equal(f.creates(), 1);
  assert.ok(f.writes.every(text => !text.includes("older") && !text.includes("old result")));
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).binding.historyBoundary.turnId, "future");
});

test("a missing history anchor and missing native timestamp never authorize an unknown result", async t => {
  const f = fixture(t), hub = f.make();
  f.set([turn("recent")]); await hub.refresh();
  f.set([turn("unknown")]); await hub.refresh(); await hub.synchronize("binding");
  assert.equal(f.creates(), 0);
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).binding.historyBoundary.turnId, "recent");
  await hub.started("local", "thread", "actual-new-turn", new Date().toISOString());
  await hub.completion("local", "thread", "actual-new-turn", "real answer"); await hub.stop();
  assert.equal(f.creates(), 1);
});

test("legacy migration with an already regressed old cursor cannot resume the historical replay burst", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, JSON.stringify({ binding: { eventVersion: 2, deliveryVersion: 1, hostId: "local", threadId: "thread",
    initialized: true, sequence: 0, baseline: ["recent"], completed: ["old-first"], delivered: [], turnId: "old-first",
    checkpointTurnId: "old-first", checkpoint: { streamId: "old-card", messageId: "old-card", startedAt: Date.now(),
      progressEntries: [], thought: "", answerPreview: "old result", finished: true, terminal: { text: "old result", error: false } }
  } }));
  f.set([turn("old-first"), turn("old-second"), turn("old-third"), turn("recent")]);
  const hub = f.make(); await hub.refresh(); await hub.synchronize("binding"); await hub.stop();
  assert.equal(f.creates(), 0); assert.deepEqual(f.writes, []);
});

test("legacy uncreated historical terminal is retained as deferred, never made into a new card during migration", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, JSON.stringify({ binding: { eventVersion: 2, deliveryVersion: 1, hostId: "local", threadId: "thread",
    initialized: true, sequence: 0, baseline: ["recent"], completed: [], delivered: [], turnId: "old", checkpointTurnId: "old",
    terminalPending: { turnId: "old", text: "old result", fallbackSent: false },
    checkpoint: { streamId: "old-card", creationAttempted: false, startedAt: Date.now(), progressEntries: [],
      thought: "", answerPreview: "", finished: false, terminal: { text: "old result", error: false } }
  } }));
  f.set([turn("old"), turn("recent")]);
  const hub = f.make(); await hub.refresh(); await hub.synchronize("binding");
  assert.equal(hub.status("binding").resultDelivery?.deferred, 1); await hub.stop();
  assert.equal(f.creates(), 0); assert.deepEqual(f.writes, []);
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).binding.pendingTerminals.old.text, "old result");
});
