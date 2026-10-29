import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";

const message = { id: "provider-id", senderId: "actor", replyTargetId: "chat" };

test("a proven preflight failure can release a write-ahead claim, while accepted evidence remains stronger", async t => {
  const f = fixture(t);
  await assert.rejects(f.journal.handle(message, async () => {
    f.journal.submitting(); throw new CodexCommunicationError("preflight", "thread/read", "thread", undefined, Error("timeout"));
  }));
  assert.equal(f.restart().receipt(message.id)?.phase, "received");
  await assert.rejects(f.journal.handle(message, async () => {
    f.journal.submitting(); f.journal.accepted("thread", "turn");
    throw new CodexCommunicationError("preflight", "thread/read", "thread", undefined, Error("later read timeout"));
  }));
  assert.equal(f.restart().receipt(message.id)?.phase, "accepted");
});
function fixture(t: test.TestContext, legacy: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-inbound-receipts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "receipts.json");
  return { root, file, journal: new InboundReceiptJournal(file, legacy), restart: () => new InboundReceiptJournal(file) };
}

test("provider redelivery can reclaim a received message after process restart, but not twice in one process", async t => {
  const f = fixture(t); assert.equal(f.journal.claim(message), true); assert.equal(f.journal.claim(message), false);
  const restarted = f.restart(); assert.equal(restarted.claim(message), true);
  let calls = 0; await restarted.handle(message, async () => { calls++; });
  assert.equal(calls, 1); assert.equal(f.restart().claim(message), false);
});

test("preparation failure remains reclaimable; an attempted native mutation is never replayed", async t => {
  const f = fixture(t);
  await assert.rejects(f.journal.handle(message, async () => { throw Error("download unavailable"); }));
  const retry = f.restart(); assert.equal(retry.claim(message), true);
  await assert.rejects(retry.handle(message, async () => {
    retry.submitting({ sessionId: "session", hostId: "remote", threadId: "thread" }); throw Error("lost receipt");
  }));
  assert.equal(f.restart().claim(message), false);
  assert.equal(Object.values(f.restart().snapshot())[0].phase, "unconfirmed");
});

test("native acceptance stays stronger than a later observation failure and survives restart", async t => {
  const f = fixture(t);
  await assert.rejects(f.journal.handle(message, async () => {
    f.journal.submitting(); f.journal.accepted("thread", "turn"); throw Error("observer disconnected");
  }));
  const r = Object.values(f.restart().snapshot())[0];
  assert.equal(r.phase, "accepted"); assert.equal(r.threadId, "thread"); assert.equal(r.turnId, "turn");
  assert.equal(f.restart().claim(message), false);
});

test("old IDs remain deduplicated beyond the former 1000-message window, without storing message bodies", async t => {
  const f = fixture(t); await f.journal.handle(message, async () => {});
  for (let i = 0; i < 1002; i++) await f.journal.handle({ ...message, id: `next-${i}` }, async () => {});
  assert.equal(f.restart().claim(message), false);
  const saved = fs.readFileSync(f.file, "utf8");
  assert.doesNotMatch(saved, /provider-id|next-1001|prompt|password/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test("legacy processed IDs migrate as tombstones, while independent account journals retain their own scope", async t => {
  const f = fixture(t, [message.id]); assert.equal(f.journal.claim(message), false);
  const another = new InboundReceiptJournal(path.join(f.root, "another-account.json"));
  assert.equal(another.claim(message), true);
  assert.equal(f.journal.claim({ ...message, id: "" }), false);
});

test("a received identity cannot be moved to a different actor or conversation", t => {
  const f = fixture(t); f.journal.claim(message);
  assert.equal(f.restart().claim({ ...message, senderId: "other" }), false);
  assert.equal(f.restart().claim({ ...message, replyTargetId: "other" }), false);
});

test("concurrent dispatch consumes one source identity and preserves separate async contexts", async t => {
  const f = fixture(t); let release!: () => void, calls = 0;
  const first = f.journal.handle(message, async () => { calls++; await new Promise<void>(r => { release = r; }); f.journal.accepted("one", "t1"); });
  await f.journal.handle(message, async () => { calls++; });
  await f.journal.handle({ ...message, id: "another" }, async () => { calls++; f.journal.accepted("two", "t2"); });
  release(); await first;
  assert.equal(calls, 2);
  assert.deepEqual(Object.values(f.restart().snapshot()).map(r => r.threadId).sort(), ["one", "two"]);
});

test("journal corruption fails closed instead of rebuilding an empty deduplication history", t => {
  const f = fixture(t); fs.writeFileSync(f.file, "{broken"); assert.throws(f.restart);
});

test("a torn final append preserves earlier submitting/accepted facts and allows future appends", async t => {
  const f = fixture(t);
  await assert.rejects(f.journal.handle(message, async () => { f.journal.submitting(); f.journal.accepted("thread", "turn"); throw Error("crash"); }));
  fs.appendFileSync(f.file, '{"id":"partial');
  const restarted = f.restart(); assert.equal(restarted.claim(message), false);
  await restarted.handle({ ...message, id: "next" }, async () => {});
  assert.equal(f.restart().claim({ ...message, id: "next" }), false);
});

test("a failed durability barrier prevents action dispatch", async t => {
  const f = fixture(t), original = fs.fsyncSync; let calls = 0;
  fs.fsyncSync = () => { throw Error("synthetic durability failure"); };
  try { await assert.rejects(f.journal.handle(message, async () => { calls++; }), /durability failure/); }
  finally { fs.fsyncSync = original; }
  assert.equal(calls, 0); assert.equal(f.restart().claim(message), true);
});

test("a forward upgrade imports missing legacy rollback tombstones without hiding received preparation", t => {
  const f = fixture(t); f.journal.claim(message);
  const restarted = new InboundReceiptJournal(f.file, [message.id, 'handled-by-old-version']);
  assert.equal(restarted.claim(message), true);
  assert.equal(restarted.claim({ ...message, id: 'handled-by-old-version' }), false);
});

test("native callbacks retain their exact receipt even outside the source dispatch async context", async t => {
  const { TurnSubmission } = await import('../src/bridge/turn-submission.js');
  const f = fixture(t); let accept!: () => Promise<void>, reject!: (error: Error) => void;
  const pending = f.journal.handle(message, async () => {
    const submission = new TurnSubmission(f.journal, 'session');
    await submission.run({ async run(input) {
      accept = async () => { await input.onTurnStarted?.({ threadId: 'actual-thread', turnId: 'actual-turn' }); };
      return new Promise((_resolve, fail) => { reject = fail; });
    } }, { cwd: '/work', prompt: 'synthetic' });
  });
  await accept(); reject(Error('connection closed'));
  await assert.rejects(pending);
  const r = Object.values(f.restart().snapshot())[0];
  assert.equal(r.phase, 'accepted'); assert.equal(r.threadId, 'actual-thread'); assert.equal(r.sessionId, 'session');
});

for (const phase of ['received', 'submitting', 'accepted'] as const) test(`real process exit retains the ${phase} recovery boundary`, async t => {
  const { spawnSync } = await import('node:child_process');
  const f = fixture(t), module = new URL('../src/bridge/inbound-receipts.ts', import.meta.url).href;
  const code = `import {InboundReceiptJournal} from ${JSON.stringify(module)};const j=new InboundReceiptJournal(process.argv[1]);const m={id:'provider-id',senderId:'actor',replyTargetId:'chat'};j.claim(m);` +
    (phase === 'received' ? 'process.exit(17);' : `await j.handle(m,async()=>{j.submitting({hostId:'remote',threadId:'thread'});${phase === 'accepted' ? "j.accepted('thread','turn');" : ''}process.exit(17);});`);
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, f.file], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 17, child.stderr);
  assert.equal(f.restart().claim(message), phase === 'received');
});

test("an exact native queue receipt survives a later reply failure without replay", async t => {
  const f = fixture(t); f.journal.claim(message);
  await assert.rejects(f.journal.handle(message, async () => {
    f.journal.submitting({ sessionId: 'session', hostId: 'local', threadId: 'thread' });
    f.journal.queued('thread', 'native-queue-item');
    throw Error('channel reply failed');
  }));
  const restored = f.restart(), receipt = restored.receipt(message.id)!;
  assert.equal(receipt.phase, 'accepted'); assert.equal(receipt.queuedSubmissionId, 'native-queue-item');
  assert.equal(restored.claim(message), false);
});
