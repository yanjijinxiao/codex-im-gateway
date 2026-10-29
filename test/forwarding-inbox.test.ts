import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ForwardingInbox, type ForwardingTarget } from "../src/bridge/forwarding-inbox.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { ForwardingDeferredError } from "../src/bridge/forwarding-error.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import type { ChannelMessage } from "../src/channels/message.js";
import { forwardingCard } from "../src/bridge/forwarding-card.js";
import { Lexer } from "marked";
import { parseCommand } from "../src/bridge/channel-commands.js";
import { spawnSync } from "node:child_process";

const input: ChannelMessage = { id: "provider-source", senderId: "actor", replyTargetId: "room", text: "original\nmessage",
  attachments: [{ kind: "file", label: "input.txt", item: { downloadCode: "opaque-file-descriptor" } }],
  references: [{ type: "text", text: "quoted /stop is data", attachments: [], availability: "available" }],
  raw: { token: "provider-callback-secret", event: { sessionWebhook: "https://secret.invalid" } } };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(r => setImmediate(r)); };
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-forwarding-inbox-")), file = path.join(root, "inbox.json");
  let now = 1000, canDispatch = true, automatic = true;
  let target: ForwardingTarget | undefined = { sessionId: "session", threadId: "thread", hostId: "local", workspace: root, mode: "session", generation: "one", roots: [] };
  let inbox: ForwardingInbox, receipts: InboundReceiptJournal;
  const writes: ChannelMessage[] = [], notices: string[] = [];
  let action: (m: ChannelMessage) => Promise<void> = async m => {
    writes.push(m); receipts.submitting({ sessionId: "session", hostId: "local", threadId: "thread" }); receipts.accepted("thread", "turn");
  };
  const make = () => {
    receipts = new InboundReceiptJournal(path.join(root, "receipts.jsonl"), [], { onAccepted: r => inbox.accepted(r) });
    return inbox = new ForwardingInbox({ filePath: file, receipts, target: () => target, automatic: () => automatic,
      canDispatch: () => canDispatch, now: () => now, notice: async (_m, text) => { notices.push(text); },
      dispatch: m => receipts.handle(m, () => action(m)) });
  };
  make(); t.after(() => { inbox.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, writes, notices, get inbox() { return inbox; }, get receipts() { return receipts; },
    set action(value: typeof action) { action = value; }, set target(value: typeof target) { target = value; },
    set ready(value: boolean) { canDispatch = value; }, set automatic(value: boolean) { automatic = value; },
    advance() { now += 2001; }, restart() { inbox.stop(); return make(); },
    saved() { return JSON.parse(fs.readFileSync(file, "utf8")).rows as Record<string, any>; } };
}

test("durable claim retains exact content, attachment descriptors and references before dispatch, without raw provider secrets", t => {
  const f = fixture(t); assert.equal(f.inbox.claim(input), true); assert.equal(f.writes.length, 0);
  const text = fs.readFileSync(f.file, "utf8");
  assert.match(text, /original\\nmessage/); assert.match(text, /opaque-file-descriptor/); assert.match(text, /quoted \/stop is data/);
  assert.doesNotMatch(text, /provider-callback-secret|sessionWebhook|secret\.invalid/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600); assert.equal(f.inbox.claim(input), false);
});

test("disk durability failure prevents claim acknowledgement and all dispatch, while the same source stays reclaimable", t => {
  const f = fixture(t), sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error("disk unavailable"); };
  try { assert.throws(() => f.inbox.claim(input), /disk unavailable/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(f.writes.length, 0); f.restart(); assert.equal(f.inbox.claim(input), true);
});

test("known preflight timeout is retained and automatically forwarded after restart without asking for a resend", async t => {
  const f = fixture(t); let reads = 0;
  f.action = async m => {
    if (!reads++) throw new CodexCommunicationError("preflight", "thread/read", "thread", undefined, Error("timeout"));
    f.writes.push(m); f.receipts.submitting({ sessionId: "session", hostId: "local" }); f.receipts.accepted("thread", "turn");
  };
  f.inbox.claim(input); await f.inbox.receive(input);
  assert.equal(f.receipts.receipt(input.id)?.phase, "received"); assert.equal(Object.keys(f.saved()).length, 1);
  assert.equal(f.notices.length, 1); assert.match(f.notices[0], /消息已保存/);
  f.restart(); f.advance(); f.inbox.start(); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].text, input.text); assert.equal(f.notices.length, 1);
  assert.equal(Object.keys(f.saved()).length, 0); assert.equal(f.receipts.receipt(input.id)?.phase, "handled");
});

test("Gateway submission window defers a follow-up without native queueing or marking it handled", async t => {
  const f = fixture(t); let preparing = true;
  f.action = async m => { if (preparing) throw new ForwardingDeferredError("previous handoff pending"); f.writes.push(m); };
  await f.inbox.receive(input); assert.equal(f.receipts.receipt(input.id)?.phase, "received");
  preparing = false; f.advance(); f.inbox.start(); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.receipts.receipt(input.id)?.phase, "handled");
});

for (const kind of ["accepted", "ambiguous"] as const) test(`${kind} input is never resubmitted after a transport failure and restart`, async t => {
  const f = fixture(t);
  f.action = async m => { f.writes.push(m); f.receipts.submitting({ sessionId: "session", hostId: "local" });
    if (kind === "accepted") f.receipts.accepted("thread", "turn"); throw Error("connection lost"); };
  await assert.rejects(f.inbox.receive(input), /connection lost/);
  assert.equal(f.receipts.receipt(input.id)?.phase, kind === "accepted" ? "accepted" : "unconfirmed");
  f.restart(); f.advance(); f.inbox.start(); await settle(); assert.equal(f.writes.length, 1);
  assert.equal(Object.keys(f.saved()).length, kind === "accepted" ? 0 : 1);
  if (kind === "ambiguous") assert.equal(f.inbox.summary("room").unconfirmed, 1);
});

test("a crash with a submitting receipt becomes visibly unconfirmed and never authorizes replay", async t => {
  const f = fixture(t); f.inbox.claim(input);
  let capture: ReturnType<InboundReceiptJournal["capture"]>;
  const hold = Promise.withResolvers<void>();
  const pending = f.receipts.handle(input, async () => { capture = f.receipts.capture(); capture!.submitting({ sessionId: "session" }); await hold.promise; });
  // Simulate the new process reading only durable state. Do not execute the old handler.
  const restarted = new InboundReceiptJournal(path.join(f.root, "receipts.jsonl"));
  const reader = new ForwardingInbox({ filePath: f.file, receipts: restarted, target: () => undefined,
    automatic: () => true, canDispatch: () => true, dispatch: async () => { assert.fail("ambiguous input replayed"); }, notice: async () => {} });
  reader.start(); await settle(); reader.stop(); assert.equal(reader.summary("room").unconfirmed, 1);
  hold.resolve(); await pending;
});

for (const change of ["session", "host", "generation", "workspace", "project", "mode", "roots"] as const)
  test(`saved content cannot be silently redirected after ${change} changes`, async t => {
    const f = fixture(t); f.ready = false; await f.inbox.receive(input);
    const next: ForwardingTarget = { sessionId: "session", threadId: "thread", hostId: "local", workspace: f.root, mode: "session", generation: "one", roots: [] };
    if (change === "session") next.sessionId = "other";
    if (change === "host") next.hostId = "remote";
    if (change === "generation") next.generation = "detached-and-rebound";
    if (change === "workspace") next.workspace = "/other";
    if (change === "project") next.projectId = "other";
    if (change === "mode") next.mode = "qa";
    if (change === "roots") next.roots = ["/other"];
    f.target = next; f.ready = true; f.advance(); f.inbox.start(); await settle();
    assert.equal(f.writes.length, 0); assert.equal(f.inbox.summary("room").held, 1);
    assert.equal(Object.values(f.saved())[0].message.text, input.text);
  });

test("a normalized source identity conflict preserves the first body and cannot replace its target", async t => {
  const f = fixture(t); f.inbox.claim(input);
  await assert.rejects(f.inbox.receive({ ...input, text: "different" }), /identity changed/);
  assert.equal(Object.values(f.saved())[0].message.text, input.text); assert.equal(f.writes.length, 0);
});

test("concurrent redelivery dispatches one native input", async t => {
  const f = fixture(t), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  f.action = async m => { f.writes.push(m); entered.resolve(); await finish.promise; f.receipts.accepted("thread", "turn"); };
  const first = f.inbox.receive(input); await entered.promise;
  await f.inbox.receive(input); assert.equal(f.writes.length, 1); finish.resolve(); await first;
});

test("accepted native execution does not occupy transport capacity or hold later messages until completion", async t => {
  const f = fixture(t), done = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let count = 0;
  f.action = async m => { f.writes.push(m); f.receipts.accepted("thread", `turn-${++count}`); if (count === 4) entered.resolve(); await done.promise; };
  const running = Array.from({ length: 4 }, (_, i) => f.inbox.receive({ ...input, id: `active-${i}` })); await entered.promise;
  f.ready = false; await f.inbox.receive({ ...input, id: "follow-up" });
  f.ready = true; f.advance(); f.inbox.start(); await settle();
  assert.equal(f.writes.length, 5); done.resolve(); await Promise.all(running); await settle();
});

test("startup never automatically repeats a Gateway command whose execution stage is unknown", async t => {
  const f = fixture(t); f.automatic = false;
  f.action = async () => { throw Error("reply failed after local command"); };
  await assert.rejects(f.inbox.receive({ ...input, text: "/project P1" }));
  f.restart().start(); await settle(); assert.equal(f.writes.length, 0); assert.equal(f.inbox.summary("room").held, 1);
});

test("a command durably saved before dispatch resumes once after restart, including during a release freeze", async t => {
  const f = fixture(t); f.automatic = false; f.ready = false;
  await f.inbox.receive({ ...input, text: "/status", attachments: [] });
  assert.equal(f.writes.length, 0); f.restart(); f.ready = true; f.advance(); f.inbox.start(); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].text, "/status");
});

test("exact native creation acceptance advances only pending inputs from the same original binding", async t => {
  const f = fixture(t); const blank: ForwardingTarget = { sessionId: "session", hostId: "local", workspace: f.root, mode: "session", generation: "before", roots: [] };
  f.target = blank; f.ready = false; f.inbox.claim(input); f.inbox.claim({ ...input, id: "second" });
  f.target = { ...blank, threadId: "created", generation: "after" };
  f.inbox.accepted({ phase: "accepted", clientUserMessageId: f.receipts.receipt(input.id)!.clientUserMessageId,
    sessionId: "session", hostId: "local", threadId: "created", turnId: "turn" });
  assert.equal(Object.keys(f.saved()).length, 1); assert.equal(Object.values(f.saved())[0].target.threadId, "created");
  f.ready = true; f.inbox.start(); await settle(); assert.equal(f.writes.length, 1);
});

test("a completed download is reused after restart, retaining the original source and command text", async t => {
  const f = fixture(t); f.inbox.claim(input);
  fs.writeFileSync(path.join(f.root, "local.txt"), "attachment content");
  f.inbox.prepared(input.id, [{ kind: "file", label: "input.txt", path: path.join(f.root, "local.txt"), item: {} }]);
  f.restart().start(); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].text, input.text);
  assert.equal(f.writes[0].attachments[0].path, path.join(f.root, "local.txt")); assert.deepEqual(f.writes[0].attachments[0].item, {});
});

test("a later message cannot overtake an earlier not-submitted input, while accepted execution releases source order", async t => {
  const f = fixture(t); let fail = true;
  f.action = async m => {
    if (m.id === input.id && fail) throw new ForwardingDeferredError("preparation pending");
    f.writes.push(m); f.receipts.accepted("thread", `turn-${f.writes.length}`);
  };
  await f.inbox.receive(input); await f.inbox.receive({ ...input, id: "later" }); assert.equal(f.writes.length, 0);
  fail = false; f.advance(); f.inbox.start(); await settle();
  assert.deepEqual(f.writes.map(m => m.id), [input.id, "later"]);
});

test("Gateway status/control messages bypass a pending ordinary message instead of being stuck behind task work", async t => {
  const f = fixture(t); f.action = async m => { if (m.id === input.id) throw new ForwardingDeferredError("pending"); f.writes.push(m); };
  await f.inbox.receive(input); f.automatic = false;
  await f.inbox.receive({ ...input, id: "status", text: "/status", attachments: [] });
  assert.deepEqual(f.writes.map(m => m.id), ["status"]);
});

test("inbox corruption fails closed and leaves the original bytes intact", t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{"version":1,"rows":{"bad":{"message":{}}}}');
  const before = fs.readFileSync(f.file, "utf8"); assert.throws(() => f.restart()); assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("binding identity is structural across serialization, not dependent on object property order", async t => {
  const f = fixture(t); f.target = { sessionId: "session", generation: "one", threadId: "thread", roots: [], mode: "session", workspace: f.root, hostId: "local" };
  f.inbox.claim(input); f.restart().start(); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.inbox.summary("room").held, 0);
});

test("an explicit retry binds to the displayed destination and cannot replay an unknown submission", async t => {
  const f = fixture(t); f.ready = false; await f.inbox.receive(input);
  f.target = { sessionId: "replacement", threadId: "new-thread", hostId: "remote", workspace: "/remote", mode: "session", generation: "two", roots: [] };
  f.ready = true; f.advance(); f.inbox.start(); await settle();
  const item = f.inbox.items("room")[0]; assert.equal(item.state, "held");
  assert.throws(() => f.inbox.retry(item.id, "room", "other", false, item.targetVersion!), /自己的/);
  assert.throws(() => f.inbox.retry(item.id, "other-room", "actor", true, item.targetVersion!), /不属于/);
  assert.throws(() => f.inbox.retry(item.id, "room", "actor", false, "stale-target"), /绑定已改变/);
  f.inbox.retry(item.id, "room", "actor", false, item.targetVersion!); await settle();
  assert.equal(f.writes.length, 1);
});

test("explicit cancellation tombstones only a known not-submitted input and survives provider redelivery", async t => {
  const f = fixture(t); f.ready = false; await f.inbox.receive(input);
  const item = f.inbox.items("room")[0]; f.inbox.cancel(item.id, "room", "actor", false);
  assert.equal(f.receipts.receipt(input.id)?.phase, "handled"); assert.equal(Object.keys(f.saved()).length, 0);
  assert.equal(f.restart().claim(input), false); assert.equal(f.writes.length, 0);
});

test("ambiguous native input cannot be explicitly retried or cancelled as an unsent message", async t => {
  const f = fixture(t); f.action = async () => { f.receipts.submitting(); throw Error("lost acknowledgement"); };
  await assert.rejects(f.inbox.receive(input));
  const item = f.inbox.items("room")[0]; assert.equal(item.retryable, false); assert.equal(item.cancellable, false);
  assert.throws(() => f.inbox.retry(item.id, "room", "actor", true, item.targetVersion!), /提交结果未确认/);
  assert.throws(() => f.inbox.cancel(item.id, "room", "actor", true), /提交结果未确认/);
  assert.equal(Object.keys(f.saved()).length, 1);
});

test("failed acceptance persistence cannot erase the saved body or make in-memory acceptance stronger than disk", async t => {
  const f = fixture(t), sync = fs.fsyncSync;
  f.action = async m => {
    f.writes.push(m); f.receipts.submitting();
    fs.fsyncSync = () => { throw Error("acceptance durability failure"); };
    f.receipts.accepted("thread", "turn");
  };
  try { await assert.rejects(f.inbox.receive(input)); }
  finally { fs.fsyncSync = sync; }
  assert.notEqual(f.receipts.receipt(input.id)?.phase, "accepted");
  f.restart().start(); await settle(); assert.equal(f.writes.length, 1); assert.equal(Object.keys(f.saved()).length, 1);
  assert.equal(f.inbox.summary("room").unconfirmed, 1);
});

test("forwarding records provide scoped native actions and code widgets only for complete executable replies", async t => {
  const f = fixture(t); f.ready = false; await f.inbox.receive({ ...input, text: "```text\nreference-only\n```" });
  const items = f.inbox.items("room"); assert.equal(f.inbox.items("another-room").length, 0);
  const card = forwardingCard(items, items[0].id, target => target.sessionId);
  assert.equal(Lexer.lex(card.body).filter(token => token.type === "code").length, 0);
  const blocks = Lexer.lex(card.fallbackText).filter(token => token.type === "code");
  assert.ok(blocks.length > 0); assert.ok(blocks.every(token => parseCommand(token.text)?.name === "inbox"));
  assert.ok(blocks.some(token => token.text === `/inbox retry ${items[0].id} ${items[0].targetVersion}`));
});

for (const phase of ["received", "submitting", "accepted"] as const) test(`abrupt process death preserves the body and exact ${phase} forwarding boundary`,
  { skip: process.platform === "win32" }, async t => {
    const f = fixture(t);
    const inboxModule = new URL("../src/bridge/forwarding-inbox.ts", import.meta.url).href;
    const receiptModule = new URL("../src/bridge/inbound-receipts.ts", import.meta.url).href;
    const target = { sessionId: "session", threadId: "thread", hostId: "local", workspace: f.root, mode: "session", generation: "one", roots: [] };
    const code = `import {ForwardingInbox} from ${JSON.stringify(inboxModule)};
      import {InboundReceiptJournal} from ${JSON.stringify(receiptModule)};
      const receipts=new InboundReceiptJournal(process.argv[2]);
      const message=JSON.parse(process.argv[3]), target=JSON.parse(process.argv[4]);
      const inbox=new ForwardingInbox({filePath:process.argv[1],receipts,target:()=>target,now:()=>1000,
        automatic:()=>true,canDispatch:()=>false,dispatch:async()=>{},notice:async()=>{}});
      inbox.claim(message);
      ${phase === "received" ? "process.kill(process.pid,'SIGKILL');" : `await receipts.handle(message,async()=>{receipts.submitting({sessionId:'session',hostId:'local',threadId:'thread'});
        ${phase === "accepted" ? "receipts.accepted('thread','turn');" : ""}process.kill(process.pid,'SIGKILL');});`}`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, f.file,
      path.join(f.root, "receipts.jsonl"), JSON.stringify(input), JSON.stringify(target)], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.match(fs.readFileSync(f.file, "utf8"), /original\\nmessage/);
    f.restart().start(); await settle(); assert.equal(f.writes.length, phase === "received" ? 1 : 0);
    assert.equal(Object.keys(f.saved()).length, phase === "submitting" ? 1 : 0);
  });
