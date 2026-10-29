import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { SessionControlJournal } from "../src/bridge/session-control.js";

test("a known preflight failure releases the native control claim; a missing write acknowledgement does not", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-control-preflight-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new SessionControlJournal(path.join(root, "control.json")); let calls = 0;
  const action = async () => { calls++; if (calls === 1) throw new CodexCommunicationError("preflight", "thread/read", "thread", undefined, Error("timeout"));
    return { status: "accepted" as const, threadId: "thread", turnId: "turn" }; };
  await assert.rejects(journal.submit("scope", "source", action));
  assert.equal((await journal.submit("scope", "source", action)).turnId, "turn"); assert.equal(calls, 2);
  let unknown = 0;
  const ambiguous = async () => { unknown++; throw new CodexCommunicationError("submission", "turn/steer", "thread", undefined, Error("timeout")); };
  await assert.rejects(journal.submit("scope", "unknown", ambiguous)); await assert.rejects(journal.submit("scope", "unknown", ambiguous));
  assert.equal(unknown, 1);
});

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

test("presentation recovery projects only exact confirmed receipts, not legacy/uncertain/cross-thread submissions", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-presentation-controls-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "controls.json"); const controls = new SessionControlJournal(file);
  const key = JSON.stringify(["remote", "thread"]);
  const receipt = { status: "accepted" as const, threadId: "thread", turnId: "turn" };
  let nativeWrites = 0;
  await controls.submit(key, "confirmed", async () => { nativeWrites++; return receipt; }, "remote");
  await controls.submit(key, "legacy", async () => receipt);
  await controls.submit(key, "wrong-scope", async () => ({ ...receipt, threadId: "another-thread" }), "remote");
  await assert.rejects(controls.submit(key, "unknown", async () => { throw new Error("receipt lost"); }, "remote"));
  const restored = new SessionControlJournal(file);
  await restored.submit(key, "confirmed", async () => { nativeWrites++; return receipt; }, "remote");
  assert.equal(nativeWrites, 1);
  assert.equal(restored.acceptedPresentationInputs().length, 1);
  const [input] = restored.acceptedPresentationInputs();
  assert.equal(input.hostId, "remote"); assert.equal(input.threadId, "thread"); assert.equal(input.turnId, "turn");
  assert.equal(input.kind, "steer"); assert.equal(typeof input.acceptedAt, "number");
  assert.deepEqual(input, controls.acceptedPresentationInputs()[0]);
});
