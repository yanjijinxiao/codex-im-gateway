import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopCodexRunner } from "../src/codex/desktop-runner.js";

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
    cwd: "/tmp/project",
    threadId: "thread-desktop",
    sandbox: "workspace-write",
    onUserInput: async () => ({}),
    onProgress: (message) => progress.push(message)
  });
  await startAccepted;
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
  const start = received.find((message) => message.method === "thread-follower-start-turn");
  assert.equal(start?.version, 2);
  assert.deepEqual(
    ((start?.params as Record<string, unknown>).turnStart as Record<string, unknown>).request,
    {
      threadId: "thread-desktop",
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
