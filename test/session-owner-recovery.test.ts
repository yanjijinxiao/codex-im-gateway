import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexRunnerInput, type CodexThreadState } from "../src/codex/backend.js";
import { DesktopCodexRunner } from "../src/codex/desktop-runner.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { ThreadEventHub } from "../src/server/thread-event-hub.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-owner-recovery-"));
  fs.mkdirSync(path.join(root, "sessions"));
  const socketPath = path.join(root, "ipc.sock");
  let discoveryError: string | undefined = "no-client-found";
  let startError: string | undefined;
  const methods: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const m = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        methods.push(m.method);
        const send = (message: object) => {
          const payload = Buffer.from(JSON.stringify(message));
          const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
          socket.write(Buffer.concat([header, payload]));
        };
        const reply = (result: unknown, error?: string) => send({ type: "response", requestId: m.requestId,
          ...(error ? { resultType: "error", error } : { resultType: "success", result }) });
        if (m.method === "initialize") reply({ clientId: "recovery-reader" });
        if (m.method === "thread-owner-discovery" && discoveryError !== "__timeout__") reply({}, discoveryError);
        if (m.method === "thread-stream-following-changed") send({ type: "broadcast", method: "thread-stream-state-changed",
          params: { conversationId: "original-thread", change: { type: "snapshot",
            conversationState: { threadRuntimeStatus: { type: "idle" }, cwd: root, turns: [] } } } });
        if (m.method === "thread-follower-start-turn") reply({}, startError);
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  const desktop = new DesktopCodexRunner({ socketPath, codexHome: root, timeoutMs: 300 });
  const state: CodexThreadState = { threadId: "original-thread", persistence: "active", runtimeStatus: "notLoaded",
    activeFlags: [], cwd: root, title: "Original session" };
  const runs: CodexRunnerInput[] = [];
  let lockFailures = 0;
  const app = {
    id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES,
    async inspectThread() { return { ...state }; },
    async readThreadSnapshot() { return { state: { ...state }, turns: [] }; },
    async getHistoryPage() { return { messages: [] }; },
    async getRuntimeInfo() { return {}; },
    async run(input: CodexRunnerInput) {
      runs.push(input);
      assert.equal(input.threadId, "original-thread", "must resume the existing thread, never create another");
      if (lockFailures-- > 0) throw new Error("thread already has an active writer");
      await input.onTurnStarted?.({ threadId: input.threadId, turnId: "continued-turn" });
      return { threadId: input.threadId, turnId: "continued-turn", text: "continued the original session", raw: "" };
    },
    close() {}
  };
  const router = new CodexBackendRouter({ backend: "app-server", codexHome: root,
    appServerBackend: app as never, execBackend: { close() {} } as never, desktopRunner: desktop });
  t.after(async () => {
    await router.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, desktop, router, runs, methods, state,
    ownerError(value: string | undefined) { discoveryError = value; },
    startError(value: string) { startError = value; },
    lockFailures(value: number) { lockFailures = value; } };
}

test("no-client-found is a missing live owner, not a lost binding or a fatal backend error", async t => {
  const f = await fixture(t);
  assert.equal(await f.desktop.readThreadSnapshot("original-thread"), undefined);
  assert.equal((await f.router.inspectThread("original-thread")).runtimeStatus, "notLoaded");
  assert.equal((await f.router.readThreadSnapshot("original-thread")).state.persistence, "active");
  assert.equal(f.runs.length, 0);
  assert.ok(!f.methods.includes("thread-follower-start-turn"));
});

for (const channel of ["dingtalk", "weixin", "feishu"] as const) {
  test(`${channel}: a persisted unloaded binding survives sync and ordinary messages continue the same session`, async t => {
    const f = await fixture(t);
    const paths = resolveStatePaths(path.join(f.root, "gateway"));
    const before = new RuntimeStateStore(paths);
    const session = before.createSession("group", f.root, "Original session", undefined, "session", undefined,
      { standalone: true, hostId: "local" });
    before.setSessionThread(session.id, "original-thread");
    before.setSessionFollow(session.id, true);
    const store = new RuntimeStateStore(paths); // Gateway restart must retain the exact binding.
    const texts: string[] = [];
    const client = createChannelClient(channel, TEXT_CAPABILITIES, {
      async sendText(input) { texts.push(input.text); return { messageId: String(texts.length) }; }
    });
    const hub = new ThreadEventHub({ filePath: path.join(f.root, "follow.json"), backend: () => f.router,
      subscriptions: () => [{ key: session.id, hostId: "local", threadId: "original-thread", recipientId: "group", client, managed: false }] });
    t.after(() => hub.stop());
    const bridge = new BridgeService({ stateStore: store,
      config: { ...defaultConfig(f.root), allowedSenderIds: ["actor"], streamReplies: false },
      channel: client, runner: f.router,
      sessionFollow: { status: () => hub.status(session.id), synchronize: () => hub.synchronize(session.id) }
    });
    let sequence = 0;
    const send = (text: string) => bridge.handleMessage({ id: String(++sequence), senderId: "actor",
      replyTargetId: "group", text, raw: {}, attachments: [] });
    await send("/follow sync");
    assert.equal(hub.status(session.id).status, "unconfirmed", "a storage snapshot is not a confirmed live writer");
    assert.equal(f.runs.length, 0, "sync cannot load, resume or start a turn");
    assert.equal(store.getActiveSession("group")?.id, session.id);
    await send("Continue this existing session");
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].hostId, "local");
    assert.equal(f.runs[0].cwd, f.root);
    assert.equal(store.getActiveSession("group")?.id, session.id);
    assert.equal(store.getActiveSession("group")?.threadId, "original-thread");
    assert.equal(store.getActiveSession("group")?.follow, true);
    assert.ok(texts.includes("continued the original session"));
    assert.ok(!f.methods.includes("thread-follower-start-turn"));
    f.ownerError(undefined);
    await hub.refresh();
    assert.equal(hub.status(session.id).status, "synced", "the retained subscription recovers when a live owner reappears");
    assert.equal(f.runs.length, 1, "background recovery is read-only");
    await send("/session original-thread --host local");
    assert.equal(store.getActiveSession("group")?.id, session.id, "reselection reuses the same binding");
    assert.equal(f.runs.length, 1);
  });
}

test("a vanished cached Desktop owner resumes the same thread through the guarded app-server", async t => {
  const f = await fixture(t);
  f.ownerError(undefined);
  assert.equal((await f.router.inspectThread("original-thread")).executionOwner, "desktop");
  f.ownerError("no-client-found");
  const result = await f.router.run({ threadId: "original-thread", cwd: f.root, prompt: "ordinary message" });
  assert.equal(result.threadId, "original-thread");
  assert.equal(f.runs.length, 1);
  assert.ok(!f.methods.includes("thread-follower-start-turn"));
});

test("a writer that disappears after resume-lock rejection permits one guarded retry, not a new thread", async t => {
  const f = await fixture(t);
  f.lockFailures(1);
  const result = await f.router.run({ threadId: "original-thread", cwd: f.root, prompt: "ordinary message" });
  assert.equal(result.threadId, "original-thread");
  assert.equal(f.runs.length, 2);
  assert.ok(!f.methods.includes("thread-follower-start-turn"));
});

test("a persistent writer conflict stops recovery without looping or changing the binding", async t => {
  const f = await fixture(t);
  f.lockFailures(10);
  await assert.rejects(f.router.run({ threadId: "original-thread", cwd: f.root, prompt: "ordinary" }), /active writer/);
  assert.equal(f.runs.length, 2);
});

test("permission failures in discovery remain failures, never absence or resume permission", async t => {
  const f = await fixture(t);
  f.ownerError("forbidden private-token=NEVER_EXPOSE");
  await assert.rejects(f.router.inspectThread("original-thread"), /forbidden/);
  assert.equal(f.runs.length, 0);
});

test("failure after submission is never retried even if it says no-client-found", async t => {
  const f = await fixture(t);
  f.ownerError(undefined);
  await f.router.inspectThread("original-thread");
  f.startError("no-client-found");
  await assert.rejects(f.router.run({ threadId: "original-thread", cwd: f.root, prompt: "ordinary" }), /start-turn failed/);
  assert.equal(f.methods.filter(method => method === "thread-follower-start-turn").length, 1);
  assert.equal(f.runs.length, 0);
});

test("an ambiguous accepted response without a turn id must not resume or resend", async t => {
  const f = await fixture(t);
  f.ownerError(undefined);
  await f.router.inspectThread("original-thread");
  await assert.rejects(f.router.run({ threadId: "original-thread", cwd: f.root, prompt: "ordinary" }),
    error => error instanceof CodexCommunicationError && error.code === "invalid-receipt" && error.submission === "unconfirmed");
  assert.equal(f.methods.filter(method => method === "thread-follower-start-turn").length, 1);
  assert.equal(f.runs.length, 0);
});

test("a cached owner's discovery timeout is uncertain and cannot authorize resubmission", async t => {
  const f = await fixture(t);
  f.ownerError(undefined);
  await f.router.inspectThread("original-thread");
  f.ownerError("__timeout__");
  await assert.rejects(f.router.run({ threadId: "original-thread", cwd: f.root, prompt: "ordinary" }),
    error => error instanceof CodexCommunicationError && error.code === "timeout" && error.submission === "not-submitted");
  assert.ok(!f.methods.includes("thread-follower-start-turn"));
  assert.equal(f.runs.length, 0);
});
