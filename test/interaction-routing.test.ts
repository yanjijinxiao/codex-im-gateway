import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InteractionRoutingJournal, type InteractionDestination } from "../src/bridge/interaction-routing.js";

const first: InteractionDestination = { accountId: "one", sessionId: "one-session", recipientId: "one-room", hostId: "local", threadId: "thread" };
const second: InteractionDestination = { ...first, accountId: "two", sessionId: "two-session", recipientId: "two-room" };
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-interaction-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "routing.json");
  return { filePath, journal: new InteractionRoutingJournal(filePath), restart: () => new InteractionRoutingJournal(filePath) };
}

test("ambiguous following never guesses a recipient; explicit primary survives restart", t => {
  const f = fixture(t);
  assert.equal(f.journal.resolve("local", "thread", [first, second]).status, "ambiguous");
  f.journal.setPrimary(second);
  assert.deepEqual(f.restart().resolve("local", "thread", [first, second]).destination, second);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
});

test("accepted turn origins are durable and outrank a new primary without changing future defaults", t => {
  const f = fixture(t);
  f.journal.setPrimary(second);
  f.journal.rememberTurn(first, "turn-one");
  const restored = f.restart();
  assert.deepEqual(restored.resolve("local", "thread", [first, second], "turn-one").destination, first);
  assert.deepEqual(restored.resolve("local", "thread", [first, second], "new-app-turn").destination, second);
  restored.rememberTurn(second, "turn-one");
  assert.deepEqual(restored.resolve("local", "thread", [first, second], "turn-one").destination, first);
});

test("first accepted IM turn establishes a default; exact host/thread/account identities are isolated", t => {
  const f = fixture(t); f.journal.rememberTurn(first, "turn");
  assert.deepEqual(f.restart().resolve("local", "thread", [first, second], "app-turn").destination, first);
  assert.equal(f.journal.resolve("remote", "thread", [first, second], "turn").status, "unavailable");
  assert.equal(f.journal.resolve("local", "other-thread", [first, second], "turn").status, "unavailable");
});

test("withdrawn or rebound owners are never silently redirected to a different chat", t => {
  const f = fixture(t); f.journal.setPrimary(first); f.journal.rememberTurn(first, "turn");
  assert.equal(f.journal.resolve("local", "thread", [second], "turn").status, "unavailable");
  assert.equal(f.journal.resolve("local", "thread", [second], "next").status, "unavailable");
  assert.equal(f.journal.resolve("local", "thread", [{ ...first, recipientId: "another-room" }], "turn").status, "unavailable");
});

test("a late interaction from an older turn cannot replace the latest accepted default", t => {
  const f = fixture(t); f.journal.rememberTurn(first, "old"); f.journal.rememberTurn(second, "new");
  f.journal.pinInteraction(first, "old");
  assert.deepEqual(f.restart().resolve("local", "thread", [first, second]).destination, second);
  assert.deepEqual(f.restart().resolve("local", "thread", [first, second], "old").destination, first);
});

test("neutral route-conflict notices are claimed once per exact binding across restarts", t => {
  const f = fixture(t);
  assert.equal(f.journal.claimRouteNotice(first, "ambiguous"), true);
  assert.equal(f.restart().claimRouteNotice(first, "ambiguous"), false);
  assert.equal(f.restart().claimRouteNotice(second, "ambiguous"), true);
  assert.equal(f.restart().claimRouteNotice({ ...first, hostId: "remote" }, "ambiguous"), true);
  assert.equal(f.restart().claimRouteNotice(first, "unavailable"), true);
  const saved = fs.readFileSync(f.filePath, "utf8");
  assert.doesNotMatch(saved, /question|answer|token/i);
});
