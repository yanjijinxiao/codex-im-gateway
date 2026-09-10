import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChannelAdapter } from "../src/channels/factory.js";
import { createChannelClient, TEXT_CAPABILITIES, validateLocalAttachments } from "../src/channels/client.js";
import { ChannelCapabilityError, ChannelDeliveryError, ChannelPartialDeliveryError, InboundMediaTooLargeError } from "../src/channels/errors.js";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import { FeishuCardUpdater } from "../src/channels/feishu-card-updater.js";
import { WeComChannelAdapter } from "../src/channels/wecom.js";
import { WeixinChannelAdapter } from "../src/channels/weixin.js";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import { createChoiceCard } from "../src/channels/action-card.js";
import type { ChannelAccount } from "../src/weixin/accounts.js";
import type { ChannelConnectionStatus } from "../src/channels/types.js";
import type { ChannelMessage } from "../src/channels/message.js";
import { buildPromptParts, buildPrompt, parsePrompt } from "../src/bridge/format.js";
import { ChannelTurnTextStream, BridgeService } from "../src/bridge/service.js";
import { TextProgressBatcher } from "../src/channels/text-progress.js";
import { AccountManager } from "../src/server/account-manager.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { saveAccount } from "../src/weixin/accounts.js";

const accounts: ChannelAccount[] = [
  { channel: "weixin", accountId: "wx", token: "fake", baseUrl: "https://example.invalid", cdnBaseUrl: "https://example.invalid", savedAt: "", enabled: true },
  { channel: "dingtalk", accountId: "dt", clientId: "fake", clientSecret: "fake", savedAt: "", enabled: true },
  { channel: "feishu", accountId: "fs", appId: "fake", appSecret: "fake", savedAt: "", enabled: true },
  { channel: "wecom", accountId: "wc", botId: "fake", secret: "fake", savedAt: "", enabled: true }
];
const card = createChoiceCard({ title: "会话", body: "选择会话", fallbackText: "选择会话\n\n/session R1", choices: [] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const account of accounts) {
  test(`${account.channel}: factory implements the complete channel contract with explicit capability states`, async () => {
    const adapter = createChannelAdapter(account, { inboundDir: "/tmp", maxInboundBytes: 1024 });
    const client = adapter.client;
    assert.equal(client.channel, account.channel);
    for (const method of ["sendText", "sendMedia", "resolveAttachments", "startTextStream", "updateTextStream", "sendActionCard", "updateActionCard", "sendTaskCard", "updateTaskCard", "sendTyping"] as const) {
      assert.equal(typeof client[method], "function", method);
    }
    assert.equal(client.capabilities.progress, account.channel === "dingtalk" ? "not-configured" : "not-implemented");
    await assert.rejects(async () => client.sendMedia({ toUserId: "test", kind: "audio", path: "/nonexistent" }), ChannelCapabilityError);
    await assert.rejects(async () => client.startTextStream({ toUserId: "test", text: "progress" }), ChannelCapabilityError);
  });
}

function fakeAdapters() {
  const writes: string[] = [];
  const text = async ({ text }: { text: string }) => { writes.push(text); return { messageId: "ack" }; };
  const wx = new WeixinChannelAdapter(accounts[0] as never, { inboundDir: "/tmp", maxInboundBytes: 1024,
    apiClient: { sendText: text, async sendTyping() {} } as never });
  const dt = new DingTalkChannelAdapter({ ...accounts[1], cardTemplateId: "fake-template" } as never, {
    streamClient: { async getAccessToken() { return "fake"; } } as never,
    cardClient: { async create(input) { writes.push(input.text); }, async update() {} }
  });
  const fs = new FeishuChannelAdapter(accounts[2] as never, {
    apiClient: { im: { v1: { message: { async create(input) { writes.push(JSON.parse(input.data.content).text ?? input.data.content); return { code: 0, data: { message_id: "ack" } }; } } } } } as never,
    wsClient: { async start() {}, close() {} }
  });
  const wc = new WeComChannelAdapter(accounts[3] as never, { wsClient: {
    async sendMessage(_id: string, input: { markdown: { content: string } }) { writes.push(input.markdown.content); return { headers: { req_id: "ack" } }; }
  } as never });
  return { adapters: [wx, dt, fs, wc], writes };
}

test("all real adapters acknowledge text and deliver choices natively or via the same text fallback", async () => {
  const { adapters, writes } = fakeAdapters();
  for (const adapter of adapters) {
    assert.ok((await adapter.client.sendText({ toUserId: "user", text: "hello" })).messageId);
    assert.ok((await adapter.client.sendActionCard({ toUserId: "user", card })).messageId);
  }
  assert.equal(writes.filter((text) => text === "hello").length, 4);
  assert.equal(writes.filter((text) => text === card.fallbackText).length, 3);
});

test("generic client rejects missing acknowledgements instead of inventing message IDs", async () => {
  const client = createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return {} as never; } });
  await assert.rejects(client.sendText({ toUserId: "chat", text: "hello" }), ChannelDeliveryError);
});

test("multi-part fallback exposes actual receipts and preserves acknowledged parts on failure", async () => {
  const sent: Array<{ text: string; contextToken?: string }> = [];
  let fail = false;
  const client = createChannelClient("generic", TEXT_CAPABILITIES, { async sendText(input) {
    if (fail && sent.length === 1) throw new Error("temporary failure");
    sent.push(input); return { messageId: String(sent.length) };
  } });
  const longCard = { ...card, fallbackText: "line\n".repeat(800) };
  const receipt = await client.sendActionCard({ toUserId: "user", card: longCard, contextToken: "reply-context" });
  assert.equal(receipt.parts?.length, sent.length);
  assert.ok(sent.length >= 2);
  assert.equal(receipt.parts?.at(-1)?.text, sent.at(-1)?.text);
  assert.ok(sent.every((part) => part.contextToken === "reply-context"));
  sent.length = 0; fail = true;
  await assert.rejects(client.sendActionCard({ toUserId: "user", card: longCard }), (error) => {
    assert.ok(error instanceof ChannelPartialDeliveryError);
    assert.equal(error.delivered.length, 1);
    assert.equal(error.delivered[0].messageId, "1");
    return true;
  });
  assert.equal(sent.length, 1);
});

test("Feishu business errors propagate from text, cards, image uploads and card patches", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-upload-error-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = path.join(root, "test.png"); fs.writeFileSync(image, "fake image");
  const rejected = { code: 99991400, msg: "fake permission error" };
  const adapter = new FeishuChannelAdapter(accounts[2] as never, { apiClient: { im: { v1: {
    message: { async create() { return rejected; }, async patch() { return rejected; } },
    image: { async create() { return rejected; } }
  } } } as never, wsClient: { async start() {}, close() {} } });
  await assert.rejects(adapter.client.sendText({ toUserId: "user", text: "hello" }), ChannelDeliveryError);
  await assert.rejects(adapter.client.sendActionCard({ toUserId: "user", card }), ChannelDeliveryError);
  await assert.rejects(adapter.client.sendMedia({ toUserId: "user", kind: "image", path: image }), ChannelDeliveryError);
  await assert.rejects(new FeishuCardUpdater(async () => rejected).update("card", {} as never), ChannelDeliveryError);
});

test("Weixin adapter owns polling checkpoints and forwards connection health", async () => {
  const statuses: string[] = [];
  const checkpoints: string[] = [];
  const messages: ChannelMessage[] = [];
  const controller = new AbortController();
  const adapter = new WeixinChannelAdapter(accounts[0] as never, {
    inboundDir: "/tmp", maxInboundBytes: 1024, apiClient: {
      async getUpdates(checkpoint: string) {
        assert.equal(checkpoint, "old");
        return { get_updates_buf: "new", msgs: [{ message_id: "one", from_user_id: "human", text: "hello" }] };
      }, async sendText() { return { messageId: "ack" }; }
    } as never
  });
  await adapter.monitor({ checkpoint: "old", signal: controller.signal,
    onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
    onStatus: (status) => statuses.push(status.state),
    async onMessage(message) { messages.push(message); controller.abort(); }
  });
  assert.deepEqual(checkpoints, ["new"]);
  assert.deepEqual(statuses, ["connecting", "connected", "stopped"]);
  assert.equal(messages[0].senderId, "human");
});

test("Feishu unsupported input is normalized rather than silently ignored, and SDK start failures close the socket", async () => {
  let dispatcher: { handles: Map<string, (event: unknown) => Promise<unknown>> };
  let closed = 0;
  const adapter = new FeishuChannelAdapter(accounts[2] as never, { apiClient: { im: { v1: { message: {} } } } as never,
    wsClient: { async start(input) { dispatcher = input.eventDispatcher as never; }, close() { closed++; } } });
  const controller = new AbortController();
  const messages: ChannelMessage[] = [];
  const monitor = adapter.monitor({ signal: controller.signal, async onMessage(message) { messages.push(message); } });
  await tick();
  await dispatcher!.handles.get("im.message.receive_v1")!({ sender: { sender_id: { open_id: "human" } },
    message: { message_id: "file-one", chat_id: "oc_group", message_type: "file", content: "{}" } });
  controller.abort(); await monitor;
  assert.equal(messages[0].unsupportedMessageType, "file");
  assert.equal(messages[0].senderId, "human");
  assert.equal(messages[0].replyTargetId, "oc_group");
  assert.equal(closed, 1);
  const failure = new FeishuChannelAdapter(accounts[2] as never, { apiClient: { im: { v1: { message: {} } } } as never,
    wsClient: { async start() { throw new Error("fake connection error"); }, close() { closed++; } } });
  await assert.rejects(failure.monitor({ async onMessage() {} }), /fake connection error/);
  assert.equal(closed, 2);
});

test("Gateway commands and execution work identically with every IM client, with correctly labeled prompts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-gateway-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const { client } of fakeAdapters().adapters) {
    const store = new RuntimeStateStore(resolveStatePaths(path.join(root, client.channel)));
    store.createProject("same project", root);
    let prompt = "";
    const service = new BridgeService({ channel: client, stateStore: store,
      config: { ...defaultConfig(root), allowedSenderIds: ["user"], streamReplies: false },
      runner: { async run(input) { assert.equal(input.cwd, root); prompt = input.developerInstructions; return { text: "done", raw: "" }; }, async stop() {} } as never
    });
    await service.handleMessage({ id: "help", senderId: "user", text: "/help", attachments: [], raw: {} });
    await service.handleMessage({ id: "hi", senderId: "user", text: "hi", attachments: [], raw: {} });
    assert.match(prompt, new RegExp({ weixin: "WeChat", dingtalk: "DingTalk", feishu: "Feishu", wecom: "WeCom" }[client.channel]!));
    if (client.channel !== "weixin") assert.equal(prompt.includes("this WeChat account"), false);
  }
});

test("new channel prompt labels round-trip while keeping historical WeChat prompts readable", () => {
  for (const source of ["WeChat", "DingTalk", "Feishu", "WeCom", "IM"] as const) {
    const parts = buildPromptParts("hello", [{ kind: "image", path: "/tmp/test.png", label: "test.png" }], source);
    assert.match(parts.prompt, new RegExp(source));
    if (source !== "WeChat") assert.equal(parts.developerInstructions.includes("WeChat"), false);
    assert.equal(parsePrompt(buildPrompt("hello", [], source)).text, "hello");
    assert.equal(parsePrompt(parts.prompt).attachments[0].source, source);
  }
});

test("attachment boundary rejects symlink escapes and oversized files for every channel", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-attachment-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inbound = path.join(root, "inbound"); fs.mkdirSync(inbound);
  fs.writeFileSync(path.join(root, "outside"), "outside");
  fs.symlinkSync(path.join(root, "outside"), path.join(inbound, "escape"));
  fs.writeFileSync(path.join(inbound, "large"), "1234567890");
  const image = (name: string) => [{ kind: "image" as const, label: name, path: path.join(inbound, name), item: {} }];
  assert.throws(() => validateLocalAttachments(image("escape"), inbound, 20), /outside/);
  assert.throws(() => validateLocalAttachments(image("large"), inbound, 3), InboundMediaTooLargeError);
});

test("text-only progress coalesces bursts and cannot send after the final answer", async () => {
  const writes: string[] = [];
  const batch = new TextProgressBatcher(async (text) => { writes.push(text); }, 10);
  await batch.push("first");
  for (let i = 0; i < 100; i++) await batch.push(`progress ${i}`);
  assert.equal(writes.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes.length, 2);
  assert.match(writes[1], /progress 99/);
  assert.ok(writes[1].length < 1500);
  await batch.push("late");
  await batch.close();
  writes.push("FINAL");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes.at(-1), "FINAL");
});

test("each channel uses the same progress lifecycle, preserving the error terminal flag", async () => {
  for (const { client } of fakeAdapters().adapters) {
    const stream = new ChannelTurnTextStream(client, "user");
    await stream.progress("public progress");
    await stream.fail("execution failed");
    await stream.suspend();
  }
  const frames: object[] = [];
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, progress: "available" }, {
    async sendText() { return { messageId: "text" }; },
    async startTextStream() { return { messageId: "card" }; },
    async updateTextStream(input) { frames.push(input); }
  });
  const stream = new ChannelTurnTextStream(client, "user");
  await stream.progress("public progress");
  await stream.fail("failed");
  assert.deepEqual(frames.at(-1), { toUserId: "user", messageId: "card", text: "failed", finalize: true, error: true });
  await stream.progress("late progress");
  assert.equal(frames.length, 1);
});

test("WeCom group actor identity stays separate from the reply target and monitor listeners are removed", async () => {
  const socket = new EventEmitter() as EventEmitter & { connect(): void; disconnect(): void };
  socket.connect = () => { socket.emit("authenticated"); };
  socket.disconnect = () => {};
  const adapter = new WeComChannelAdapter(accounts[3] as never, { wsClient: socket as never });
  const controller = new AbortController();
  const messages: ChannelMessage[] = [];
  const states: string[] = [];
  const seen = new Set<string>();
  const monitor = adapter.monitor({ signal: controller.signal,
    onStatus: (state) => states.push(state.state),
    claimMessage: (message) => { if (seen.has(message.id)) return false; seen.add(message.id); return true; },
    async onMessage(message) { messages.push(message); }
  });
  const frame = { body: { msgid: "one", chatid: "group", from: { userid: "human" }, text: { content: "hi" } } };
  socket.emit("message.text", frame); socket.emit("message.text", frame);
  socket.emit("reconnecting"); socket.emit("authenticated");
  controller.abort(); await monitor;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderId, "human");
  assert.equal(messages[0].replyTargetId, "group");
  assert.deepEqual(states, ["connecting", "connected", "reconnecting", "connected", "stopped"]);
  assert.equal(socket.listenerCount("message.text"), 0);
});

test("account startup waits for channel readiness and exposes capabilities without credentials", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-health-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root); saveAccount(paths, accounts[1]);
  let update: ((status: ChannelConnectionStatus) => void) | undefined;
  const manager = new AccountManager({ paths, configProvider: () => defaultConfig(root),
    runnerFactory: () => ({ close() {}, async warmUp() {} }) as never,
    bridgeFactory: () => ({}) as never,
    adapterFactory: () => ({ client: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText() { return { messageId: "ok" }; } }),
      async monitor(options) { update = options.onStatus; update?.({ state: "connecting" });
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true })); }
    })
  });
  assert.equal((await manager.startAccount("dt", false)).status, "starting");
  update?.({ state: "connected" });
  assert.equal(manager.listAccounts()[0].status, "running");
  update?.({ state: "reconnecting" });
  assert.equal(manager.listAccounts()[0].connection?.state, "reconnecting");
  assert.equal(manager.listAccounts()[0].status, "starting");
  const summary = manager.listAccounts()[0];
  assert.ok(summary.capabilities);
  assert.equal("clientSecret" in summary, false);
  await manager.stopAccount("dt", false);
  assert.equal(manager.listAccounts()[0].connection?.state, "stopped");
});
