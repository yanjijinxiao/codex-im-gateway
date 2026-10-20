import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexFailureCode, codexFailureSummary, lastCodexTurnFailure } from "../src/codex/turn-failure.js";
import { assertCodexThreadRunnable, CodexThreadStateError, CodexTurnExecutionError, type CodexThreadState } from "../src/codex/backend.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { userFacingMessageHandlingError, wasMessageHandlingErrorReported } from "../src/bridge/errors.js";
import { communicationError } from "../src/codex/communication-error.js";
import { BridgeService } from "../src/bridge/service.js";
import { ChannelTurnTextStream } from "../src/channels/progress.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { parseDesktopSnapshot } from "../src/codex/desktop-runner.js";

const blocked = "This request was blocked by our safety systems. Reason: Potentially unintended activity.";

test("public failure reasons come only from native message/code, never arbitrary provider details", () => {
  assert.equal(codexFailureCode({ message: blocked, additionalDetails: "PRIVATE_TOKEN" }), "unintended-activity");
  assert.equal(codexFailureCode({ message: "failed", additionalDetails: blocked }), "upstream-error");
  assert.equal(codexFailureCode({ codexErrorInfo: "ContextWindowExceeded" }), "context-window");
  assert.equal(codexFailureCode({ codexErrorInfo: { ResponseStreamDisconnected: { httpStatusCode: 500, secret: "PRIVATE" } } }), "upstream-connection");
  assert.equal(codexFailureCode({ codexErrorInfo: "UsageLimitExceeded" }), "usage-limit");
  for (const raw of [blocked + " Bearer PRIVATE_TOKEN", "{\"token\":\"PRIVATE_TOKEN\"}", "secret path /private/token.txt\n at STACK"]) {
    const text = userFacingMessageHandlingError(new CodexTurnExecutionError("failed", raw));
    assert.doesNotMatch(text, /PRIVATE_TOKEN|\/private|STACK|Bearer/);
    assert.match(text, /已确认.*失败|确认本轮执行失败/);
  }
  assert.equal(lastCodexTurnFailure({ id: "old", status: "completed", error: { message: blocked } }), undefined);
  assert.equal(lastCodexTurnFailure({ status: "failed", error: { message: blocked } }), undefined);
  assert.match(codexFailureSummary("unintended-activity"), /Potentially unintended activity/);
});

test("native execution failure containing timeout is not converted into uncertain submission or retry guidance", () => {
  const error = new CodexTurnExecutionError("failed", "upstream response stream timed out");
  assert.equal(communicationError(error, { phase: "observation", operation: "turn/observe", turnId: "turn" }), error);
  const text = userFacingMessageHandlingError(error);
  assert.match(text, /已明确失败/);
  assert.doesNotMatch(text, /这不代表任务失败|请拆成|任务是否已接收尚未确认/);
  assert.match(userFacingMessageHandlingError(new CodexTurnExecutionError("interrupted", "PRIVATE")), /已中断/);
});

test("only the failed tail contributes failure metadata, never an old error after a later successful turn", () => {
  const older = { turnId: "old", status: "failed", turnStartedAtMs: 1, error: { message: blocked }, items: [] };
  const latest = { turnId: "new", status: "completed", turnStartedAtMs: 2, items: [] };
  const s = parseDesktopSnapshot("thread", { threadRuntimeStatus: { type: "idle" }, turns: [latest, older] });
  assert.equal(s.state.lastTurnFailure, undefined);
  assert.equal(s.state.latestTurnStatus, "completed");
});

test("Router preserves Desktop systemError rather than substituting private notLoaded or falling back on writes", async t => {
  const state: CodexThreadState = { threadId: "thread", persistence: "active", runtimeStatus: "systemError", executionOwner: "desktop", activeFlags: [],
    lastTurnFailure: { turnId: "failed", code: "unintended-activity" } };
  let writes = 0;
  const write = async () => { writes++; throw new Error("must not write"); };
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: {
    async inspectThread() { return { ...state, runtimeStatus: "notLoaded", executionOwner: undefined, lastTurnFailure: undefined }; },
    async readThreadSnapshot() { throw new Error("must not hydrate a foreign error away"); }, run: write, steer: write, close() {}
  } as never, desktopRunner: { async inspectThread() { return state; }, async readThreadSnapshot() { return { state, turns: [] }; },
    run: write, submitThreadMessage: write, steer: write, close() {} } as never });
  t.after(() => router.close());
  const observed = await router.inspectThread("thread");
  assert.equal(observed.runtimeStatus, "systemError");
  assert.equal((await router.readThreadSnapshot("thread")).state, state);
  const predicate = (e: unknown) => e instanceof CodexThreadStateError && e.code === "system-error";
  assert.throws(() => assertCodexThreadRunnable(observed), predicate);
  await assert.rejects(router.submitThreadMessage({ threadId: "thread", prompt: "new", cwd: "/tmp", clientUserMessageId: "id" }), predicate);
  await assert.rejects(router.steer({ threadId: "thread", prompt: "new", expectedTurnId: "failed" }), predicate);
  assert.equal(writes, 0);
});

for (const channel of ["dingtalk", "weixin", "feishu", "wecom"] as const) {
  test(`${channel}: native safety failure finishes the original card once, later systemError submits nothing and retains binding`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-failure-lifecycle-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
    const project = store.createProject("Project", root);
    const session = store.createSession("actor", root, "Task", project.id);
    store.setSessionThread(session.id, "thread");
    let broken = false, runs = 0, starts = 0;
    const finals: string[] = [], events: Array<{ success: boolean; text: string }> = [];
    const client = createChannelClient(channel, { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true }, {
      async sendText() { throw new Error("do not send duplicate failure text"); },
      async startTextStream() { starts++; return { messageId: "original" }; },
      async updateTextStream(input) { assert.equal(input.messageId, "original"); if (input.finalize) finals.push(input.text); }
    });
    let stream: ChannelTurnTextStream | undefined;
    const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: true }, stateStore: store, channel: client,
      createTextStream: async () => stream = new ChannelTurnTextStream(client, "actor", { save() {} }),
      onTurnCompleted: async e => { events.push(e); },
      runner: { async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: broken ? "systemError" : "idle", activeFlags: [],
        ...(broken ? { lastTurnFailure: { turnId: "turn", code: "unintended-activity" } } : {}) }; },
        async run(input: { onTurnStarted?: (x: { threadId: string; turnId: string }) => Promise<void> }) {
          runs++; await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" }); broken = true;
          throw new CodexTurnExecutionError("failed", blocked + " PRIVATE_TOKEN");
        }, async stop() { throw new Error("must not stop"); } } as never
    });
    t.after(async () => { await stream?.suspend(); });
    const message = { id: "first", senderId: "actor", text: "legitimate request", raw: {} };
    await assert.rejects(service.handleMessage(message), error => {
      assert.ok(error instanceof CodexTurnExecutionError);
      assert.equal(wasMessageHandlingErrorReported(error), true); return true;
    });
    assert.equal(runs, 1); assert.equal(starts, 1); assert.equal(finals.length, 1);
    assert.match(finals[0], /Potentially unintended activity/); assert.doesNotMatch(finals[0], /PRIVATE_TOKEN|本轮消息处理失败/);
    assert.equal(events.length, 1); assert.equal(events[0].success, false); assert.doesNotMatch(events[0].text, /PRIVATE_TOKEN/);
    await assert.rejects(service.handleMessage({ ...message, id: "second" }), error => {
      assert.ok(error instanceof CodexThreadStateError);
      const text = userFacingMessageHandlingError(error);
      assert.match(text, /systemError.*新消息未提交/); assert.match(text, /Potentially unintended activity/);
      assert.doesNotMatch(text, /无法确认.*空闲/); return true;
    });
    assert.equal(runs, 1); assert.equal(starts, 1); assert.equal(finals.length, 1); assert.equal(events.length, 1);
    assert.equal(store.getBoundSession("actor")?.id, session.id);
    assert.equal(store.getBoundSession("actor")?.threadId, "thread");
  });
}
