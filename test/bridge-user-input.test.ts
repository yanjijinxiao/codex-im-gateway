import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import type { CodexUserInputRequest } from "../src/codex/backend.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

const native: CodexUserInputRequest = { threadId: "thread", turnId: "turn", itemId: "item", requestId: "native-request",
  questions: [{ id: "question", header: "问题", question: "目录在哪里？" }], autoResolutionMs: null };

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-question-"));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const session = store.createSession("room", root, "原任务", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(session.id, "thread");
  store.setRole("room", "viewer", "viewer"); store.setRole("room", "participant", "participant");
  const texts: string[] = []; const mutations: string[] = [];
  const channel = createChannelClient("generic", TEXT_CAPABILITIES, {
    async sendText(input) { texts.push(input.text); return { messageId: "message" }; }
  });
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["room"] }, stateStore: store, channel,
    runner: { async run() { mutations.push("run"); throw new Error("question must not start a task"); },
      async steer() { mutations.push("steer"); throw new Error("question must not use regular steer"); },
      async addQueuedSubmission() { mutations.push("queue"); throw new Error("question must not enqueue"); } } as never });
  t.after(() => { service.suspendUserInputs(); fs.rmSync(root, { recursive: true, force: true }); });
  const send = (text: string, actor = "participant", room = "room") => service.handleMessage({
    id: String(texts.length), senderId: actor, replyTargetId: room, text, attachments: [], raw: {}
  });
  return { service, store, session, texts, mutations, send };
}

test("explicit IM answer returns to the native question without run/steer/queue", async t => {
  const f = fixture(t);
  const pending = f.service.requestUserInput("room", native);
  assert.match(f.texts[0], /\/answer Q1/);
  await f.send("/answer Q1 在 farming\n目录里");
  assert.deepEqual(await pending, { question: { answers: ["在 farming\n目录里"] } });
  assert.deepEqual(f.mutations, []);
  await f.service.reportUserInputResult("room", native, "confirmed");
  assert.match(f.texts.at(-1)!, /Codex 已确认/);
});

test("viewer role and unauthorized actors cannot submit answers via commands or callbacks", async t => {
  const f = fixture(t); const pending = f.service.requestUserInput("room", native);
  await f.send("/answer Q1 forbidden", "viewer");
  assert.match(f.texts.at(-1)!, /participant 权限/);
  await f.send("/answer Q1 forbidden", "unknown", "other-room");
  assert.match(f.texts.at(-1)!, /Access denied/);
  await f.send("/skip Q1", "participant");
  assert.deepEqual(await pending, {}); assert.deepEqual(f.mutations, []);
});

test("question answers respect current host/thread binding and do not cross conversations", async t => {
  const f = fixture(t);
  assert.equal(await f.service.requestUserInput("room", { ...native, hostId: "remote" }), undefined);
  assert.equal(await f.service.requestUserInput("room", { ...native, threadId: "other-thread" }), undefined);
  const pending = f.service.requestUserInput("room", native);
  f.store.setSessionThread(f.session.id, "other-thread");
  await f.send("/answer Q1 late"); assert.match(f.texts.at(-1)!, /未提交/);
  f.service.suspendUserInputs(); assert.equal(await pending, undefined);
  assert.deepEqual(f.mutations, []);
});

test("question ID space is disjoint from approval IDs", async t => {
  const f = fixture(t); const pending = f.service.requestUserInput("room", native);
  await f.send("/answer A1 mistaken");
  assert.match(f.texts.at(-1)!, /用法：\/answer Q/);
  await f.send("/skip Q1"); assert.deepEqual(await pending, {});
  assert.deepEqual(f.mutations, []);
});
