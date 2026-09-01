import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TOPIC_ROBOT, type DWClientDownStream, type RobotTextMessage } from "dingtalk-stream";

import {
  DingTalkChannelAdapter,
  DingTalkHttpsAICardClient,
  DingTalkSdkAICardClient,
  assertDingTalkCardMutationSucceeded,
  dingTalkCardStateParamMap,
  dingTalkCardStreamingUpdateBody,
  normalizeDingTalkCardContent,
  normalizeDingTalkDownloadUrl,
  type DingTalkAICardClient,
  type DingTalkEmotionClient,
  type DingTalkEmotionInput,
  type DingTalkInboundMediaClient
} from "../src/channels/dingtalk.js";
import type { NormalizedWeixinMessage } from "../src/weixin/messages.js";

test("DingTalk streaming updates replace the full card content and preserve finalize state", () => {
  assert.deepEqual(dingTalkCardStreamingUpdateBody({
    outTrackId: "card-1",
    contentKey: "content",
    text: "最近进展",
    finalize: false,
    error: false,
    guid: "update-1"
  }), {
    outTrackId: "card-1",
    guid: "update-1",
    key: "content",
    content: "最近进展",
    isFull: true,
    isFinalize: false,
    isError: false
  });
  assert.deepEqual(dingTalkCardStreamingUpdateBody({
    outTrackId: "card-1",
    contentKey: "content",
    text: "处理完成",
    finalize: true,
    error: false,
    guid: "update-2"
  }), {
    outTrackId: "card-1",
    guid: "update-2",
    key: "content",
    content: "处理完成",
    isFull: true,
    isFinalize: true,
    isError: false
  });
});

test("DingTalk card content uses the streaming template newline conventions", () => {
  assert.equal(
    normalizeDingTalkCardContent("第一行\n第二行\n\n- 列表一\n- 列表二"),
    "第一行<br>第二行\n\n- 列表一\n- 列表二"
  );
  assert.equal(
    normalizeDingTalkCardContent("```text\nline 1\nline 2\n```"),
    "```text\nline 1\nline 2\n```"
  );
});

test("DingTalk production card transport matches the HTTPS REST lifecycle", async () => {
  const calls: Array<{ url: string; method?: string; body: Record<string, unknown> }> = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
  const client = new DingTalkHttpsAICardClient(request, [0], async () => undefined);
  await client.create({
    accessToken: "access-token",
    cardTemplateId: "template.schema",
    contentKey: "msgContent",
    outTrackId: "card-https",
    robotCode: "robot-code",
    target: { type: "group", conversationId: "conversation-id" },
    text: "initial"
  });
  await client.update({
    accessToken: "access-token",
    contentKey: "msgContent",
    outTrackId: "card-https",
    text: "阶段一\n继续",
    finalize: false,
    error: false
  });
  await client.update({
    accessToken: "access-token",
    contentKey: "msgContent",
    outTrackId: "card-https",
    text: "阶段二",
    finalize: false,
    error: false
  });
  await client.update({
    accessToken: "access-token",
    contentKey: "msgContent",
    outTrackId: "card-https",
    text: "完成",
    finalize: true,
    error: false
  });

  assert.deepEqual(calls.map(({ url, method }) => ({ url, method })), [
    { url: "https://api.dingtalk.com/v1.0/card/instances", method: "POST" },
    { url: "https://api.dingtalk.com/v1.0/card/instances/deliver", method: "POST" },
    { url: "https://api.dingtalk.com/v1.0/card/instances", method: "PUT" },
    { url: "https://api.dingtalk.com/v1.0/card/streaming", method: "PUT" },
    { url: "https://api.dingtalk.com/v1.0/card/streaming", method: "PUT" },
    { url: "https://api.dingtalk.com/v1.0/card/instances", method: "PUT" },
    { url: "https://api.dingtalk.com/v1.0/card/streaming", method: "PUT" },
    { url: "https://api.dingtalk.com/v1.0/card/instances", method: "PUT" }
  ]);
  assert.deepEqual(calls[0]?.body, {
    cardTemplateId: "template.schema",
    outTrackId: "card-https",
    cardData: { cardParamMap: { config: JSON.stringify({ autoLayout: true }) } },
    callbackType: "STREAM",
    imGroupOpenSpaceModel: { supportForward: true },
    imRobotOpenSpaceModel: { supportForward: true }
  });
  assert.deepEqual(calls[1]?.body, {
    outTrackId: "card-https",
    userIdType: 1,
    openSpaceId: "dtv1.card//IM_GROUP.conversation-id",
    imGroupOpenDeliverModel: { robotCode: "robot-code" }
  });
  assert.equal((calls[2]?.body.cardData as { cardParamMap?: Record<string, string> }).cardParamMap?.msgContent, "阶段一<br>继续");
  assert.equal(calls[3]?.body.key, "msgContent");
  assert.equal(calls[3]?.body.content, "阶段一<br>继续");
  assert.equal(calls[4]?.body.content, "阶段二");
  assert.equal((calls[5]?.body.cardData as { cardParamMap?: Record<string, string> }).cardParamMap?.msgContent, "阶段二");
  assert.deepEqual(calls[5]?.body.cardUpdateOptions, { updateCardDataByKey: true });
  assert.equal(calls[6]?.body.isFinalize, true);
  assert.deepEqual(calls[7]?.body.cardUpdateOptions, { updateCardDataByKey: true });
});

test("DingTalk rejects HTTP 200 card responses whose business result failed", () => {
  assert.throws(() => assertDingTalkCardMutationSucceeded("stream", {
    statusCode: 200,
    headers: { "x-acs-request-id": "request-1" },
    body: { success: false, result: false }
  }), /request-1.*success=false/);
  assert.throws(() => assertDingTalkCardMutationSucceeded("deliver", {
    statusCode: 200,
    body: { success: true, result: [{ success: false, errorMsg: "carrier rejected" }] }
  }), /carrier rejected/);
});

test("DingTalk card state snapshots use the configured content key", () => {
  assert.deepEqual(dingTalkCardStateParamMap({
    contentKey: "content",
    text: "最近进展",
    flowStatus: "2"
  }), {
    flowStatus: "2",
    content: "最近进展",
    staticMsgContent: "",
    sys_full_json_obj: JSON.stringify({ order: ["content"] }),
    config: JSON.stringify({ autoLayout: true })
  });
});

test("DingTalk serializes updates, uses ordered GUIDs, and retries a rejected business response", async () => {
  const calls: Array<{ text: string; finalize: boolean; guid: string }> = [];
  const states: Array<{ text: string; flowStatus: string; updateByKey: boolean }> = [];
  let firstAttempt = true;
  const client = new DingTalkSdkAICardClient({
    async createCardWithOptions() { return { statusCode: 200, body: { success: true, result: "ok" } }; },
    async deliverCardWithOptions() { return { statusCode: 200, body: { success: true, result: [] } }; },
    async updateCardWithOptions(request) {
      states.push({
        text: request.cardData?.cardParamMap?.content ?? "",
        flowStatus: request.cardData?.cardParamMap?.flowStatus ?? "",
        updateByKey: request.cardUpdateOptions?.updateCardDataByKey ?? false
      });
      return { statusCode: 200, body: { success: true, result: true } };
    },
    async streamingUpdateWithOptions(request) {
      calls.push({
        text: request.content ?? "",
        finalize: request.isFinalize ?? false,
        guid: request.guid ?? ""
      });
      if (firstAttempt) {
        firstAttempt = false;
        return { statusCode: 200, body: { success: false, result: false } };
      }
      return { statusCode: 200, body: { success: true, result: true } };
    }
  } as never, [0, 0], async () => undefined);

  const first = client.update({
    accessToken: "token",
    contentKey: "content",
    outTrackId: "card-1",
    text: "进展一",
    finalize: false,
    error: false
  });
  const second = client.update({
    accessToken: "token",
    contentKey: "content",
    outTrackId: "card-1",
    text: "最终内容",
    finalize: true,
    error: false
  });
  await Promise.all([first, second]);

  assert.deepEqual(calls.map(({ text, finalize }) => ({ text, finalize })), [
    { text: "进展一", finalize: false },
    { text: "进展一", finalize: false },
    { text: "最终内容", finalize: true }
  ]);
  assert.equal(calls[0]?.guid, calls[1]?.guid, "a retry must keep the same idempotency GUID");
  assert.ok((calls[2]?.guid ?? "") > (calls[1]?.guid ?? ""), "later updates must have ordered GUIDs");
  assert.deepEqual(states, [
    { text: "进展一", flowStatus: "2", updateByKey: false },
    { text: "最终内容", flowStatus: "3", updateByKey: true }
  ]);
});

test("DingTalk acknowledges and normalizes Stream robot messages before replying to the conversation", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  let disconnected = false;
  const acknowledgements: Array<{ messageId: string; result: unknown }> = [];
  const webhookCalls: Array<{ url: string; text: string; accessToken: string }> = [];
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-test",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    emotionClient: noEmotionClient(),
    streamClient: {
      registerCallbackListener(topic, callback) {
        assert.equal(topic, TOPIC_ROBOT);
        listener = callback;
      },
      async connect() {},
      disconnect() { disconnected = true; },
      async getAccessToken() { return "ding-access-token"; },
      off(topic, callback) {
        assert.equal(topic, TOPIC_ROBOT);
        assert.equal(callback, listener);
      },
      socketCallBackResponse(messageId, result) {
        acknowledgements.push({ messageId, result });
      }
    },
    async webhookSender(input) {
      webhookCalls.push(input);
      return { messageId: "ding-reply" };
    },
    now: () => 1_800_000_000_000
  });
  const controller = new AbortController();
  const received = Promise.withResolvers<NormalizedWeixinMessage>();
  const monitoring = adapter.monitor({
    signal: controller.signal,
    onMessage: async (message) => received.resolve(message)
  });
  assert.ok(listener);

  listener(frame(robotMessage({ sessionWebhookExpiredTime: 1_900_000_000_000 })));
  const message = await received.promise;
  assert.deepEqual(acknowledgements, [{ messageId: "stream-message", result: {} }]);
  assert.deepEqual({
    id: message.id,
    senderId: message.senderId,
    replyTargetId: message.replyTargetId,
    text: message.text,
    attachments: message.attachments
  }, {
    id: "ding-message",
    senderId: "staff-123",
    replyTargetId: "conversation-123",
    text: "/sessions",
    attachments: []
  });

  assert.deepEqual(
    await adapter.sendText({ toUserId: "conversation-123", text: "会话列表" }),
    { messageId: "ding-reply" }
  );
  assert.deepEqual(webhookCalls, [{
    url: "https://oapi.dingtalk.com/robot/sendBySession?session=test",
    text: "会话列表",
    accessToken: "ding-access-token",
    lifecycleId: "ding-message"
  }]);

  controller.abort();
  await monitoring;
  assert.equal(disconnected, true);
});

test("DingTalk downloads a picture message and passes its local path into the current session", async (t) => {
  const inboundDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dingtalk-picture-"));
  t.after(() => fs.rmSync(inboundDir, { recursive: true, force: true }));
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const downloads: Parameters<DingTalkInboundMediaClient["download"]>[0][] = [];
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("ding picture")
  ]);
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-picture",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    inboundDir,
    emotionClient: noEmotionClient(),
    streamClient: streamClientThatCaptures((callback) => { listener = callback; }),
    mediaClient: {
      async download(input) {
        downloads.push(input);
        return { buffer: png, contentType: "image/png" };
      }
    }
  });
  const controller = new AbortController();
  const received = Promise.withResolvers<NormalizedWeixinMessage>();
  const monitoring = adapter.monitor({
    signal: controller.signal,
    onMessage: async (message) => received.resolve(message)
  });
  assert.ok(listener);
  listener(frame({
    ...robotMessage(),
    msgtype: "picture",
    content: JSON.stringify({ downloadCode: "picture-download-code" })
  }));

  const message = await received.promise;
  assert.equal(message.text, "");
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0]?.kind, "image");
  assert.equal(message.attachments[0]?.label, "dingtalk-image-1.png");
  assert.ok(message.attachments[0]?.path?.startsWith(inboundDir));
  assert.deepEqual(fs.readFileSync(message.attachments[0]?.path ?? ""), png);
  assert.deepEqual(downloads, [{
    accessToken: "ding-access-token",
    robotCode: "ding-client",
      downloadCode: "picture-download-code",
      downloadUrl: undefined,
      maxBytes: 100 * 1024 * 1024,
      lifecycleId: "ding-message"
  }]);

  controller.abort();
  await monitoring;
});

test("DingTalk preserves text and downloads pictures embedded in richText messages", async (t) => {
  const inboundDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dingtalk-richtext-"));
  t.after(() => fs.rmSync(inboundDir, { recursive: true, force: true }));
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-richtext",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    inboundDir,
    emotionClient: noEmotionClient(),
    streamClient: streamClientThatCaptures((callback) => { listener = callback; }),
    mediaClient: {
      async download(input) {
        assert.equal(input.downloadUrl, "https://download.dingtalk.example/picture");
        return { buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), contentType: "image/jpeg" };
      }
    }
  });
  const controller = new AbortController();
  const received = Promise.withResolvers<NormalizedWeixinMessage>();
  const monitoring = adapter.monitor({ signal: controller.signal, onMessage: async (message) => received.resolve(message) });
  assert.ok(listener);
  listener(frame({
    ...robotMessage(),
    msgtype: "richText",
    content: {
      richText: [
        { type: "text", text: "分析这张图" },
        { type: "picture", pictureUrl: "https://download.dingtalk.example/picture" }
      ]
    }
  }));

  const message = await received.promise;
  assert.equal(message.text, "分析这张图");
  assert.equal(message.attachments[0]?.label, "dingtalk-image-1.jpg");
  controller.abort();
  await monitoring;
});

test("DingTalk reports picture download failures instead of silently dropping the message", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-picture-failure",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    emotionClient: noEmotionClient(),
    streamClient: streamClientThatCaptures((callback) => { listener = callback; }),
    mediaClient: { async download() { throw new Error("download unavailable"); } }
  });
  const controller = new AbortController();
  const reported = Promise.withResolvers<unknown>();
  const monitoring = adapter.monitor({
    signal: controller.signal,
    async onMessage() { assert.fail("failed picture must not enter Codex without its attachment"); },
    onMessageError(error) { reported.resolve(error); }
  });
  assert.ok(listener);
  listener(frame({
    ...robotMessage(),
    msgtype: "picture",
    content: { downloadCode: "bad-picture" }
  }));

  assert.match(String(await reported.promise), /DingTalk inbound image download failed: download unavailable/);
  controller.abort();
  await monitoring;
});

test("DingTalk upgrades only official downloadCode HTTP URLs to HTTPS", () => {
  assert.equal(
    normalizeDingTalkDownloadUrl("http://download.dingtalk.example/file?signature=abc", true).toString(),
    "https://download.dingtalk.example/file?signature=abc"
  );
  assert.equal(
    normalizeDingTalkDownloadUrl("//download.dingtalk.example/file", true).toString(),
    "https://download.dingtalk.example/file"
  );
  assert.throws(
    () => normalizeDingTalkDownloadUrl("http://untrusted.example/file", false),
    /必须使用 HTTPS/
  );
});

test("DingTalk attaches a thinking emotion while a message is processing and recalls it afterward", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const calls: Array<{ action: "reply" | "recall"; input: DingTalkEmotionInput }> = [];
  const replied = Promise.withResolvers<void>();
  const recalled = Promise.withResolvers<void>();
  const processing = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-emotion",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    streamClient: {
      registerCallbackListener(_topic, callback) { listener = callback; },
      async connect() {},
      disconnect() {},
      async getAccessToken() { return "ding-access-token"; },
      off() {},
      socketCallBackResponse() {}
    },
    emotionClient: {
      async reply(input) {
        calls.push({ action: "reply", input });
        replied.resolve();
      },
      async recall(input) {
        calls.push({ action: "recall", input });
        recalled.resolve();
      }
    }
  });
  const controller = new AbortController();
  const monitoring = adapter.monitor({
    signal: controller.signal,
    async onMessage() {
      started.resolve();
      await processing.promise;
    }
  });
  assert.ok(listener);

  listener(frame(robotMessage()));
  await Promise.all([started.promise, replied.promise]);
  assert.deepEqual(calls, [{
    action: "reply",
    input: {
      accessToken: "ding-access-token",
      robotCode: "ding-client",
      openMsgId: "ding-message",
      openConversationId: "conversation-123"
    }
  }]);

  processing.resolve();
  await recalled.promise;
  assert.deepEqual(calls.map((call) => call.action), ["reply", "recall"]);
  assert.deepEqual(calls[1]?.input, calls[0]?.input);
  controller.abort();
  await monitoring;
});

test("DingTalk refuses to send after the in-memory session webhook expires", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-expired",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    emotionClient: noEmotionClient(),
    streamClient: {
      registerCallbackListener(_topic, callback) { listener = callback; },
      async connect() {},
      disconnect() {},
      async getAccessToken() { return "ding-access-token"; },
      off() {},
      socketCallBackResponse() {}
    },
    async webhookSender() {
      throw new Error("expired webhook should not be called");
    },
    now: () => 2_000_000
  });
  const controller = new AbortController();
  const received = Promise.withResolvers<void>();
  const monitoring = adapter.monitor({
    signal: controller.signal,
    onMessage: async () => received.resolve()
  });
  assert.ok(listener);
  listener(frame(robotMessage({ sessionWebhookExpiredTime: 1_000 })));
  await received.promise;

  await assert.rejects(
    adapter.sendText({ toUserId: "conversation-123", text: "late reply" }),
    /已过期/
  );
  controller.abort();
  await monitoring;
});

test("DingTalk creates, delivers, streams, and finalizes an AI Card for a group conversation", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const creates: Parameters<DingTalkAICardClient["create"]>[0][] = [];
  const updates: Parameters<DingTalkAICardClient["update"]>[0][] = [];
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-card",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    cardTemplateId: "template.schema",
    cardContentKey: "content",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    emotionClient: noEmotionClient(),
    streamClient: {
      registerCallbackListener(_topic, callback) { listener = callback; },
      async connect() {},
      disconnect() {},
      async getAccessToken() { return "ding-access-token"; },
      off() {},
      socketCallBackResponse() {}
    },
    cardClient: {
      async create(input) { creates.push(input); },
      async update(input) { updates.push(input); }
    },
    async webhookSender() {
      throw new Error("AI Card should not use the session webhook");
    }
  });
  const controller = new AbortController();
  const received = Promise.withResolvers<void>();
  const monitoring = adapter.monitor({
    signal: controller.signal,
    onMessage: async () => received.resolve()
  });
  assert.ok(listener);
  listener(frame(robotMessage()));
  await received.promise;

  const oneShot = await adapter.sendText({ toUserId: "conversation-123", text: "最终答案" });
  assert.match(oneShot.messageId, /^codex_bridge_/);
  assert.deepEqual(creates[0], {
    accessToken: "ding-access-token",
    cardTemplateId: "template.schema",
    contentKey: "content",
    outTrackId: oneShot.messageId,
    robotCode: "ding-client",
    text: "最终答案",
    target: { type: "group", conversationId: "conversation-123" },
    lifecycleId: "ding-message"
  });
  assert.deepEqual(updates[0], {
    accessToken: "ding-access-token",
    contentKey: "content",
    outTrackId: oneShot.messageId,
    text: "最终答案",
    finalize: true,
    error: false
  });

  const stream = await adapter.startTextStream({ toUserId: "staff-123", text: "正在处理" });
  assert.equal(updates[1]?.finalize, false);
  await adapter.updateTextStream({
    toUserId: "staff-123",
    messageId: stream.messageId,
    text: "流式完成",
    finalize: true
  });
  assert.deepEqual(updates[2], {
    accessToken: "ding-access-token",
    contentKey: "content",
    outTrackId: stream.messageId,
    text: "流式完成",
    finalize: true,
    error: false
  });

  controller.abort();
  await monitoring;
});

test("DingTalk falls back to the session webhook when AI Card creation fails", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const webhookTexts: string[] = [];
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-card-fallback",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    cardTemplateId: "bad-template.schema",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    emotionClient: noEmotionClient(),
    streamClient: {
      registerCallbackListener(_topic, callback) { listener = callback; },
      async connect() {},
      disconnect() {},
      async getAccessToken() { return "ding-access-token"; },
      off() {},
      socketCallBackResponse() {}
    },
    cardClient: {
      async create() { throw new Error("template unavailable"); },
      async update() {}
    },
    async webhookSender(input) {
      webhookTexts.push(input.text);
      return { messageId: "fallback-text" };
    }
  });
  const controller = new AbortController();
  const received = Promise.withResolvers<void>();
  const monitoring = adapter.monitor({ signal: controller.signal, onMessage: async () => received.resolve() });
  assert.ok(listener);
  listener(frame(robotMessage()));
  await received.promise;

  assert.deepEqual(await adapter.sendText({ toUserId: "conversation-123", text: "fallback" }), {
    messageId: "fallback-text"
  });
  assert.deepEqual(webhookTexts, ["fallback"]);
  controller.abort();
  await monitoring;
});

test("DingTalk logs the original message handling error before reporting it", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-message-failure",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    emotionClient: noEmotionClient(),
    streamClient: {
      registerCallbackListener(_topic, callback) { listener = callback; },
      async connect() {},
      disconnect() {},
      async getAccessToken() { return "ding-access-token"; },
      off() {},
      socketCallBackResponse() {}
    }
  });
  const controller = new AbortController();
  const reported = Promise.withResolvers<void>();
  const errors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const monitoring = adapter.monitor({
      signal: controller.signal,
      async onMessage() { throw new Error("Codex turn exploded"); },
      onMessageError(error) {
        assert.match(String(error), /Codex turn exploded/);
        reported.resolve();
      }
    });
    assert.ok(listener);
    listener(frame(robotMessage()));
    await reported.promise;
    assert.equal(errors.length, 1);
    assert.match(errors[0], /DingTalk message handling failed for staff-123: Codex turn exploded/);
    controller.abort();
    await monitoring;
  } finally {
    controller.abort();
    console.error = originalConsoleError;
  }
});

test("DingTalk removes its listener and disconnects when the Stream connection fails", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  let removedListener: ((message: DWClientDownStream) => void) | undefined;
  let disconnected = false;
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk",
    accountId: "dingtalk-connect-failure",
    clientId: "ding-client",
    clientSecret: "ding-secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    emotionClient: noEmotionClient(),
    streamClient: {
      registerCallbackListener(_topic, callback) { listener = callback; },
      async connect() { throw new Error("Stream connection failed"); },
      disconnect() { disconnected = true; },
      async getAccessToken() { return "ding-access-token"; },
      off(_topic, callback) { removedListener = callback; },
      socketCallBackResponse() {}
    }
  });

  await assert.rejects(
    adapter.monitor({ onMessage: async () => {} }),
    /Stream connection failed/
  );
  assert.ok(listener);
  assert.equal(removedListener, listener);
  assert.equal(disconnected, true);
});

function frame(body: unknown): DWClientDownStream {
  return {
    specVersion: "1.0",
    type: "CALLBACK",
    headers: {
      appId: "ding-client",
      connectionId: "connection",
      contentType: "application/json",
      messageId: "stream-message",
      time: "0",
      topic: TOPIC_ROBOT
    },
    data: JSON.stringify(body)
  };
}

function streamClientThatCaptures(
  capture: (callback: (message: DWClientDownStream) => void) => void
) {
  return {
    registerCallbackListener(_topic: string, callback: (message: DWClientDownStream) => void) { capture(callback); },
    async connect() {},
    disconnect() {},
    async getAccessToken() { return "ding-access-token"; },
    off() {},
    socketCallBackResponse() {}
  };
}

function robotMessage(overrides: Partial<RobotTextMessage> = {}): RobotTextMessage {
  return {
    conversationId: "conversation-123",
    chatbotCorpId: "corp",
    chatbotUserId: "robot-user",
    msgId: "ding-message",
    senderNick: "Tester",
    isAdmin: false,
    senderStaffId: "staff-123",
    sessionWebhookExpiredTime: 1_900_000_000_000,
    createAt: 0,
    senderCorpId: "corp",
    conversationType: "2",
    senderId: "sender-123",
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=test",
    robotCode: "ding-client",
    msgtype: "text",
    text: { content: "  /sessions  " },
    ...overrides
  };
}

function noEmotionClient(): DingTalkEmotionClient {
  return {
    async reply() {},
    async recall() {}
  };
}
