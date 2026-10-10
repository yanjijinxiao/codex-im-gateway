import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexDesktopApprovalMonitor, type CodexDesktopApprovalMonitorOptions } from "../src/server/codex-desktop-approval-monitor.js";

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

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("mock approval condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function approvalFixture(t: test.TestContext, options: Partial<CodexDesktopApprovalMonitorOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-receipt-"));
  const socketPath = path.join(root, "ipc.sock");
  const messages: Array<Record<string, unknown>> = [];
  const results: string[] = [];
  const approvals: unknown[] = [];
  const sockets = new Set<net.Socket>();
  let peer!: net.Socket;
  const server = net.createServer(socket => {
    peer = socket;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) break;
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
        buffer = buffer.subarray(length + 4);
        messages.push(message);
        if (message.method === "initialize") writeFrame(socket, {
          type: "response", requestId: message.requestId, method: "initialize", resultType: "success", result: { clientId: "mock-client" }
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  const monitor = new CodexDesktopApprovalMonitor({
    socketPath, reconnectDelayMs: 10_000, decisionTimeoutMs: 500,
    onApproval: async approval => { approvals.push(approval); return "accept"; },
    ...options,
    onResult: async (approval, result) => { results.push(result); await options.onResult?.(approval, result); }
  });
  t.after(() => {
    monitor.stop();
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  monitor.followThread("thread-one");
  monitor.followThread("thread-one");
  monitor.start();
  await waitFor(() => messages.some(message => message.method === "thread-stream-following-changed"));
  const nativeRequest = { id: 42, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-one", turnId: "turn-one", itemId: "item-one", command: "echo mock"
  } };
  const snapshot = (requests: unknown[] = [nativeRequest]) => writeFrame(peer, {
    type: "broadcast", method: "thread-stream-state-changed",
    params: { conversationId: "thread-one", change: { type: "snapshot", conversationState: { requests } } }
  });
  const decisionMessages = () => messages.filter(message => message.method === "thread-follower-command-approval-decision");
  const patches = (patches: unknown[]) => writeFrame(peer, {
    type: "broadcast", method: "thread-stream-state-changed",
    params: { conversationId: "thread-one", change: { type: "patches", patches } }
  });
  const respond = (resultType: string) => {
    const message = decisionMessages()[0]!;
    writeFrame(peer, { type: "response", requestId: message.requestId, method: message.method, resultType,
      ...(resultType === "success" ? { result: { ok: true } } : { error: { message: "mock denial" } }) });
  };
  return { monitor, snapshot, patches, respond, peer, results, approvals, messages, decisionMessages, nativeRequest };
}

test("waits for the actual Desktop decision receipt and deduplicates snapshots/subscriptions", async t => {
  const f = await approvalFixture(t);
  f.snapshot();
  f.snapshot();
  await waitFor(() => f.decisionMessages().length === 1);
  assert.deepEqual(f.results, []);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.messages.filter(message => message.method === "thread-stream-following-changed").length, 1);
  // The native request can disappear before the receipt arrives.
  f.snapshot([]);
  f.respond("success");
  await waitFor(() => f.results.length > 0);
  assert.deepEqual(f.results, ["confirmed"]);
});

for (const failure of ["error", "timeout", "disconnect"] as const) {
  test(`does not claim confirmation or retry an approval after a ${failure}`, async t => {
    const f = await approvalFixture(t, { decisionTimeoutMs: 30 });
    f.snapshot();
    await waitFor(() => f.decisionMessages().length === 1);
    if (failure === "error") f.respond("error");
    if (failure === "disconnect") f.peer.destroy();
    await waitFor(() => f.results.length > 0);
    assert.deepEqual(f.results, ["failed"]);
    if (failure !== "disconnect") {
      f.snapshot();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(f.decisionMessages().length, 1);
  });
}

for (const withdrawal of ["desktop", "unsubscribe"] as const) {
  test(`invalidates a pending IM approval after ${withdrawal} withdrawal`, async t => {
    let decide!: (value: "accept") => void;
    let seen = false;
    const f = await approvalFixture(t, { onApproval: async () => {
      seen = true;
      return new Promise(resolve => { decide = resolve; });
    } });
    f.snapshot();
    await waitFor(() => seen);
    if (withdrawal === "desktop") f.snapshot([]);
    else f.monitor.setFollowedThreads([]);
    await waitFor(() => f.results.length > 0);
    decide("accept");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(f.results, ["withdrawn"]);
    assert.equal(f.decisionMessages().length, 0);
  });
}

test("does not forward a request for a different thread in a followed snapshot", async t => {
  const f = await approvalFixture(t);
  f.snapshot([{ ...f.nativeRequest, params: { ...f.nativeRequest.params, threadId: "unfollowed-thread" } }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.approvals, []);
  assert.equal(f.decisionMessages().length, 0);
});

test("a previously unroutable approval is retried when bindings become available", async t => {
  let routable = false;
  let attempts = 0;
  const f = await approvalFixture(t, { onApproval: async () => {
    attempts += 1;
    return routable ? "accept" : undefined;
  } });
  f.snapshot();
  await waitFor(() => attempts === 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.decisionMessages().length, 0);
  routable = true;
  f.monitor.setFollowedThreads(["thread-one"]);
  await waitFor(() => f.decisionMessages().length === 1);
  f.respond("success");
  await waitFor(() => f.results.length > 0);
  assert.deepEqual(f.results, ["confirmed"]);
});

test("does not lose a binding change while an initial routing attempt is still pending", async t => {
  let release!: (value: undefined) => void;
  let attempts = 0;
  const f = await approvalFixture(t, { onApproval: async () => {
    attempts += 1;
    if (attempts > 1) return "accept";
    return new Promise(resolve => { release = resolve; });
  } });
  f.snapshot();
  await waitFor(() => attempts === 1);
  f.monitor.setFollowedThreads(["thread-one"]);
  release(undefined);
  await waitFor(() => f.decisionMessages().length === 1);
  f.respond("success");
  await waitFor(() => f.results.length > 0);
  assert.equal(attempts, 2);
  assert.deepEqual(f.results, ["confirmed"]);
});

test("detects an approval appended through an incremental array patch", async t => {
  const f = await approvalFixture(t);
  f.snapshot([]);
  f.patches([{ op: "add", path: ["requests", 0], value: f.nativeRequest }]);
  await waitFor(() => f.decisionMessages().length === 1);
  assert.equal(f.approvals.length, 1);
  f.respond("success");
  await waitFor(() => f.results.length > 0);
  assert.deepEqual(f.results, ["confirmed"]);
});

for (const patchPath of [["requests", 0], ["requests"]]) {
  test(`invalidates a notice when ${patchPath.join("/")} is removed by a patch`, async t => {
    let decide!: (value: "accept") => void;
    let seen = false;
    const f = await approvalFixture(t, { onApproval: async () => {
      seen = true;
      return new Promise(resolve => { decide = resolve; });
    } });
    f.snapshot();
    await waitFor(() => seen);
    f.patches([{ op: "remove", path: patchPath }]);
    await waitFor(() => f.results.length > 0);
    decide("accept");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(f.results, ["withdrawn"]);
    assert.equal(f.decisionMessages().length, 0);
  });
}

test("a changed command withdraws the old notice without mutating its displayed request", async t => {
  const seen: Array<{ command?: string }> = [];
  const decisions: Array<(value: "accept") => void> = [];
  const f = await approvalFixture(t, { onApproval: async approval => {
    seen.push(approval.request);
    return new Promise(resolve => { decisions.push(resolve); });
  } });
  f.snapshot();
  await waitFor(() => seen.length === 1);
  f.patches([{ op: "replace", path: ["requests", 0, "params", "command"], value: "echo changed" }]);
  await waitFor(() => f.results.includes("withdrawn"));
  assert.equal(seen[0]?.command, "echo mock");
  decisions[0]!("accept");
  await waitFor(() => seen.length === 2);
  assert.equal(seen[1]?.command, "echo changed");
  assert.equal(f.decisionMessages().length, 0);
  decisions[1]!("accept");
  await waitFor(() => f.decisionMessages().length === 1);
  f.respond("success");
  await waitFor(() => f.results.includes("confirmed"));
});

test("processes an incremental batch atomically and rejects prototype paths", async t => {
  const f = await approvalFixture(t);
  f.snapshot([]);
  f.patches([{ op: "add", path: ["requests", 0], value: f.nativeRequest }, { op: "remove", path: ["requests", 0] }]);
  f.patches([{ op: "add", path: ["requests", 0], value: f.nativeRequest },
    { op: "add", path: ["requests", 0, "__proto__", "approvalPolluted"], value: true }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.approvals, []);
  assert.equal(({} as Record<string, unknown>).approvalPolluted, undefined);
});
