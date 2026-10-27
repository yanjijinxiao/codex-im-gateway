import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexDesktopRequestMonitor } from "../src/server/codex-desktop-request-monitor.js";

function bytes(message: unknown) { const data = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(data.length); return Buffer.concat([header, data]); }
async function until(check: () => boolean) { const deadline = Date.now() + 1500; while (!check()) { if (Date.now() > deadline) throw Error("fixture timed out"); await new Promise(r => setTimeout(r, 5)); } }
async function fixture(t: test.TestContext, acknowledge = true, connectionTimeoutMs = 500) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-review-desktop-connect-")), socketPath = path.join(root, "ipc.sock");
  const peers: net.Socket[] = [], messages: any[] = [], questions: any[] = [];
  const server = net.createServer(socket => { peers.push(socket); let pending = Buffer.alloc(0);
    socket.on("data", chunk => { pending = Buffer.concat([pending, chunk]); while (pending.length >= 4) { const size = pending.readUInt32LE(0); if (pending.length < size + 4) break;
      const message = JSON.parse(pending.subarray(4, size + 4).toString()); pending = pending.subarray(size + 4); messages.push(message);
      if (acknowledge && message.method === "initialize") socket.write(bytes({ type: "response", method: "initialize", requestId: message.requestId, resultType: "success", result: { clientId: `client-${peers.length}` } }));
    } }); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const monitor = new CodexDesktopRequestMonitor({ socketPath, reconnectDelayMs: 5, connectionTimeoutMs,
    onApproval: async () => undefined, onUserInput: async input => { questions.push(input); return undefined; } } as any);
  t.after(() => { monitor.stop(); for (const socket of peers) socket.destroy(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  monitor.followThread("thread"); monitor.start(); await until(() => messages.some(m => m.method === "initialize"));
  return { monitor: monitor as any, peers, messages, questions };
}
test("a silent Desktop handshake is bounded and reconnects the read-only observer", async t => {
  const f = await fixture(t, false, 25); await until(() => f.peers.length >= 2);
  assert.equal(f.messages.some(m => m.method === "thread-stream-following-changed"), false);
});
test("Desktop handshake ignores a response for a different request", async t => {
  const f = await fixture(t, false), request = f.messages[0];
  f.peers[0].write(bytes({ type: "response", method: "initialize", requestId: "wrong", resultType: "success", result: { clientId: "wrong-client" } }));
  await new Promise(r => setTimeout(r, 8)); assert.equal(f.monitor.clientId, undefined);
  f.peers[0].write(bytes({ type: "response", method: "initialize", requestId: request.requestId, resultType: "success", result: { clientId: "right-client" } }));
  await until(() => f.monitor.clientId === "right-client");
});
test("late data from a retired Desktop socket cannot change the new connection or deliver a request", async t => {
  const f = await fixture(t); await until(() => f.monitor.clientId === "client-1"); const retired = f.monitor.socket;
  f.monitor.stop(); f.monitor.start(); await until(() => f.monitor.clientId === "client-2");
  retired.emit("data", bytes({ type: "broadcast", method: "thread-stream-state-changed", params: { conversationId: "thread", change: { type: "snapshot", conversationState: { requests: [{
    id: "old-question", method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn", itemId: "item", questions: [{ id: "q", question: "Old?", header: "Old" }] }
  }] } } } }));
  await new Promise(r => setTimeout(r, 10)); assert.equal(f.questions.length, 0); assert.equal(f.monitor.clientId, "client-2");
});
