import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncFeishuShortcutMenu } from "../src/channels/feishu-menu-sync.js";
import { CliSessionStore } from "../src/codex/cli-sessions.js";
import { AppServerCodexRunner, parseThreadHistory } from "../src/codex/app-server-runner.js";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import type { DWClientDownStream } from "dingtalk-stream";
import { CodexCommunicationError } from "../src/codex/communication-error.js";

test("a busy retry with an unconfirmed receipt keeps its subscription and approval owner", async () => {
  const wire = new AppServerCodexRunner() as any;
  wire.ensureConnected = async () => {}; wire.waitForThreadIdle = async () => {};
  wire.inspectThread = async () => ({ threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] });
  wire.recyclePrivateTransportIfIdle = async () => {};
  const failure = new CodexCommunicationError("submission", "turn/start", "thread", undefined, Error("timeout"));
  let starts = 0, unsubscribes = 0;
  wire.request = async (method: string) => {
    if (method === "thread/resume") return { thread: { id: "thread" } };
    if (method === "thread/unsubscribe") { unsubscribes++; return {}; }
    if (++starts === 1) throw Error("thread busy");
    throw failure;
  };
  const handler = async () => "decline" as const;
  await assert.rejects(wire.run({ threadId: "thread", cwd: "/tmp/project", prompt: "test", onApproval: handler }), failure);
  assert.equal(starts, 2); assert.equal(unsubscribes, 0);
  assert.equal(wire.unconfirmedStarts.has("thread"), true);
  assert.equal(wire.approvalHandlersByThread.get("thread"), handler);
});

test("explicit native project identity wins over shared roots and earlier resolver calls", async () => {
  const wire = new AppServerCodexRunner() as any;
  wire.requestProjects = async () => [{ id: "first", roots: ["/shared"] }, { id: "selected", roots: ["/shared"] }];
  assert.equal(await wire.resolveProjectId("/shared", "selected"), "selected");
  assert.equal(await wire.resolveProjectId("/shared", "first"), "first");
  await assert.rejects(wire.resolveProjectId("/shared"), /多个|ambiguous/i);
});
test("missing thread reads cannot become confirmed missing when a catalog query fails", async () => {
  const wire = new AppServerCodexRunner() as any;
  wire.ensureConnected = async () => {};
  wire.recyclePrivateTransportIfIdle = async () => {};
  wire.request = async (method: string, params: any) => {
    if (method === "thread/read") throw Error("thread not found");
    if (params.archived) throw Error("catalog temporarily unavailable");
    return { data: [] };
  };
  await assert.rejects(wire.inspectThread("thread"), /catalog temporarily unavailable/);
  assert.notEqual(wire.threadStates.get("thread")?.persistence, "missing");
});
test("synchronous native interaction callback failures are contained at the protocol boundary", async () => {
  const wire = new AppServerCodexRunner() as any, sent: any[] = [];
  wire.send = (message: unknown) => sent.push(message);
  wire.dynamicToolHandlersByThread.set("thread", () => { throw Error("tool callback failure"); });
  assert.doesNotThrow(() => wire.handleDynamicToolRequest(1, { callId: "call", threadId: "thread", turnId: "turn", tool: "test" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1); assert.equal(sent[0].result.success, false);
  wire.userInputRequests.set("key", { request: {}, notify() { throw Error("notice failure"); } });
  assert.doesNotThrow(() => wire.resolveUserInput("key", "failed"));
  await new Promise(resolve => setImmediate(resolve));
});
test("a dynamic tool result from an old transport cannot be sent to its replacement", async () => {
  const wire = new AppServerCodexRunner() as any, gate = Promise.withResolvers<string>(), sent: any[] = [];
  wire.child = {}; wire.send = (message: unknown) => sent.push(message);
  wire.dynamicToolHandlersByThread.set("thread", () => gate.promise);
  wire.handleDynamicToolRequest(1, { callId: "call", threadId: "thread", turnId: "turn", tool: "test" });
  await Promise.resolve();
  wire.child = {}; gate.resolve("old response");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);
});
test("an obsolete native interaction is not delivered after its pending microtask loses ownership", async () => {
  const wire = new AppServerCodexRunner() as any; let calls = 0;
  wire.child = {}; wire.send = () => {};
  wire.dynamicToolHandlersByThread.set("thread", () => { calls++; return "done"; });
  wire.handleDynamicToolRequest(1, { callId: "call", threadId: "thread", turnId: "turn", tool: "test" });
  wire.child = {};
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
});
test("a failed dynamic tool response write is contained without a second uncertain write", async () => {
  const wire = new AppServerCodexRunner() as any; let writes = 0;
  wire.child = {}; wire.send = () => { writes++; throw Error("closed write stream"); };
  wire.dynamicToolHandlersByThread.set("thread", async () => "done");
  wire.handleDynamicToolRequest(1, { callId: "call", threadId: "thread", turnId: "turn", tool: "test" });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(writes, 1);
});

test("valid JSON without a protocol object cannot crash the app-server reader", () => {
  const runner = new AppServerCodexRunner({ metadataOnly: true });
  const wire = runner as unknown as { handleMessage(raw: string): void };
  for (const value of [null, [], 1, "text", { method: 1 }, { method: "turn/completed", params: null }])
    assert.doesNotThrow(() => wire.handleMessage(JSON.stringify(value)));
});
test("malformed optional history rows and out-of-range dates cannot hide valid later history", () => {
  const result = parseThreadHistory({ turns: [null, false, { id: "turn", startedAt: 1e100,
    items: [null, { type: "userMessage", content: [null, { type: "text", text: "hello" }] },
      { type: "agentMessage", text: "answer" }] }] });
  assert.deepEqual(result.map(m => m.text), ["hello", "answer"]);
  assert.ok(result.every(m => m.createdAt === undefined));
});
test("a delayed old terminal event cannot clear a newer turn's runtime or interaction handlers", () => {
  const runner = new AppServerCodexRunner();
  const wire = runner as any, handler = () => {};
  wire.activeTurns.set("thread", "new");
  const state = { threadId: "thread", persistence: "active", runtimeStatus: "active", activeFlags: [], activeTurnId: "new" };
  wire.threadStates.set("thread", state);
  for (const field of ["approvalHandlersByThread", "dynamicToolHandlersByThread", "userInputHandlersByThread", "userInputResultHandlersByThread"])
    wire[field].set("thread", handler);
  wire.handleMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "old", status: "interrupted" } } }));
  assert.equal(wire.activeTurns.get("thread"), "new");
  assert.deepEqual(wire.threadStates.get("thread"), state);
  for (const field of ["approvalHandlersByThread", "dynamicToolHandlersByThread", "userInputHandlersByThread", "userInputResultHandlersByThread"])
    assert.equal(wire[field].get("thread"), handler);
});
test("DingTalk rejects malformed payload shapes before routing or claiming, without throwing out of its listener", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-review-protocol-"));
  const controller = new AbortController(); let listener!: (frame: DWClientDownStream) => void, claims = 0;
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "a", clientId: "robot", clientSecret: "test", enabled: true, savedAt: "" }, {
    inboundDir: root, streamClient: { registerCallbackListener(_topic, handle) { listener = handle; },
      async connect() {}, disconnect() {}, off() {}, socketCallBackResponse() {}, async getAccessToken() { return "test"; } },
    emotionClient: { async reply() {}, async recall() {} }
  });
  const monitor = adapter.monitor({ signal: controller.signal, claimMessage() { claims++; return true; }, async onMessage() { throw Error("must not submit"); } });
  t.after(async () => { controller.abort(); await monitor; fs.rmSync(root, { recursive: true, force: true }); });
  const valid = { senderStaffId: "actor", conversationId: "group", conversationType: "2", sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=test", msgId: "m", msgtype: "text", text: { content: "hello" } };
  for (const value of [null, [], "text", { ...valid, senderStaffId: 1 }, { ...valid, conversationId: {} }, { ...valid, msgId: [] }])
    assert.doesNotThrow(() => listener({ data: JSON.stringify(value), headers: { messageId: "frame" } } as DWClientDownStream));
  assert.equal(claims, 0);
});

for (const receipt of [{}, undefined, { code: "0" }]) test(`Feishu menu mutation needs explicit business acknowledgement (${JSON.stringify(receipt)})`, async () => {
  let published = false;
  const client = { application: { v6: { application: { async get() { return { code: 0, data: { app: { create_source: "developer_console" } } }; } } },
    v7: { applicationConfig: { async patch() { return receipt; } }, applicationAbility: { async patch() { return { code: 0 }; } },
      applicationPublish: { async create() { published = true; return { code: 0 }; } } } } };
  await assert.rejects(syncFeishuShortcutMenu({ appId: "synthetic", appSecret: "synthetic" } as never, { client: client as never }));
  assert.equal(published, false);
});

test("missing native runtime evidence remains unknown rather than an invented idle state", async () => {
  const runner = new AppServerCodexRunner() as any;
  runner.ensureConnected = async () => {}; runner.request = async () => ({ thread: { id: "thread", turns: [] } });
  runner.sessionMembership = () => (state: unknown) => state;
  assert.equal((await runner.inspectThread("thread")).runtimeStatus, "unknown");
});

test("malformed CLI rollout rows cannot hide valid public messages later in the file", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-malformed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(root, "sessions"));
  const records = [{ type: "session_meta", payload: { id: "thread", source: "cli", cwd: root } }, null, false, [],
    { type: "response_item", payload: { type: "message", role: "assistant", content: [null, { type: "output_text", text: "valid answer" }] } }];
  fs.writeFileSync(path.join(root, "sessions", "thread.jsonl"), records.map(row => JSON.stringify(row)).join("\n") + "\n");
  const result = await new CliSessionStore(root).snapshot("thread");
  assert.equal(result.turns[0].messages[0].text, "valid answer");
});
