import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { userFacingMessageHandlingError, wasMessageHandlingErrorReported } from "../src/bridge/errors.js";
import { CodexCommunicationError, communicationError, isLegacyCommunicationNotice } from "../src/codex/communication-error.js";
import { ChannelTurnTextStream, type ChannelStreamCheckpoint } from "../src/channels/progress.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { CodexTurnExecutionError } from "../src/codex/backend.js";

test("communication guidance separates preflight, uncertain submission and accepted observation", () => {
  const cause = new Error("PRIVATE_TOKEN thread/read timed out after 15000ms");
  const before = userFacingMessageHandlingError(new CodexCommunicationError("preflight", "thread/read", "thread", undefined, cause));
  assert.match(before, /这条消息未提交/);
  assert.doesNotMatch(before, /任务是否已接收尚未确认|PRIVATE_TOKEN/);
  const submitting = userFacingMessageHandlingError(new CodexCommunicationError("submission", "turn/start", "thread", undefined, cause));
  assert.match(submitting, /保留原卡片.*只读核对.*不重发/);
  const observing = userFacingMessageHandlingError(new CodexCommunicationError("observation", "turn/observe", "thread", "turn", cause));
  assert.match(observing, /原任务已接收.*不代表任务失败/);
  assert.equal(communicationError(new Error("model capacity"), { phase: "submission", operation: "turn/start" }) instanceof CodexCommunicationError, false);
  assert.equal(isLegacyCommunicationNotice(submitting), false);
  const actualTaskFailure = new CodexTurnExecutionError("failed", "remote model operation timed out");
  assert.equal(communicationError(actualTaskFailure, { phase: "observation", operation: "turn/observe", turnId: "turn" }), actualTaskFailure);
});

for (const phase of ["preflight", "submission", "observation"] as const) {
  test(`ordinary IM messages retain operation outcomes without falsely completing tasks: ${phase}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-communication-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
    const project = store.createProject("Project", root);
    const session = store.createSession("actor", root, "Task", project.id);
    store.setSessionThread(session.id, "thread");
    let starts = 0, runs = 0, completions = 0;
    let checkpoint: ChannelStreamCheckpoint | undefined;
    const updates: Array<{ text: string; finalize?: boolean; error?: boolean }> = [];
    const driver = {
      async sendText() { return { messageId: "text" }; },
      async startTextStream() { starts++; return { messageId: "original" }; },
      async updateTextStream(input: { text: string; finalize?: boolean; error?: boolean }) { updates.push(input); }
    };
    const failure = new CodexCommunicationError(phase, phase === "preflight" ? "thread/read" : "turn/start", "thread",
      phase === "observation" ? "turn" : undefined, new Error("RPC timed out"));
    let stream: ChannelTurnTextStream | undefined;
    const service = new BridgeService({
      config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: true }, stateStore: store,
      weixin: driver as never,
      createTextStream: async () => stream = new ChannelTurnTextStream(driver, "actor", { save: value => { checkpoint = value; } }),
      onTurnCompleted: async () => { completions++; },
      runner: {
        async inspectThread() {
          if (phase === "preflight") throw new Error("app-server request thread/read timed out after 15000ms");
          return { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] };
        },
        async run(input: { onTurnStarted?: (x: { threadId: string; turnId: string }) => Promise<void> }) {
          runs++;
          if (phase === "observation") await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" });
          throw failure;
        },
        async stop() { throw new Error("Must never stop a task on transport timeout"); }
      } as never
    });
    t.after(async () => { await stream?.suspend(); });
    let caught: unknown;
    try { await service.handleMessage({ id: "message", senderId: "actor", text: "continue", raw: {} }); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof CodexCommunicationError);
    assert.equal(caught.submission, phase === "preflight" ? "not-submitted" : phase === "submission" ? "unconfirmed" : "accepted");
    assert.equal(completions, 0);
    assert.equal(runs, phase === "preflight" ? 0 : 1);
    assert.equal(starts, phase === "preflight" ? 0 : 1);
    assert.ok(updates.every(x => !x.finalize && !x.error));
    if (phase !== "preflight") {
      assert.equal(checkpoint?.finished, false);
      assert.equal(checkpoint?.terminal, undefined);
      assert.ok(checkpoint?.communicationNotice);
      assert.equal(wasMessageHandlingErrorReported(caught), true);
      await stream!.progress("收到原任务的新进展");
      assert.equal(stream!.checkpoint().communicationNotice, undefined);
    }
  });
}
