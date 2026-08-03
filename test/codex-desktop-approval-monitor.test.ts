import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexDesktopApprovalMonitor } from "../src/server/codex-desktop-approval-monitor.js";

test("forwards a followed Codex Desktop approval to the channel and returns its decision", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-approval-"));
  const socketPath = path.join(root, "ipc.sock");

  const decisionMessages: Array<Record<string, unknown>> = [];
  let resolveDecisionRequests!: (messages: Array<Record<string, unknown>>) => void;
  const decisionRequests = new Promise<Array<Record<string, unknown>>>((resolve) => { resolveDecisionRequests = resolve; });
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) break;
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(length + 4);
        if (message.method === "initialize") {
          writeFrame(socket, {
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "initialize",
            result: { clientId: "bridge-client" }
          });
        } else if (message.method === "thread-stream-following-changed") {
          writeFrame(socket, {
            type: "broadcast",
            sourceClientId: "desktop-client",
            method: "thread-stream-state-changed",
            version: 11,
            params: {
              conversationId: "thread-one",
              change: {
                type: "snapshot",
                revision: 1,
                conversationState: {
                  cwd: "/workspace/project",
                  requests: [
                    {
                      method: "item/commandExecution/requestApproval",
                      id: 42,
                      params: {
                        threadId: "thread-one",
                        turnId: "turn-one",
                        itemId: "item-command",
                        command: "touch approved.txt",
                        reason: "create output"
                      }
                    },
                    {
                      method: "item/fileChange/requestApproval",
                      id: 43,
                      params: {
                        threadId: "thread-one",
                        turnId: "turn-one",
                        itemId: "item-file",
                        grantRoot: "/workspace/project"
                      }
                    },
                    {
                      method: "item/permissions/requestApproval",
                      id: 44,
                      params: {
                        threadId: "thread-one",
                        turnId: "turn-one",
                        itemId: "item-permissions",
                        permissions: { network: { enabled: true } }
                      }
                    }
                  ]
                }
              }
            }
          });
        } else if (typeof message.method === "string" && message.method.includes("approval")) {
          decisionMessages.push(message);
          if (decisionMessages.length === 3) resolveDecisionRequests(decisionMessages);
          writeFrame(socket, {
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: message.method,
            result: { ok: true }
          });
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));

  const approvals: Array<Record<string, unknown>> = [];
  const monitor = new CodexDesktopApprovalMonitor({
    socketPath,
    reconnectDelayMs: 10,
    onApproval: async (approval) => {
      approvals.push(approval.request);
      return "accept";
    }
  });
  t.after(() => {
    monitor.stop();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  monitor.followThread("thread-one");
  monitor.start();

  const outbound = await Promise.race([
    decisionRequests,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("approval decision timeout")), 2_000))
  ]);
  assert.deepEqual(approvals, [{
    kind: "command",
    threadId: "thread-one",
    turnId: "turn-one",
    itemId: "item-command",
    command: "touch approved.txt",
    cwd: "/workspace/project",
    reason: "create output"
  }, {
    kind: "file",
    threadId: "thread-one",
    turnId: "turn-one",
    itemId: "item-file",
    cwd: "/workspace/project",
    grantRoot: "/workspace/project"
  }, {
    kind: "permissions",
    threadId: "thread-one",
    turnId: "turn-one",
    itemId: "item-permissions",
    cwd: "/workspace/project",
    permissions: { network: { enabled: true } }
  }]);
  assert.deepEqual(outbound.map((message) => message.method), [
    "thread-follower-command-approval-decision",
    "thread-follower-file-approval-decision",
    "thread-follower-permissions-request-approval-response"
  ]);
  assert.deepEqual(outbound[0]?.params, {
    conversationId: "thread-one",
    requestId: 42,
    decision: "accept"
  });
  assert.deepEqual(outbound[1]?.params, {
    conversationId: "thread-one",
    requestId: 43,
    decision: "accept"
  });
  assert.deepEqual(outbound[2]?.params, {
    conversationId: "thread-one",
    requestId: 44,
    response: {
      permissions: { network: { enabled: true } },
      scope: "turn"
    }
  });
});

function writeFrame(socket: net.Socket, message: unknown): void {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  socket.write(Buffer.concat([header, payload]));
}
