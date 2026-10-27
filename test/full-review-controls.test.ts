import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { BridgeService } from "../src/bridge/service.js";
import { NativeQueueCoordinator } from "../src/bridge/native-queue.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { channelHelpText } from "../src/bridge/channel-commands.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { sessionExecutionScope } from "../src/bridge/session-execution.js";

function temporary(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-control-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test("switching to another mode's native session and back cannot revive an old execution lease", t => {
  const root = temporary(t), store = new RuntimeStateStore(resolveStatePaths(root));
  const project = store.createProject("Project", root), session = store.createSession("room", root, "Session", project.id);
  store.setSessionThread(session.id, "thread");
  const lease = sessionExecutionScope(store, store.getSession(session.id)!);
  assert.equal(lease.current(), true);
  store.setInteractionMode("room", "qa");
  assert.equal(lease.current(), false);
  store.setInteractionMode("room", "session");
  assert.equal(lease.current(), false);
});
for (const operation of ["stop", "set-goal", "clear-goal", "delete-queue"]) {
  test(`native ${operation} rechecks its source after connecting, before mutation`, async () => {
    const wire = new AppServerCodexRunner() as any;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let allowed = true, writes = 0;
    wire.initialized = true; wire.child = { exitCode: null }; wire.activeTurns.set("thread", "turn");
    wire.ensureConnected = async () => { entered.resolve(); await release.promise; };
    wire.recyclePrivateTransportIfIdle = async () => {};
    wire.listQueuedSubmissions = async () => ({ data: [] });
    wire.request = async () => { writes++; return {}; };
    const guard = () => { if (!allowed) throw Error("source revoked"); };
    const pending = operation === "stop" ? wire.stop("thread", guard)
      : operation === "set-goal" ? wire.setGoal("thread", { status: "paused" }, guard)
      : operation === "clear-goal" ? wire.clearGoal("thread", guard)
      : wire.deleteQueuedSubmission("thread", "queue", undefined, guard);
    await entered.promise; allowed = false; release.resolve();
    await assert.rejects(pending, /source revoked/); assert.equal(writes, 0);
  });
}
for (const command of ["/stop", "/goal pause", "/goal clear"]) for (const change of ["binding", "role", "access"]) {
  test(`IM ${command} preserves its source guard when ${change} changes during native preparation`, async t => {
    const root = temporary(t), store = new RuntimeStateStore(resolveStatePaths(root));
    const project = store.createProject("Project", root), session = store.createSession("room", root, "Session", project.id);
    store.setSessionThread(session.id, "thread"); store.setPairedSenderIds(["actor"]); store.setRole("room", "actor", "controller");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let writes = 0;
    const mutation = async (...args: any[]) => {
      entered.resolve(); await release.promise;
      const guard = args.at(-1); if (typeof guard === "function") guard();
      writes++; return undefined;
    };
    const service = new BridgeService({ config: { ...defaultConfig(root), streamReplies: false }, stateStore: store,
      weixin: { async sendText() { return { messageId: "sent" }; } } as never,
      runner: { stop: mutation, setGoal: mutation, clearGoal: mutation } as never });
    const pending = service.handleMessage({ id: "source", senderId: "actor", replyTargetId: "room", text: command, raw: {} });
    await entered.promise;
    if (change === "binding") store.setSessionThread(session.id, "replacement");
    if (change === "role") store.setRole("room", "actor", "viewer");
    if (change === "access") store.setPairedSenderIds([]);
    release.resolve(); await assert.rejects(pending, /控制操作未提交/); assert.equal(writes, 0);
  });
}
test("queue cancellation rechecks authority after reading exact native queue ownership", async t => {
  const queue = new NativeQueueCoordinator(path.join(temporary(t), "queue.json"));
  const origin = { accountId: "a", conversationId: "room", actorId: "actor", messageId: "m", sessionId: "s", hostId: "local", backend: "app-server", threadId: "thread" };
  let source = "", revoked = false, deletes = 0;
  const backend = { backendInfo: () => ({ id: "app-server", capabilities: { nativeQueue: true } }),
    async addQueuedSubmission(input: any) { source = input.clientUserMessageId; return { id: "q" }; },
    async listQueuedSubmissions() { revoked = true; return { data: [{ id: "q", clientUserMessageId: source }] }; },
    async deleteQueuedSubmission() { deletes++; return true; } } as any;
  await queue.enqueue(origin, "message", backend);
  await assert.rejects(queue.cancel("a", "room", "actor", "q", backend, false, () => { if (revoked) throw Error("revoked"); }), /revoked/);
  assert.equal(deletes, 0); assert.equal(queue.list("a")[0].status, "queued");
});
test("Desktop help distinguishes guarded steering from supported native queue admission", () => {
  const help = channelHelpText([], "session", { desktopOwned: true, backendCapabilities: APP_SERVER_BACKEND_CAPABILITIES });
  assert.doesNotMatch(help.split("\n").find(line => line.startsWith("/queue"))!, /不支持/);
  assert.match(help.split("\n").find(line => line.startsWith("/steer"))!, /不支持/);
  assert.match(help.split("\n").find(line => line.startsWith("/ide identity"))!, /个人准入/);
});
test("an invalid plan argument cannot silently toggle the current mode", async t => {
  const root = temporary(t), store = new RuntimeStateStore(resolveStatePaths(root));
  const project = store.createProject("Project", root), session = store.createSession("actor", root, "Session", project.id);
  store.setSessionCollaborationMode(session.id, "plan");
  const replies: string[] = [];
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, stateStore: store,
    weixin: { async sendText(input: any) { replies.push(input.text); return { messageId: "sent" }; } } as never, runner: {} as never });
  await service.handleMessage({ id: "invalid-plan", senderId: "actor", text: "/plan unknown", raw: {} });
  assert.equal(store.getSession(session.id)?.collaborationMode, "plan"); assert.match(replies.at(-1)!, /用法/);
});
