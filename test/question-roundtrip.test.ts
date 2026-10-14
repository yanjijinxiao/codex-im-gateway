import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { IpcFrameDecoder } from "../src/codex/ipc-frames.js";
import type { CodexThreadSnapshot } from "../src/codex/backend.js";
import { CodexDesktopRequestMonitor } from "../src/server/codex-desktop-request-monitor.js";
import { ThreadEventHub } from "../src/server/thread-event-hub.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "question roundtrip fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function send(socket: net.Socket, value: unknown) {
  const payload = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length); socket.write(Buffer.concat([header, payload]));
}

for (const channel of ["dingtalk", "weixin", "feishu"] as const) for (const kind of ["async", "sync"] as const) {
  test(`${channel}/${kind}: native question → IM command → native receipt → same progress/final card, with restart deduplication`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-question-roundtrip-"));
    const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "runtime")));
    const session = store.createSession("room", root, "original task", undefined, "session", undefined, { standalone: true });
    store.setSessionThread(session.id, "thread");
    const texts: string[] = [], progress: Array<{ messageId?: string; text: string; finalize?: boolean }> = [];
    const questions: string[] = [], questionUpdates: string[] = [], generalWrites: string[] = [], nativeWrites: Array<Record<string, any>> = [];
    let starts = 0, connections = 0, answered = false;
    const client = createChannelClient(channel, { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true,
      ...(channel === "feishu" ? { actions: "available", cardUpdates: "available" } : {}) }, {
      async sendText(input) { texts.push(input.text); return { messageId: `notice-${texts.length}` }; },
      async sendActionCard(input) { questions.push(input.card.title); return { messageId: "question-card" }; },
      async updateActionCard(input) { assert.equal(input.messageId, "question-card"); questionUpdates.push(input.card.title); },
      async startTextStream(input) { starts++; progress.push(input); return { messageId: "original-task-card" }; },
      async updateTextStream(input) { assert.equal(input.messageId, "original-task-card"); progress.push(input); }
    });
    const createService = () => new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] },
      stateStore: store, channel: client, runner: {
        async run() { generalWrites.push("run"); throw new Error("must not start"); },
        async steer() { generalWrites.push("steer"); throw new Error("must not use ordinary input"); },
        async addQueuedSubmission() { generalWrites.push("queue"); throw new Error("must not enqueue"); },
        async stop() { generalWrites.push("stop"); throw new Error("must not interrupt"); }
      } as never });
    let service = createService();
    let snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "active",
      activeTurnId: "turn", activeFlags: [] }, turns: [{ id: "turn", status: "inProgress",
      messages: [{ id: "before", role: "assistant", kind: "progress", text: "等待前的公开进展" }] }] };
    const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), subscriptions: () => [{
      key: "binding", hostId: "local", threadId: "thread", recipientId: "room", managed: false, client }],
      backend: () => ({ async readThreadSnapshot() { return snapshot; } }) });
    let peer!: net.Socket;
    const sockets = new Set<net.Socket>();
    const wireState = () => ({ requests: kind === "sync" && !answered ? [{ id: 42, method: "item/tool/requestUserInput",
      params: { threadId: "thread", turnId: "turn", itemId: "native-question", autoResolutionMs: null,
        questions: [{ id: "sync-question", header: "问题", question: "继续执行吗？", options: [{ label: "继续", description: "继续原任务" }] }] } }] : [],
      threadRuntimeStatus: { type: "active" }, turns: [{ turnId: "turn", status: "inProgress", items: kind === "async" ? [
        { type: "agentMessage", id: "native-question", questions: [{ title: "继续执行吗？", options: ["继续"] }] },
        ...(answered ? [{ type: "steeringUserMessage", status: "accepted", input: nativeWrites[0].params.input }] : [])
      ] : [] }] });
    const broadcast = () => send(peer, { type: "broadcast", method: "thread-stream-state-changed", version: 11,
      params: { conversationId: "thread", hostId: "local", change: { type: "snapshot", conversationState: wireState() } } });
    const server = net.createServer(socket => {
      peer = socket; sockets.add(socket); socket.on("close", () => sockets.delete(socket));
      const frames = new IpcFrameDecoder(1024 * 1024);
      socket.on("data", chunk => frames.push(chunk, payload => {
        const message = JSON.parse(payload.toString());
        if (message.method === "initialize") {
          connections++; send(socket, { type: "response", method: "initialize", requestId: message.requestId, resultType: "success", result: { clientId: "test" } });
        } else if (message.method === "thread-stream-following-changed" && message.params.following) broadcast();
        else if (message.type === "request") {
          assert.equal(message.method, kind === "async" ? "thread-follower-steer-turn" : "thread-follower-submit-user-input");
          nativeWrites.push(message); answered = true;
          if (kind === "async") {
            const text = message.params.input[0].text;
            assert.match(text, /^<send_user_message_question_reply>/);
            assert.deepEqual(JSON.parse(text.split("\n")[1]), [{ questionItemId: '["request_user_input_async","native-question",0]',
              question: "继续执行吗？", answer: "继续" }]);
          } else assert.deepEqual(message.params.response, { answers: { "sync-question": { answers: ["继续"] } } });
          send(socket, { type: "response", requestId: message.requestId, method: message.method, resultType: "success",
            result: kind === "async" ? { result: { turnId: "turn" } } : { ok: true } });
          broadcast();
        }
      }));
    });
    const socketPath = path.join(root, "ipc.sock");
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    const createMonitor = () => new CodexDesktopRequestMonitor({ socketPath, decisionTimeoutMs: 500,
      onApproval: async () => { throw new Error("question is not approval"); },
      onUserInput: input => service.requestUserInput("room", input.request),
      onUserInputResult: (input, result) => service.reportUserInputResult("room", input.request, result),
      onObservedUserInputAnswers: receipts => service.observeNativeUserInputAnswers(receipts) });
    let monitor = createMonitor();
    t.after(async () => {
      monitor.stop(); service.suspendUserInputs(); await hub.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    await hub.refresh(); monitor.followThread("thread"); monitor.start();
    await until(() => texts.some(text => text.includes("/answer Q1")) || questions.length === 1);
    snapshot.state.activeFlags = ["waitingOnUserInput"]; await hub.refresh();
    await service.handleMessage({ id: "im-answer", senderId: "actor", replyTargetId: "room", text: "/answer Q1 --option 1", raw: {} });
    await until(() => texts.some(text => text.includes("Codex 已确认")) || questionUpdates.length === 1);
    assert.equal(nativeWrites.length, 1); assert.deepEqual(generalWrites, []);
    snapshot = { state: { ...snapshot.state, activeFlags: [] }, turns: [{ id: "turn", status: "inProgress",
      messages: [{ id: "after", role: "assistant", kind: "progress", text: "回答后继续执行原任务" }] }] };
    await hub.refresh();
    await until(() => progress.some(write => write.messageId === "original-task-card" && write.text.includes("回答后继续执行原任务")));
    assert.equal(starts, 1); assert.notEqual(progress.at(-1)?.finalize, true);
    monitor.stop(); service.suspendUserInputs(); service = createService(); monitor = createMonitor();
    const noticeCount = texts.length + questions.length + questionUpdates.length;
    monitor.followThread("thread"); monitor.start(); await until(() => connections === 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(nativeWrites.length, 1); assert.equal(texts.length + questions.length + questionUpdates.length, noticeCount);
    snapshot = { state: { ...snapshot.state, runtimeStatus: "idle", activeTurnId: undefined }, turns: [{
      id: "turn", status: "completed", messages: [{ id: "final", role: "assistant", text: "原任务最终答复" }] }] };
    await hub.refresh(); assert.equal(starts, 1); assert.equal(progress.at(-1)?.messageId, "original-task-card");
    assert.equal(progress.at(-1)?.finalize, true); assert.equal(progress.at(-1)?.text, "原任务最终答复");
    assert.deepEqual(generalWrites, []);
  });
}
