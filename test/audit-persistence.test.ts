import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {NativeQueueCoordinator, type QueueOrigin} from "../src/bridge/native-queue.js";
import {SessionControlJournal} from "../src/bridge/session-control.js";
import {writeAtomicTextFile} from "../src/state/json-store.js";

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-audit-persistence-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return path.join(dir, "journal.json");
}
const origin: QueueOrigin = {accountId: "a",conversationId: "chat",actorId: "actor",messageId: "source",sessionId: "s",hostId: "local",threadId: "native",backend: "app-server"};

test("native queue rejects syntactically valid journals that cannot durably retain named receipts", t => {
  for (const data of [{receipts: []}, {receipts: null}, {}, {receipts: {bad: {}}}]) {
    const file = fixture(t), raw = JSON.stringify(data); fs.writeFileSync(file, raw);
    assert.throws(() => new NativeQueueCoordinator(file), /Invalid native queue receipt journal/);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
});

test("session controls reject array-shaped stores instead of losing sending/accepted tombstones", t => {
  for (const data of [{receipts: [], choices: {}}, {receipts: {}, choices: []}, {receipts: {bad: {status: "other"}}, choices: {}}]) {
    const file = fixture(t), raw = JSON.stringify(data); fs.writeFileSync(file, raw);
    assert.throws(() => new SessionControlJournal(file), /Invalid session control journal/);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
});

for (const afterRename of [false, true]) test(`native queue never mutates the backend after a write-ahead flush failure (afterRename=${afterRename})`, async t => {
  const file = fixture(t), journal = new NativeQueueCoordinator(file), original = fs.fsyncSync; let flushes = 0, adds = 0;
  fs.fsyncSync = (() => { if (++flushes === (afterRename ? 2 : 1)) throw new Error("injected durable flush failure"); }) as typeof fs.fsyncSync;
  try {
    await assert.rejects(journal.enqueue(origin, "body", { backendInfo: () => ({id:"app-server",capabilities:{nativeQueue:true}}),
      async addQueuedSubmission() { adds++; throw Error("must not run"); } } as never), /injected durable/);
    assert.equal(adds, 0); assert.ok(flushes > 0);
  } finally { fs.fsyncSync = original; }
  assert.ok(!fs.readdirSync(path.dirname(file)).some(n => n.endsWith(".tmp")));
});

test("steering waits for durable sending evidence before invoking native control", async t => {
  const journal = new SessionControlJournal(fixture(t)), original = fs.fsyncSync; let controls = 0;
  fs.fsyncSync = (() => { throw Error("injected flush failure"); }) as typeof fs.fsyncSync;
  try { await assert.rejects(journal.submit("scope", "message", async () => { controls++; return {status:"accepted",threadId:"t",turnId:"turn"}; }), /flush failure/); }
  finally { fs.fsyncSync = original; }
  assert.equal(controls, 0);
});

test("Windows atomic writes flush the file without opening an unsupported directory handle", t => {
  const file = fixture(t), platform = Object.getOwnPropertyDescriptor(process, "platform")!, original = fs.fsyncSync; let flushes = 0;
  Object.defineProperty(process, "platform", {value:"win32"}); fs.fsyncSync = (() => {flushes++;}) as typeof fs.fsyncSync;
  try { writeAtomicTextFile(file, "durable", {durable:true}); assert.equal(flushes, 1); assert.equal(fs.readFileSync(file,"utf8"),"durable"); }
  finally { Object.defineProperty(process, "platform", platform); fs.fsyncSync = original; }
});

test("malformed map roots and binding maps cannot normalize away the account's sessions", async t => {
  const {RuntimeStateStore}=await import("../src/state/runtime-state.js"),{resolveStatePaths}=await import("../src/state/paths.js");
  for(const malformed of [[],{activeSessionIds:[]},{projects:{}},{sessions:{}}]){
    const file=fixture(t),paths={...resolveStatePaths(path.dirname(file)),statePath:file};const raw=JSON.stringify(malformed);fs.writeFileSync(file,raw);
    assert.throws(()=>new RuntimeStateStore(paths), /Invalid/);assert.equal(fs.readFileSync(file,"utf8"),raw);
  }
});
