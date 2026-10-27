import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { AdmissionService } from "../src/bridge/admission.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";

function temp(t: test.TestContext) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-full-review-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test("refresh remains fail-closed on every read after malformed external state, without accepting its revision", t => {
  const paths = resolveStatePaths(temp(t)), store = new RuntimeStateStore(paths);
  store.setPairedSenderIds(["before"]);
  const data = store.snapshot; data.projects.push({ id: "invalid", workspace: null } as never);
  fs.writeFileSync(paths.statePath, JSON.stringify(data));
  assert.throws(() => store.refresh());
  assert.throws(() => store.refresh(), "second read must not treat failed normalization as a committed revision");
});
test("a rejected multi-field knowledge update cannot alter live state or leak into a later unrelated commit", t => {
  const paths = resolveStatePaths(temp(t)), store = new RuntimeStateStore(paths);
  const one = store.createKnowledgeBase("one", "/root/one"), two = store.createKnowledgeBase("two", "/root/two");
  assert.throws(() => store.updateKnowledgeBase(one.id, { name: "should-not-stick", rootPath: two.rootPath }));
  assert.equal(store.listKnowledgeBases().find(k => k.id === one.id)?.name, "one");
  store.setPairedSenderIds(["actor"]);
  assert.equal(new RuntimeStateStore(paths).listKnowledgeBases().find(k => k.id === one.id)?.name, "one");
});
test("processed admission requests release per-person capacity, while old decisions stay invalid", t => {
  const root = temp(t), principal = { accountId: "a", providerId: "robot", channel: "dingtalk" as const, actorId: "person" };
  const service = new AdmissionService({ root, accounts: () => [principal], allowed: () => false, allow() {} });
  const expired: Array<{id: string; version: string}> = [];
  for (let i = 0; i < 12; i++) { const r = service.observe(principal, "room", "group"); service.decideLocal(r.id, r.version, "deny"); expired.push(r); }
  const fresh = service.observe(principal, "room", "group");
  assert.notEqual(fresh.id, expired[0].id);
  for (const r of expired) assert.throws(() => service.decideLocal(r.id, r.version, "actor"));
});
test("an interrupted append does not poison the next source receipt or restart recovery", t => {
  const file = path.join(temp(t), "receipts.jsonl"), journal = new InboundReceiptJournal(file);
  const original = fs.writeSync; let partial = false, fail = true;
  fs.writeSync = ((...args: any[]) => {
    if (fail && typeof args[2] === "number") {
      if (!partial) { partial = true; return (original as any)(args[0], args[1], args[2], 7, args[4]); }
      fail = false; throw Error("injected append failure");
    }
    return (original as any)(...args);
  }) as typeof fs.writeSync;
  try { assert.throws(() => journal.claim({ id: "one", senderId: "actor" }), /injected/); }
  finally { fs.writeSync = original; }
  assert.equal(journal.claim({ id: "two", senderId: "actor" }), true);
  assert.doesNotThrow(() => new InboundReceiptJournal(file));
});

test("migration persistence failure throws once instead of recursively rewriting the same broken disk", t => {
  const paths = resolveStatePaths(temp(t)); fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.statePath, JSON.stringify({ pairedSenderIds: ["actor"] }));
  const original = fs.renameSync; let writes = 0;
  fs.renameSync = ((from, to) => { if (to === paths.statePath) { writes++; throw Error("disk unavailable"); } return original(from, to); }) as typeof fs.renameSync;
  try { assert.throws(() => new RuntimeStateStore(paths), /disk unavailable/); }
  finally { fs.renameSync = original; }
  assert.equal(writes, 1, "recovery must not recursively persist a migration");
});
