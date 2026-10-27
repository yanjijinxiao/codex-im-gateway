import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopCodexRunner, parseDesktopSnapshot } from "../src/codex/desktop-runner.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { CodexThreadStateError, CodexTurnExecutionError } from "../src/codex/backend.js";
import { userFacingMessageHandlingError } from "../src/bridge/errors.js";
import { CodexBackendRouter } from "../src/codex/runner.js";

test("relays a turn to the Desktop thread owner and returns its session-log completion", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-runner-"));
  const codexHome = path.join(root, "codex-home");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "08", "28");
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  const socketPath = path.join(root, "ipc.sock");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(sessionFile, jsonLine({
    timestamp: new Date().toISOString(),
    type: "session_meta",
    payload: { id: "thread-desktop", cwd: "/tmp/project" }
  }));

  const received: Array<Record<string, unknown>> = [];
  let startAttempts = 0;
  let resolveStartAccepted!: () => void;
  const startAccepted = new Promise<void>((resolve) => { resolveStartAccepted = resolve; });
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        received.push(message);
        if (message.method === "thread-stream-following-changed") {
          writeFrame(socket, ownerSnapshot("thread-desktop", { threadRuntimeStatus: { type: "idle" }, turns: [] }));
        }
        if (message.type !== "request") continue;
        if (message.method === "initialize") {
          writeFrame(socket, response(message, { clientId: "bridge-client" }));
        } else if (message.method === "thread-owner-discovery") {
          writeFrame(socket, response(message, { ownerClientId: "desktop-client" }));
        } else if (message.method === "thread-follower-start-turn") {
          startAttempts += 1;
          if (startAttempts === 1) {
            writeFrame(socket, {
              type: "response",
              requestId: message.requestId,
              resultType: "error",
              method: message.method,
              error: "conversation has an active turn"
            });
            continue;
          }
          writeFrame(socket, response(message, { result: { turn: { id: "turn-desktop" } } }));
          resolveStartAccepted();
          setTimeout(() => {
            const now = new Date().toISOString();
            fs.appendFileSync(sessionFile, [
              { timestamp: now, type: "event_msg", payload: { type: "task_started", turn_id: "turn-desktop" } },
              { timestamp: now, type: "event_msg", payload: { type: "user_message", message: "hello from DingTalk" } },
              { timestamp: now, type: "event_msg", payload: { type: "agent_reasoning", text: "正在检查 Desktop 会话" } },
              { timestamp: now, type: "event_msg", payload: { type: "item_completed", turn_id: "turn-desktop", item: { type: "AgentMessage", phase: "commentary", content: [{ type: "Text", text: "正在解析可见进度" }] } } },
              { timestamp: now, type: "response_item", payload: { type: "message", phase: "commentary", content: [{ type: "output_text", text: "正在解析可见进度" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-desktop" } } },
              { timestamp: now, type: "event_msg", payload: { type: "item_completed", turn_id: "turn-desktop", item: { type: "ImageView", status: "completed" } } },
              { timestamp: now, type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "functions.exec", input: "{}" } },
              { timestamp: now, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1", output: "ok" } },
              { timestamp: now, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-desktop", last_agent_message: "desktop reply" } }
            ].map(jsonLine).join(""));
          }, 80);
        } else if (message.method === "thread-follower-interrupt-turn") {
          writeFrame(socket, response(message, { ok: true }));
        } else if (message.method === "thread-follower-steer-turn") {
          writeFrame(socket, response(message, { result: { turnId: "turn-desktop" } }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));

  const runner = new DesktopCodexRunner({
    socketPath,
    codexHome,
    timeoutMs: 25,
    completionPollIntervalMs: 10,
    busyRetryDelayMs: 10
  });
  t.after(async () => {
    runner.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const progress: string[] = [];
  const outcome = runner.run({
    prompt: "hello from DingTalk",
    clientUserMessageId: "gateway-original-source",
    cwd: "/tmp/project",
    threadId: "thread-desktop",
    sandbox: "workspace-write",
    onUserInput: async () => ({}),
    onProgress: (message) => progress.push(message)
  });
  await startAccepted;
  await assert.rejects(runner.steer({
    threadId: "thread-desktop",
    expectedTurnId: "turn-desktop",
    prompt: "先验证介入链路",
    cwd: "/tmp/project",
    clientUserMessageId: "dingtalk-message-1"
  }), /不支持指定任务的安全介入/);
  await runner.stop("thread-desktop");
  const result = await outcome;

  assert.deepEqual(result, {
    threadId: "thread-desktop",
    turnId: "turn-desktop",
    text: "desktop reply",
    raw: JSON.stringify({
      sessionId: "thread-desktop",
      turnId: "turn-desktop",
      workspace: "/tmp/project",
      taskTitle: "hello from DingTalk",
      text: "desktop reply",
      success: true,
      outcome: "completed",
      completedAt: result.raw ? JSON.parse(result.raw).completedAt : ""
    })
  });
  assert.deepEqual(progress, [
    "当前会话由 Codex Desktop 持有，已转交桌面端继续执行。",
    "当前会话的上一条任务仍在处理中，已加入队列。",
    "🤔 正在检查 Desktop 会话",
    "正在解析可见进度",
    "✅ 检查图片完成",
    "🔎 正在执行本地操作",
    "✅ 执行本地操作完成"
  ]);
  assert.equal(startAttempts, 2);
  const interrupt = received.find((message) => message.method === "thread-follower-interrupt-turn");
  assert.equal(interrupt?.version, 3);
  assert.deepEqual(interrupt?.params, { conversationId: "thread-desktop" });
  const steer = received.find((message) => message.method === "thread-follower-steer-turn");
  assert.equal(steer, undefined, "an unguarded Desktop write must never be sent");
  const start = received.find((message) => message.method === "thread-follower-start-turn");
  assert.equal(start?.version, 2);
  assert.deepEqual(
    ((start?.params as Record<string, unknown>).turnStart as Record<string, unknown>).request,
    {
      threadId: "thread-desktop",
      clientUserMessageId: "gateway-original-source",
      input: [{ type: "text", text: "hello from DingTalk", text_elements: [] }],
      cwd: "/tmp/project",
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite" }
    }
  );
});

test("hydrates and invalidates the Codex Desktop task catalog after an external app-server creates a thread", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-refresh-"));
  const socketPath = path.join(root, "ipc.sock");
  const received: Array<Record<string, unknown>> = [];
  let resolveInvalidation!: () => void;
  const invalidationReceived = new Promise<void>((resolve) => {
    resolveInvalidation = resolve;
  });
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        received.push(message);
        if (message.method === "query-cache-invalidate") resolveInvalidation();
        if (message.type === "request" && message.method === "initialize") {
          writeFrame(socket, response(message, { clientId: "bridge-refresh-client" }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));

  const runner = new DesktopCodexRunner({ socketPath, timeoutMs: 2_000 });
  t.after(async () => {
    runner.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  await runner.refreshTaskList("thread-external");
  await invalidationReceived;

  const hydration = received.find((message) => message.method === "thread-unarchived");
  assert.equal(hydration?.type, "broadcast");
  assert.equal(hydration?.version, 1);
  assert.deepEqual(hydration?.params, {
    conversationId: "thread-external",
    hostId: "local"
  });
  const invalidation = received.find((message) => message.method === "query-cache-invalidate");
  assert.equal(invalidation?.type, "broadcast");
  assert.equal(invalidation?.version, 0);
  assert.deepEqual(invalidation?.params, { queryKey: ["tasks"] });
});

function response(request: Record<string, unknown>, result: unknown): Record<string, unknown> {
  return {
    type: "response",
    requestId: request.requestId,
    resultType: "success",
    method: request.method,
    result
  };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function writeFrame(socket: net.Socket, message: unknown): void {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  socket.write(Buffer.concat([header, payload]));
}

function ownerSnapshot(threadId: string, state: unknown): Record<string, unknown> {
  return { type: "broadcast", method: "thread-stream-state-changed", version: 11,
    params: { conversationId: threadId, hostId: "local", change: { type: "snapshot", conversationState: state } } };
}

test("Desktop paginated owner history is ordered by turn time, and orphan UI tails are not executions", () => {
  const result = parseDesktopSnapshot("thread", { cwd: "/tmp/project", threadRuntimeStatus: { type: "idle" },
    turns: [], turnHistory: { history: { entitiesByKey: {
      newest: { turnId: "new", status: "interrupted", turnStartedAtMs: 2000, items: [] },
      orphan: { turnId: null, status: "inProgress", turnStartedAtMs: 2500, items: [] },
      olderPage: { turnId: "old", status: "completed", turnStartedAtMs: 1000,
        items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "普通钉钉消息" }] }] }
    } } } });
  assert.equal(result.state.executionOwner, "desktop");
  assert.equal(result.state.runtimeStatus, "idle");
  assert.equal(result.state.pendingTurnWithoutId, true);
  assert.equal(result.state.activeTurnId, undefined);
  assert.equal(result.state.latestTurnStatus, "interrupted");
  assert.deepEqual(result.turns.map(turn => turn.id), ["old", "new"]);
  assert.deepEqual(result.turns.map(turn => turn.startedAt), ["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:02.000Z"]);
  assert.equal(result.turns[0].messages[0].createdAt, "1970-01-01T00:00:01.000Z");
});

async function desktopOwnerFixture(t: test.TestContext, snapshot: () => Record<string, unknown>, accepted: unknown = {}, earlySnapshot = false,
  options: { wrongHostFirst?: boolean; delayMs?: number; observationTimeoutMs?: number; steerReply?: unknown } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-desktop-state-"));
  fs.mkdirSync(path.join(root, "sessions"));
  const socketPath = path.join(root, "ipc.sock");
  const received: Record<string, unknown>[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const send = (value: Record<string, unknown>) => options.delayMs
      ? setTimeout(() => { if (!socket.destroyed) writeFrame(socket, value); }, options.delayMs)
      : writeFrame(socket, value);
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (buffer.length < size + 4) return;
        const message = JSON.parse(buffer.subarray(4, size + 4).toString()) as Record<string, unknown>;
        buffer = buffer.subarray(size + 4);
        received.push(message);
        if (message.method === "initialize") send(response(message, { clientId: "test" }));
        if (message.method === "thread-owner-discovery") {
          if (earlySnapshot) writeFrame(socket, ownerSnapshot("thread", snapshot()));
          send(response(message, {}));
        }
        if (message.method === "thread-stream-following-changed") {
          if (options.wrongHostFirst) send({ type: "broadcast", method: "thread-stream-state-changed", version: 11,
            params: { conversationId: "thread", hostId: "remote-host", change: { type: "snapshot",
              conversationState: { title: "WRONG_HOST", threadRuntimeStatus: { type: "idle" }, turns: [] } } } });
          send(ownerSnapshot("thread", snapshot()));
        }
        if (message.method === "thread-follower-start-turn" && accepted !== null) writeFrame(socket, response(message, accepted));
        if (message.method === "thread-follower-steer-turn" && options.steerReply !== null) {
          writeFrame(socket, response(message, options.steerReply ?? { result: { turnId: "native-selected-turn" } }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  const runner = new DesktopCodexRunner({ codexHome: root, socketPath, timeoutMs: 300, busyRetryDelayMs: 5,
    observationTimeoutMs: options.observationTimeoutMs });
  t.after(async () => {
    runner.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { runner, received, root };
}

for (const runtime of ["idle", "systemError"]) {
test(`Desktop capacity continuation inherits settings and sends empty input: ${runtime}`, async t => {
  const { runner, root, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: runtime },
    turns: [{ turnId: "failed", status: "failed", items: [], error: { message: "capacity", codexErrorInfo: "serverOverloaded" } }] }),
    { result: { turnId: "continued" } });
  const result = await runner.resumeAfterCapacity({ threadId: "thread", failedTurnId: "failed", clientUserMessageId: "stable-attempt", assertCurrent() {},
    onTurnStarted() {
      const timestamp = new Date().toISOString();
      fs.writeFileSync(path.join(root, "sessions", "continued.jsonl"), [
        { timestamp, type: "session_meta", payload: { id: "thread", cwd: root } },
        { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "continued" } },
        { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: "continued", last_agent_message: "recovered" } }
      ].map(e => JSON.stringify(e)).join("\n") + "\n");
    } });
  assert.equal(result.turnId, "continued"); assert.equal(result.text, "recovered");
  const start = received.find(m => m.method === "thread-follower-start-turn") as { params: { turnStart: { request: Record<string, unknown>; context: unknown } } };
  assert.deepEqual(start.params.turnStart.request, { threadId: "thread", input: [], clientUserMessageId: "stable-attempt", turnTrigger: "capacity_retry_automatic" });
  assert.deepEqual(start.params.turnStart.context, { inheritThreadSettings: true });
  assert.equal(received.filter(m => m.method === "thread-follower-start-turn").length, 1);
});
}

test("Desktop capacity recovery refuses a changed tail or cancelled plan before any write", async t => {
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "idle" }, turns: [
    { turnId: "newer", status: "completed", items: [] }] }));
  await assert.rejects(runner.resumeAfterCapacity({ threadId: "thread", failedTurnId: "failed", clientUserMessageId: "never", assertCurrent() {}, onTurnStarted() {} }), /恢复条件已变化/);
  assert.equal(received.filter(m => m.method === "thread-follower-start-turn").length, 0);
});

test("Desktop systemError is authoritative, and no ordinary input or idle start is sent", async t => {
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "systemError" },
    turns: [{ turnId: "failed-turn", status: "failed", items: [], error: { message:
      "This request was blocked by our safety systems. Reason: Potentially unintended activity.", additionalDetails: "PRIVATE_TOKEN" } }] }));
  const state = await runner.inspectThread("thread");
  assert.equal(state?.runtimeStatus, "systemError");
  assert.deepEqual(state?.lastTurnFailure, { turnId: "failed-turn", code: "unintended-activity" });
  assert.ok(!JSON.stringify(state).includes("PRIVATE_TOKEN"));
  const input = { threadId: "thread", prompt: "new input", cwd: "/tmp", clientUserMessageId: "im-id" };
  for (const run of [() => runner.run(input), () => runner.submitThreadMessage(input)]) {
    await assert.rejects(run(), error => {
      assert.ok(error instanceof CodexThreadStateError && error.code === "system-error");
      assert.match(userFacingMessageHandlingError(error), /systemError.*新消息未提交/);
      assert.match(userFacingMessageHandlingError(error), /Potentially unintended activity/);
      return true;
    });
  }
  assert.equal(received.filter(m => /start-turn|steer-turn|interrupt-turn/.test(String(m.method))).length, 0);
});

test("Desktop catches a systemError transition after Router preflight without changing writer or replaying", async t => {
  let broken = false, otherWrites = 0;
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: broken ? "systemError" : "idle" },
    turns: [] }));
  const router = new CodexBackendRouter({ backend: "app-server", desktopRunner: runner,
    appServerBackend: { async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: "notLoaded", activeFlags: [] }; },
      async run() { otherWrites++; throw new Error("must not transfer writer"); }, close() {} } as never });
  t.after(() => router.close());
  assert.equal((await router.inspectThread("thread")).runtimeStatus, "idle");
  broken = true;
  await assert.rejects(router.run({ threadId: "thread", prompt: "new", cwd: "/tmp" }), e => e instanceof CodexThreadStateError && e.code === "system-error");
  assert.equal(otherWrites, 0);
  assert.equal(received.filter(m => /start-turn|steer-turn|interrupt-turn/.test(String(m.method))).length, 0);
});

test("a confirmed failed Desktop turn retains its public failure code without replay", async t => {
  const { runner, root, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "idle" }, turns: [] }),
    { result: { turnId: "new-turn" } });
  await assert.rejects(runner.run({ threadId: "thread", prompt: "new", cwd: root, onTurnStarted() {
    const timestamp = new Date().toISOString();
    fs.writeFileSync(path.join(root, "sessions", "failure.jsonl"), [
      { timestamp, type: "session_meta", payload: { id: "thread", cwd: root } },
      { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "new-turn" } },
      { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: "new-turn", error: {
        message: "This request was blocked by our safety systems. Reason: Potentially unintended activity.", additionalDetails: "SECRET_BODY" } } }
    ].map(e => JSON.stringify(e)).join("\n") + "\n");
  } }), error => {
    assert.ok(error instanceof CodexTurnExecutionError);
    assert.equal(error.failureCode, "unintended-activity");
    assert.match(userFacingMessageHandlingError(error), /Potentially unintended activity/);
    assert.doesNotMatch(userFacingMessageHandlingError(error), /SECRET_BODY|本轮消息处理失败/);
    return true;
  });
  assert.equal(received.filter(m => m.method === "thread-follower-start-turn").length, 1);
  assert.equal(received.filter(m => /steer-turn|interrupt-turn/.test(String(m.method))).length, 0);
});

test("ordinary Desktop input uses one native thread-scoped write, without changing guarded steering", async t => {
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "active" },
    turns: [{ turnId: "observed-turn", status: "inProgress", items: [] }] }));
  let checks = 0;
  const receipt = await runner.submitThreadMessage({ threadId: "thread", prompt: "ordinary follow-up", cwd: "/tmp/project",
    clientUserMessageId: "original-im-id", assertCurrent: () => { checks++; } });
  assert.deepEqual(receipt, { status: "accepted", threadId: "thread", turnId: "native-selected-turn" });
  assert.equal(checks, 1);
  const writes = received.filter(m => m.method === "thread-follower-steer-turn");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].version, 1);
  assert.deepEqual(writes[0].params, { conversationId: "thread", input: [{ type: "text", text: "ordinary follow-up", text_elements: [] }],
    restoreMessage: { context: {} }, clientUserMessageId: "original-im-id" });
  await assert.rejects(runner.steer({ threadId: "thread", expectedTurnId: "observed-turn", prompt: "guarded" }), /不支持指定任务的安全介入/);
  assert.equal(received.filter(m => /start-turn|interrupt-turn/.test(String(m.method))).length, 0);
  assert.equal(received.filter(m => m.method === "thread-follower-steer-turn").length, 1);
});

for (const invalid of [null, {}]) {
  test(`Desktop ordinary input preserves an unknown receipt (${invalid === null ? "timeout" : "invalid"}) without replay or task start`, async t => {
    const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "active" },
      turns: [{ turnId: "active", status: "inProgress", items: [] }] }), {}, false, { steerReply: invalid });
    await assert.rejects(runner.submitThreadMessage({ threadId: "thread", prompt: "message", cwd: "/tmp", clientUserMessageId: "id" }),
      error => error instanceof CodexCommunicationError && error.phase === "submission" && error.submission === "unconfirmed");
    assert.equal(received.filter(m => m.method === "thread-follower-steer-turn").length, 1);
    assert.equal(received.filter(m => /start-turn|interrupt-turn/.test(String(m.method))).length, 0);
  });
}

test("Desktop ordinary input rejects idle/orphan runtime and changed bindings before writing", async t => {
  let active = false;
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: active ? "active" : "idle" },
    turns: [{ turnId: active ? "turn" : null, status: "inProgress", items: [] }] }));
  const input = { threadId: "thread", prompt: "message", cwd: "/tmp", clientUserMessageId: "id" };
  await assert.rejects(runner.submitThreadMessage(input), /没有可确认的活动轮次/);
  active = true;
  await assert.rejects(runner.submitThreadMessage({ ...input, assertCurrent: () => { throw new Error("binding changed"); } }), /binding changed/);
  assert.equal(received.filter(m => /steer-turn|start-turn|interrupt-turn/.test(String(m.method))).length, 0);
});

test("ordinary Desktop input uses the shared total preflight budget and does not write after expiry", async t => {
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "active" },
    turns: [{ turnId: "active", status: "inProgress", items: [] }] }), {}, false, { delayMs: 100, observationTimeoutMs: 250 });
  await assert.rejects(runner.submitThreadMessage({ threadId: "thread", prompt: "message", cwd: "/tmp", clientUserMessageId: "id" }),
    error => error instanceof CodexCommunicationError && error.operation === "thread/owner-snapshot" && error.submission === "not-submitted");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(received.filter(m => /steer-turn|start-turn|interrupt-turn/.test(String(m.method))).length, 0);
});

test("owner snapshots published before the discovery response are not lost", async t => {
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "idle" }, turns: [] }), {}, true);
  const snapshot = await runner.readThreadSnapshot("thread");
  assert.equal(snapshot?.state.runtimeStatus, "idle");
  assert.equal(received.filter(m => m.method === "thread-follower-start-turn").length, 0);
});

test("Desktop preflight and follow share only the current observation, not a stale snapshot", async t => {
  let reads = 0;
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "idle" },
    title: `read-${++reads}`, turns: [] }));
  const [state, first, second] = await Promise.all([runner.inspectThread("thread"), runner.readThreadSnapshot("thread"), runner.readThreadSnapshot("thread")]);
  assert.equal(state?.title, "read-1"); assert.equal(first?.state.title, second?.state.title);
  assert.equal(received.filter(message => message.method === "initialize").length, 1);
  assert.equal((await runner.readThreadSnapshot("thread"))?.state.title, "read-2");
  assert.equal(received.filter(message => message.method === "initialize").length, 2);
  assert.equal(received.filter(message => /start-turn|steer|interrupt/.test(String(message.method))).length, 0);
});

test("local owner reads ignore a remote snapshot with the same thread ID", async t => {
  const { runner } = await desktopOwnerFixture(t, () => ({ title: "LOCAL_OWNER", threadRuntimeStatus: { type: "idle" }, turns: [] }),
    {}, false, { wrongHostFirst: true });
  assert.equal((await runner.readThreadSnapshot("thread"))?.state.title, "LOCAL_OWNER");
});

test("owner observation has one end-to-end deadline and does not submit on timeout", async t => {
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "idle" }, turns: [] }),
    {}, false, { delayMs: 100, observationTimeoutMs: 250 });
  await assert.rejects(runner.readThreadSnapshot("thread"), error => error instanceof CodexCommunicationError
    && error.operation === "thread/owner-snapshot" && error.code === "timeout" && error.submission === "not-submitted");
  assert.equal(received.filter(message => /start-turn|steer|interrupt/.test(String(message.method))).length, 0);
});

test("ordinary Desktop messages wait for idle instead of invoking start while the old turn is active", async t => {
  let observations = 0;
  const { runner, received } = await desktopOwnerFixture(t, () => ({
    threadRuntimeStatus: { type: ++observations < 3 ? "active" : "idle" },
    turns: [{ turnId: "old-turn", status: observations < 3 ? "inProgress" : "completed", items: [] }]
  }));
  const progress: string[] = [];
  await assert.rejects(runner.run({ cwd: "/tmp", threadId: "thread", prompt: "你是 GPT？",
    onProgress: text => { progress.push(text); } }),
    error => error instanceof CodexCommunicationError
      && error.code === "invalid-receipt" && error.submission === "unconfirmed");
  assert.equal(observations, 3);
  assert.equal(received.filter(message => message.method === "thread-follower-start-turn").length, 1);
  assert.equal(progress.filter(text => text.includes("已加入队列")).length, 1);
});

test("idle Desktop with a null inProgress UI turn fails visibly without submitting or interrupting", async t => {
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "idle" },
    turns: [{ turnId: null, status: "inProgress", items: [] }] }));
  await assert.rejects(runner.run({ cwd: "/tmp", threadId: "thread", prompt: "你是 GPT？" }), /残留.*轮次 ID/);
  assert.equal(received.filter(message => /start-turn|interrupt-turn/.test(String(message.method))).length, 0);
});

test("a Desktop acknowledgement of an existing turn is never retried or reported as a new turn", async t => {
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "idle" },
    turns: [{ turnId: "old-turn", status: "interrupted", items: [] }] }), { result: { turn: { id: "old-turn" } } });
  let starts = 0;
  await assert.rejects(runner.run({ cwd: "/tmp", threadId: "thread", prompt: "你是 GPT？",
    onTurnStarted: () => { starts++; } }), /已有轮次.*未重复提交/);
  assert.equal(starts, 0);
  assert.equal(received.filter(message => message.method === "thread-follower-start-turn").length, 1);
});

test("a missing Desktop start receipt remains unconfirmed without replay or interruption", async t => {
  const { runner, received } = await desktopOwnerFixture(t, () => ({ threadRuntimeStatus: { type: "idle" }, turns: [] }), null);
  await assert.rejects(runner.run({ cwd: "/tmp", threadId: "thread", prompt: "original-input" }),
    error => error instanceof CodexCommunicationError && error.phase === "submission" && error.submission === "unconfirmed");
  assert.equal(received.filter(message => message.method === "thread-follower-start-turn").length, 1);
  assert.equal(received.filter(message => /interrupt-turn|steer-turn/.test(String(message.method))).length, 0);
});
