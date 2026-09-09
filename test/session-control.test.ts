import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionControlJournal } from "../src/bridge/session-control.js";

test("serializes controls across actors and deduplicates accepted and uncertain requests after restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-controls-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "controls.json");
  const journal = new SessionControlJournal(file);
  let active = 0;
  let calls = 0;
  const action = async () => {
    assert.equal(active++, 0);
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return { status: "accepted" as const, threadId: "thread", turnId: "turn" };
  };
  await Promise.all([
    journal.steer("local/thread", "actor-a/message-1", action),
    journal.steer("local/thread", "actor-a/message-1", action),
    journal.steer("local/thread", "actor-b/message-2", action)
  ]);
  assert.equal(calls, 2);
  await assert.rejects(journal.steer("local/thread", "lost-response", async () => { throw new Error("connection closed"); }));
  const restarted = new SessionControlJournal(file);
  await restarted.steer("local/thread", "actor-a/message-1", action);
  await assert.rejects(restarted.steer("local/thread", "lost-response", action), /结果尚未确认/);
  assert.equal(calls, 2, "an ambiguous write must not be retried");
});

test("pending input is scoped to its actor and conversation and survives restart", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-choices-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "controls.json");
  const journal = new SessionControlJournal(file);
  const choice = journal.createChoice({
    actorId: "alice", conversationId: "group", sessionId: "s",
    hostId: "remote", threadId: "t", turnId: "run", prompt: "hello", items: []
  });
  const restarted = new SessionControlJournal(file);
  assert.throws(() => restarted.claimChoice(choice.id, "bob", "group", false), /不属于/);
  assert.throws(() => restarted.claimChoice(choice.id, "alice", "other", false), /不属于/);
  assert.equal(restarted.claimChoice(choice.id, "alice", "group", false).turnId, "run");
  assert.throws(() => restarted.claimChoice(choice.id, "alice", "group", false), /已处理/);
});
