import assert from "node:assert/strict";

function selectedBody(map: Record<string, string>): string | undefined {
  return map[JSON.parse(map.sys_full_json_obj).order[0]];
}
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
import { createChoiceCard } from "../src/channels/action-card.js";
import { parseCommand } from "../src/bridge/channel-commands.js";
import { ChannelTurnTextStream } from "../src/channels/progress.js";
import { ChannelProgressError } from "../src/channels/errors.js";
import { PinnedNetworkLifecycleTransport } from "../src/channels/network-family.js";
import { DingTalkCardRouting } from "../src/channels/dingtalk-card-routing.js";
import { renderTurnProgressCard } from "../src/channels/turn-progress-card.js";
function cardRouting() { const routes = new DingTalkCardRouting("fake"); routes.remember("cid-test", "2", "staff-123", "fake"); return routes; }

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
    return new Response(JSON.stringify({ success: true,
      result: init?.method === "POST" ? String(input).endsWith("/deliver") ? [{ success: true }] : "card-instance" : true }), {
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
    { url: "https://api.dingtalk.com/v1.0/card/streaming", method: "PUT" },
    { url: "https://api.dingtalk.com/v1.0/card/instances", method: "PUT" }
  ]);
  assert.deepEqual(calls[0]?.body, {
    cardTemplateId: "template.schema",
    outTrackId: "card-https",
    cardData: { cardParamMap: dingTalkCardStateParamMap({ contentKey: "msgContent", text: "initial", flowStatus: "2" }) },
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
  assert.equal((calls[2]?.body.cardData as { cardParamMap?: Record<string, string> }).cardParamMap?.msgContent, undefined, "input mode must not rewrite the streaming body");
  assert.equal(calls[3]?.body.key, "msgContent");
  assert.equal(calls[3]?.body.content, "阶段一<br>继续");
  assert.equal(calls[4]?.body.content, "阶段二");
  assert.equal(calls[5]?.body.isFinalize, true);
  assert.deepEqual(calls[6]?.body.cardUpdateOptions, { updateCardDataByKey: true });
});

test("DingTalk rejects HTTP 200 card responses whose business result failed", () => {
  assert.throws(() => assertDingTalkCardMutationSucceeded("stream", {
    statusCode: 200,
    headers: { "x-acs-request-id": "request-1" },
    body: { success: false, result: false }
  }), /BusinessRejected.*request-1/);
  assert.throws(() => assertDingTalkCardMutationSucceeded("deliver", {
    statusCode: 200,
    body: { success: true, result: [{ success: false, errorMsg: "carrier rejected" }] }
  }), /DeliveryRejected/);
});

test("DingTalk requires operation-specific receipts, not just HTTP 200", () => {
  for (const operation of ["create", "deliver", "stream", "state"] as const) {
    for (const body of [undefined, null, [], {}, { code: "business.failure" }, { success: true },
      { success: true, result: null }, { success: "true", result: true }]) {
      assert.throws(() => assertDingTalkCardMutationSucceeded(operation, { statusCode: 200, body }));
    }
    assert.throws(() => assertDingTalkCardMutationSucceeded(operation, { statusCode: 500, body: { success: true, result: true } }));
  }
  for (const result of [[], [{}], [null], [{ success: true }, { success: false }], [{ success: "true" }]]) {
    assert.throws(() => assertDingTalkCardMutationSucceeded("deliver", { statusCode: 200, body: { success: true, result } }));
  }
  for (const [operation, result] of [["create", "instance"], ["deliver", [{ success: true }]],
    ["stream", true], ["state", true]] as const) {
    assert.doesNotThrow(() => assertDingTalkCardMutationSucceeded(operation, { statusCode: 200, body: { success: true, result } }));
  }
  assert.throws(() => assertDingTalkCardMutationSucceeded("state", { statusCode: 200, body: {
    success: false, result: false, message: "SECRET_TOKEN", requestId: "https://secret", code: "https://secret"
  } }), error => error instanceof Error && !/SECRET_TOKEN|https/.test(error.message));
});

test("DingTalk uncertain creation cannot be replayed by finalization or checkpoint recovery", async (t) => {
  for (const uncertainPhase of ["create", "deliver"] as const) {
    let creates = 0, deliveries = 0;
    const client = new DingTalkHttpsAICardClient(async (url, init) => {
      if (String(url).endsWith("/deliver")) {
        deliveries++;
        return new Response("{}", { status: 200 });
      }
      if (init?.method === "POST") {
        creates++;
        return new Response(JSON.stringify(uncertainPhase === "create" ? {} : { success: true, result: "instance" }), { status: 200 });
      }
      throw new Error("no update without delivery acknowledgement");
    }, [0], async () => undefined);
    const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake",
      clientSecret: "fake", cardTemplateId: "template", savedAt: "", enabled: true }, {
      cardRouting: cardRouting(), streamClient: { async getAccessToken() { return "fake"; } } as never, cardClient: client,
      async webhookSender() { throw new Error("must not fall back"); }
    });
    const stream = new ChannelTurnTextStream(adapter.client, "cid-test", { save() {} });
    t.after(() => stream.suspend());
    await stream.progress("开始");
    assert.equal(stream.checkpoint().messageId, undefined);
    assert.equal(stream.checkpoint().creationAttempted, true);
    assert.equal(await stream.finalize("完成"), false);
    const restored = new ChannelTurnTextStream(adapter.client, "cid-test", { restore: stream.checkpoint(), save() {} });
    t.after(() => restored.suspend());
    assert.equal(await restored.finalize("完成"), false);
    assert.equal(creates, 1);
    assert.equal(deliveries, uncertainPhase === "create" ? 0 : 1);
  }
});

test("DingTalk missing final acknowledgement keeps the original card and terminal payload", async (t) => {
  let creates = 0, deliveries = 0, rejected = false;
  const cardClient = new DingTalkHttpsAICardClient(async (url, init) => {
    if (init?.method === "POST") {
      if (String(url).endsWith("/deliver")) deliveries++; else creates++;
      return new Response(JSON.stringify({ success: true, result: String(url).endsWith("/deliver") ? [{ success: true }] : "instance" }), { status: 200 });
    }
    return new Response(JSON.stringify(rejected ? {} : { success: true, result: true }), { status: 200 });
  }, [0], async () => undefined);
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true }, {
    cardRouting: cardRouting(), streamClient: { async getAccessToken() { return "fake"; } } as never, cardClient,
    async webhookSender() { throw new Error("must not fall back"); }
  });
  const stream = new ChannelTurnTextStream(adapter.client, "cid-test", { save() {} });
  t.after(() => stream.suspend());
  await stream.progress("开始");
  const id = stream.checkpoint().messageId;
  rejected = true;
  assert.equal(await stream.finalize("完整最终回复"), false);
  assert.equal(stream.checkpoint().finished, false);
  assert.equal(stream.checkpoint().messageId, id);
  assert.equal(stream.checkpoint().terminal?.text, "完整最终回复");
  rejected = false;
  const restored = new ChannelTurnTextStream(adapter.client, "cid-test", { restore: stream.checkpoint(), save() {} });
  t.after(() => restored.suspend());
  assert.equal(await restored.finalize("完整最终回复"), true);
  assert.equal(restored.checkpoint().messageId, id);
  assert.equal(creates, 1); assert.equal(deliveries, 1);
});

test("DingTalk HTTPS uses ordered stream GUIDs and reuses the GUID on transport retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const guids: string[] = [];
  const client = new DingTalkHttpsAICardClient(async (url, init) => {
    if (String(url).endsWith("/streaming")) guids.push(JSON.parse(String(init?.body)).guid);
    return new Response(JSON.stringify({ success: guids.length !== 1, result: guids.length !== 1 }), { status: 200 });
  }, [0, 0], async () => undefined);
  const input = { accessToken: "fake", contentKey: "content", outTrackId: "existing-card", error: false, finalize: false };
  await client.update({ ...input, text: "第一帧" });
  await client.update({ ...input, text: "第二帧", finalize: true });
  assert.equal(guids[0], guids[1]);
  assert.ok(guids[2] > guids[1], "same-millisecond updates must be ordered, not random");
});

test("DingTalk delivered one-shot card failure never creates a webhook replacement", async () => {
  let creates = 0, webhooks = 0;
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true }, {
    cardRouting: cardRouting(), streamClient: { async getAccessToken() { return "fake"; } } as never,
    cardClient: { async create() { creates++; }, async update() { throw new Error("HTTP 503"); } },
    async webhookSender() { webhooks++; return { messageId: "replacement" }; }
  });
  await assert.rejects(adapter.client.sendText({ toUserId: "cid-test", text: "最终结果" }),
    error => error instanceof ChannelProgressError && Boolean(error.messageId));
  assert.equal(creates, 1); assert.equal(webhooks, 0);
});

test("DingTalk SDK publishes the same nonempty first frame and complete snapshots as HTTPS", async () => {
  let initial: Record<string, string> | undefined;
  let delivery: { robotCode?: string } | undefined;
  const states: Array<{ text?: string; keyed?: boolean }> = [];
  const client = new DingTalkSdkAICardClient({
    async createCardWithOptions(request) {
      initial = request.cardData.cardParamMap;
      return { statusCode: 200, body: { success: true, result: "instance" } };
    },
    async deliverCardWithOptions(request) {
      delivery = request.imRobotOpenDeliverModel;
      return { statusCode: 200, body: { success: true, result: [{ success: true }] } };
    },
    async updateCardWithOptions(request) {
      states.push({ text: selectedBody(request.cardData.cardParamMap), keyed: request.cardUpdateOptions?.updateCardDataByKey ?? false });
      return { statusCode: 200, body: { success: true, result: true } };
    },
    async streamingUpdateWithOptions() { return { statusCode: 200, body: { success: true, result: true } }; }
  } as never, [0], async () => undefined);
  const base = { accessToken: "fake", contentKey: "msgContent", outTrackId: "card-sdk", error: false, finalize: false };
  await client.create({ ...base, cardTemplateId: "template", robotCode: "robot-code",
    target: { type: "user", staffId: "staff" }, text: "首帧\n正文" });
  assert.deepEqual(initial, dingTalkCardStateParamMap({ contentKey: "msgContent", text: "首帧<br>正文", flowStatus: "2" }));
  assert.equal(delivery?.robotCode, "robot-code");
  await client.update({ ...base, text: "第一帧" });
  await client.update({ ...base, text: "第二帧" });
  await client.update({ ...base, text: "完成", finalize: true });
  assert.deepEqual(states, [{ text: undefined, keyed: true }, { text: "完成", keyed: true }]);
});

test("DingTalk session webhook requires errcode zero before creating a local receipt", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  let body: unknown = {};
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake",
    clientSecret: "fake", savedAt: "", enabled: true }, {
    apiTransport: new PinnedNetworkLifecycleTransport("ipv4", async () => new Response(JSON.stringify(body), { status: 200 })),
    emotionClient: noEmotionClient(),
    streamClient: { registerCallbackListener(_topic, callback) { listener = callback; }, async connect() {},
      disconnect() {}, async getAccessToken() { return "fake"; }, off() {}, socketCallBackResponse() {} }
  });
  const controller = new AbortController();
  const received = Promise.withResolvers<void>();
  const monitoring = adapter.monitor({ signal: controller.signal, async onMessage() { received.resolve(); } });
  listener!(frame(robotMessage()));
  await received.promise;
  try {
    for (const rejected of [{}, { errcode: "0" }, { errcode: 400, errmsg: "SECRET_URL" }]) {
      body = rejected;
      await assert.rejects(adapter.client.sendText({ toUserId: "conversation-123", text: "test" }),
        error => error instanceof Error && !error.message.includes("SECRET_URL"));
    }
    body = { errcode: 0 };
    assert.match((await adapter.client.sendText({ toUserId: "conversation-123", text: "test" })).messageId,
      /^dingtalk-webhook-receipt:/);
  } finally { controller.abort(); await monitoring; }
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

for (const mode of ["https", "sdk"] as const) {
  test(`DingTalk ${mode} sends the stop widget through one active-body writer across progress, heartbeat and recovery`, async () => {
    const writes: Array<{ kind: string; body: any }> = [];
    const client = mode === "https" ? new DingTalkHttpsAICardClient(async (url, init) => {
      writes.push({ kind: String(url).endsWith("/streaming") ? "stream" : "state", body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true, result: true }), { status: 200 });
    }, [0], async () => {}) : new DingTalkSdkAICardClient({
      async updateCardWithOptions(body) { writes.push({ kind: "state", body }); return { statusCode: 200, body: { success: true, result: true } }; },
      async streamingUpdateWithOptions(body) { writes.push({ kind: "stream", body }); return { statusCode: 200, body: { success: true, result: true } }; }
    } as never, [0], async () => {});
    const base = { accessToken: "fixture", contentKey: "msgContent", outTrackId: "restored-card", finalize: false, error: false };
    for (const activity of ["running", "running", "waiting-input", "recovering", "running"] as const) {
      const text = renderTurnProgressCard({ activity, elapsed: "1 秒", current: "当前会话由 Codex Desktop 持有，已转交桌面端继续执行。",
        recent: [], tools: { completed: 0, failed: 0 }, answerPreview: "" });
      const before = writes.length;
      await client.update({ ...base, activity, text });
      const updates = writes.slice(before);
      const bodies = updates.map(w => w.kind === "stream" ? w.body.content : selectedBody(w.body.cardData.cardParamMap)).filter(v => v !== undefined);
      assert.equal(bodies.length, 1, "never send the same active Markdown block via both snapshot and stream");
      assert.equal((bodies[0].match(/停止会中断当前任务/g) ?? []).length, 1);
      assert.equal((bodies[0].match(/\/stop/g) ?? []).length, 1);
      if (activity !== "waiting-input") {
        assert.equal(updates.at(-1)!.kind, "stream"); assert.equal(updates.at(-1)!.body.isFull, true);
        assert.equal(updates.at(-1)!.body.isFinalize, false);
      }
    }
  });

  test(`DingTalk ${mode} keeps native loading last, hides it while waiting, and resumes the same card`, async () => {
    const calls: Array<{ kind: "state" | "stream"; body: any }> = [];
    const client = mode === "https" ? new DingTalkHttpsAICardClient(async (url, init) => {
      assert.equal(init?.method, "PUT", "no replacement create/delivery is authorized");
      calls.push({ kind: String(url).endsWith("/streaming") ? "stream" : "state", body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true, result: true }), { status: 200 });
    }, [0], async () => undefined) : new DingTalkSdkAICardClient({
      async createCardWithOptions() { throw new Error("no replacement card"); },
      async deliverCardWithOptions() { throw new Error("no new delivery"); },
      async updateCardWithOptions(body) {
        calls.push({ kind: "state", body }); return { statusCode: 200, body: { success: true, result: true } };
      },
      async streamingUpdateWithOptions(body) {
        calls.push({ kind: "stream", body }); return { statusCode: 200, body: { success: true, result: true } };
      }
    } as never, [0], async () => undefined);
    const base = { accessToken: "fake", contentKey: "msgContent", outTrackId: "original", finalize: false, error: false };
    for (const text of ["**进行中**", "已完成一个步骤，并非终态"]) {
      const before = calls.length;
      await client.update({ ...base, text, activity: "running" });
      assert.deepEqual(calls.slice(before).map(call => call.kind), before === 0 ? ["state", "stream"] : ["stream"]);
      assert.equal(calls.at(-1)!.body.isFinalize, false);
      if (before === 0) {
        assert.equal(calls.at(-2)!.body.cardData.cardParamMap.flowStatus, "2");
        assert.equal(calls.at(-2)!.body.cardData.cardParamMap.msgContent, undefined);
      }
    }
    for (const activity of ["waiting-input", "waiting-approval", "unconfirmed"] as const) {
      const before = calls.length;
      await client.update({ ...base, text: "正文仍写着正在执行", activity });
      assert.deepEqual(calls.slice(before).map(call => call.kind), ["state"]);
      assert.equal(calls.at(-1)!.body.cardData.cardParamMap.flowStatus, "3");
      assert.equal(selectedBody(calls.at(-1)!.body.cardData.cardParamMap), "正文仍写着正在执行");
      assert.deepEqual(JSON.parse(calls.at(-1)!.body.cardData.cardParamMap.sys_full_json_obj).order, ["staticMsgContent"]);
    }
    for (const activity of ["recovering", "running"] as const) {
      const before = calls.length;
      await client.update({ ...base, text: "恢复后继续", activity });
      assert.deepEqual(calls.slice(before).map(call => call.kind), activity === "recovering" ? ["state", "stream"] : ["stream"]);
      assert.equal(calls.at(-1)!.body.isFinalize, false);
    }
    await client.update({ ...base, text: "真实最终回执", activity: "running", finalize: true });
    assert.equal(calls.at(-2)!.kind, "stream");
    assert.equal(calls.at(-2)!.body.isFinalize, true);
    assert.equal(calls.at(-1)!.body.cardData.cardParamMap.flowStatus, "3");
    assert.ok(calls.every(call => call.body.outTrackId === "original"));
  });

  test(`DingTalk ${mode} task-error bodies remain visible on their original instance`, async () => {
    const states: Array<Record<string, string>> = [];
    const streams: Array<{ isError?: boolean; isFinalize?: boolean; content?: string }> = [];
    const ids: string[] = [];
    const client = mode === "https" ? new DingTalkHttpsAICardClient(async (_url, init) => {
      assert.equal(init?.method, "PUT");
      const body = JSON.parse(String(init?.body)); ids.push(body.outTrackId);
      if (body.cardData) states.push(body.cardData.cardParamMap); else streams.push(body);
      return new Response(JSON.stringify({ success: true, result: true }), { status: 200 });
    }, [0], async () => undefined) : new DingTalkSdkAICardClient({
      async createCardWithOptions() { throw new Error("Must not create a replacement"); },
      async deliverCardWithOptions() { throw new Error("Must not redeliver"); },
      async updateCardWithOptions(request: { outTrackId: string; cardData: { cardParamMap: Record<string, string> } }) {
        ids.push(request.outTrackId); states.push(request.cardData.cardParamMap);
        return { statusCode: 200, body: { success: true, result: true } };
      },
      async streamingUpdateWithOptions(request: { outTrackId: string; isError?: boolean; isFinalize?: boolean; content?: string }) {
        ids.push(request.outTrackId); streams.push(request);
        return { statusCode: 200, body: { success: true, result: true } };
      }
    } as never, [0], async () => undefined);
    await client.update({ accessToken: "fake", outTrackId: "original", contentKey: "msgContent",
      text: "明确的失败说明，不是空白内容", finalize: true, error: true });
    assert.ok(ids.every(id => id === "original"));
    assert.equal(streams.at(-1)?.isError, false);
    assert.equal(streams.at(-1)?.isFinalize, true);
    assert.match(streams.at(-1)?.content ?? "", /处理失败.*失败说明/s);
    assert.equal(states.at(-1)?.flowStatus, "3");
    assert.match(selectedBody(states.at(-1)!) ?? "", /处理失败.*失败说明/s);
  });
}

test("DingTalk serializes updates, uses ordered GUIDs, and retries a rejected business response", async () => {
  const calls: Array<{ text: string; finalize: boolean; guid: string }> = [];
  const states: Array<{ text: string; flowStatus: string; updateByKey: boolean }> = [];
  let firstAttempt = true;
  const client = new DingTalkSdkAICardClient({
    async createCardWithOptions() { return { statusCode: 200, body: { success: true, result: "ok" } }; },
    async deliverCardWithOptions() { return { statusCode: 200, body: { success: true, result: [{ success: true }] } }; },
    async updateCardWithOptions(request) {
      states.push({
        text: selectedBody(request.cardData.cardParamMap) ?? "",
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
    { text: "", flowStatus: "2", updateByKey: true },
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

test("DingTalk group mentions preserve slash command routing without changing ordinary messages", async (t) => {
  const cases = [
    { text: "  @机器人  /session existing-thread  ", expected: "/session existing-thread" },
    { text: "<@bot-open-id> /session existing-thread", expected: "/session existing-thread" },
    { text: "@机器人\u00a0/session existing-thread", expected: "/session existing-thread" },
    { text: "@机器人 @助手 /sessions", expected: "/sessions" },
    { text: "/session existing-thread", expected: "/session existing-thread" },
    { text: "@机器人 /steer 请检查 @同事 的提交", expected: "/steer 请检查 @同事 的提交" },
    { text: "@机器人 请解释 /session", expected: "@机器人 请解释 /session" },
    { text: "请发送 @机器人 /session existing-thread", expected: "请发送 @机器人 /session existing-thread" },
    { text: "> @机器人 /stop", expected: "> @机器人 /stop" },
    { text: "@机器人\n/stop", expected: "/stop" },
    { text: "@头头/queue这是在干啥？", expected: "/queue这是在干啥？" },
    { text: "@头头/queue 这是在干啥？", expected: "/queue 这是在干啥？" },
    { text: "@头头/status", expected: "/status" },
    { text: "@头头\n\n/status", expected: "/status" },
    { text: "<@bot-open-id>/queue请先检查", expected: "/queue请先检查" },
    { text: "@头头这是说明，不是命令 /status", expected: "@头头这是说明，不是命令 /status" },
    { text: "`@头头/status`", expected: "`@头头/status`" },
    { text: "@机器人", expected: "@机器人" },
    { text: "email@example.com /stop", expected: "email@example.com /stop" },
    { text: "@机器人 /session existing-thread", expected: "@机器人 /session existing-thread", conversationType: "1" }
  ];
  for (const msgtype of ["text", "richText"]) {
    for (const input of cases) {
      await t.test(`${msgtype}: ${JSON.stringify(input.text)} (${input.conversationType ?? "2"})`, async (t) => {
        t.mock.method(console, "info", () => {});
        let listener: ((message: DWClientDownStream) => void) | undefined;
        const adapter = new DingTalkChannelAdapter({
          channel: "dingtalk", accountId: "mentions-test", clientId: "ding-client",
          clientSecret: "ding-secret", savedAt: new Date().toISOString(), enabled: true
        }, {
          emotionClient: noEmotionClient(),
          streamClient: streamClientThatCaptures((callback) => { listener = callback; })
        });
        const controller = new AbortController();
        const received = Promise.withResolvers<NormalizedWeixinMessage>();
        const monitoring = adapter.monitor({
          signal: controller.signal, onMessage: async (message) => received.resolve(message)
        });
        t.after(async () => { controller.abort(); await monitoring; });
        assert.ok(listener);
        listener(frame({
          ...robotMessage({ conversationType: input.conversationType ?? "2" }),
          msgtype,
          text: { content: input.text },
          content: { richText: [{ text: input.text }] }
        }));
        const message = await received.promise;
        assert.equal(message.text, input.expected);
        assert.equal(message.senderId, "staff-123", "mention normalization must not change authorization identity");
        assert.equal(message.replyTargetId, "conversation-123");
        assert.deepEqual(parseCommand(message.text), parseCommand(input.expected));
        if (input.expected === "/session existing-thread") {
          assert.deepEqual(parseCommand(message.text), { name: "session", arg: "existing-thread" });
        }
      });
    }
  }
});

test("DingTalk identity diagnostics report only the raw callback code once per monitor", async (t) => {
  for (const robotCode of ["observed-robot-code", undefined, "", "  observed-code  "]) {
    await t.test(`raw robotCode ${JSON.stringify(robotCode)}`, async (t) => {
      const info = t.mock.method(console, "info", () => {});
      let listener: ((message: DWClientDownStream) => void) | undefined;
      const received: NormalizedWeixinMessage[] = [];
      const adapter = new DingTalkChannelAdapter({
        channel: "dingtalk",
        accountId: "identity-test",
        clientId: "fallback-client-id",
        clientSecret: "must-not-log-secret",
        savedAt: new Date().toISOString(),
        enabled: true
      }, {
        emotionClient: noEmotionClient(),
        streamClient: streamClientThatCaptures((callback) => { listener = callback; })
      });
      const controller = new AbortController();
      const monitoring = adapter.monitor({
        signal: controller.signal,
        claimMessage: (message) => message.id !== "duplicate",
        onMessage: async (message) => { received.push(message); }
      });
      t.after(async () => { controller.abort(); await monitoring; });
      assert.ok(listener);
      listener(frame(robotMessage({ conversationId: "" })));
      listener(frame(robotMessage({ msgId: "duplicate" })));
      assert.equal(info.mock.callCount(), 0, "ignored callbacks must not consume the diagnostic");

      const message = { ...robotMessage({ text: { content: "must-not-log-message" } }), robotCode };
      listener(frame(message));
      listener(frame({ ...message, msgId: "second-message", robotCode: "different-code" }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(received.length, 2, "diagnostics must not interrupt message delivery");
      assert.deepEqual(info.mock.calls.map(({ arguments: args }) => args), [[
        `[codex-im-gateway] DingTalk callback identity ${JSON.stringify({
          accountId: "identity-test", source: "callback", robotCode: robotCode ?? null
        })}`
      ]], "only the account and raw identity may be logged, not credentials, actor, webhook, or text");
    });
  }
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
    onMessage: async (message) => received.resolve({ ...message, attachments: await adapter.client.resolveAttachments(message) })
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
  const monitoring = adapter.monitor({ signal: controller.signal,
    onMessage: async (message) => received.resolve({ ...message, attachments: await adapter.client.resolveAttachments(message) }) });
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

test("DingTalk receives direct and quoted files without downloading until the shared resolver is invoked", async t => {
  const inboundDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-inbound-files-"));
  t.after(() => fs.rmSync(inboundDir, { recursive: true, force: true }));
  let listener: ((message: DWClientDownStream) => void) | undefined;
  let downloads = 0;
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "files",
    clientId: "ding-client", clientSecret: "secret", enabled: true, savedAt: new Date().toISOString() }, {
    inboundDir, emotionClient: noEmotionClient(), streamClient: streamClientThatCaptures(callback => { listener = callback; }),
    mediaClient: { async download(input) { downloads++; assert.equal(input.downloadCode, "file-code"); return { buffer: Buffer.from("Inventory 中文全文"), contentType: "text/markdown" }; } }
  });
  for (const quoted of [false, true]) {
    const controller = new AbortController();
    const received = Promise.withResolvers<NormalizedWeixinMessage>();
    const monitoring = adapter.monitor({ signal: controller.signal, async onMessage(message) { received.resolve(message); } });
    const body = quoted ? { msgtype: "text", text: { content: "读引用", repliedMsg: {
      msgType: "file", msgId: "original", content: JSON.stringify({ fileName: "MCT.md", downloadCode: "file-code" })
    } } } : { msgtype: "file", content: { fileName: "MCT.md", downloadCode: "file-code" } };
    listener!(frame({ ...robotMessage(), ...body }));
    const message = await received.promise;
    assert.equal(downloads, quoted ? 1 : 0);
    const attachments = await adapter.client.resolveAttachments(message);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].kind, "file");
    assert.equal(fs.readFileSync(attachments[0].path!, "utf8"), "Inventory 中文全文");
    assert.equal(attachments[0].sourceMessageId, quoted ? "original" : undefined);
    assert.equal(fs.statSync(attachments[0].path!).mode & 0o777, 0o600);
    controller.abort(); await monitoring;
  }
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
    async onMessage(message) { await adapter.client.resolveAttachments(message); assert.fail("failed picture must not enter Codex without its attachment"); },
    onMessageError(error) { reported.resolve(error); }
  });
  assert.ok(listener);
  listener(frame({
    ...robotMessage(),
    msgtype: "picture",
    content: { downloadCode: "bad-picture" }
  }));

  assert.match(String(await reported.promise), /DingTalk inbound image download failed; check attachment access/);
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
    finalize: true,
    target: { type: "group", conversationId: "conversation-123" },
    lifecycleId: "ding-message"
  });
  assert.deepEqual(updates[0], {
    accessToken: "ding-access-token",
    contentKey: "content",
    outTrackId: oneShot.messageId,
    text: "最终答案",
    finalize: true,
    presentation: "static",
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

test("DingTalk retains an acknowledged card when its first progress update fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  let creates = 0;
  const updates: Array<{ outTrackId: string; text: string; finalize: boolean }> = [];
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true
  }, {
    cardRouting: cardRouting(), streamClient: { async getAccessToken() { return "fake"; } } as never,
    cardClient: {
      async create() { creates++; },
      async update(input) {
        updates.push(input);
        if (updates.length === 1) throw Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" });
      }
    }
  });
  const stream = new ChannelTurnTextStream(adapter.client, "cid-test");
  t.after(() => stream.suspend());
  await stream.progress("开始");
  assert.ok(stream.checkpoint().messageId);
  t.mock.timers.tick(5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(creates, 1);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].outTrackId, updates[1].outTrackId);
  assert.equal(await stream.finalize("完成"), true);
});

test("DingTalk HTTPS allowlist recovery reuses its delivered card without multiplying 403 requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...parts: unknown[]) => { warnings.push(parts.join(" ")); });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let rejected = true;
  const cardClient = new DingTalkHttpsAICardClient(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return String(url).endsWith("/streaming") && rejected
      ? new Response(JSON.stringify({ code: "Forbidden.AccessDenied.IpNotInWhiteList", message: "DO_NOT_LOG_PROVIDER_BODY", requestId: "req-test" }), { status: 403 })
      : new Response(JSON.stringify({ success: true,
        result: init?.method === "POST" ? String(url).endsWith("/deliver") ? [{ success: true }] : "instance" : true }), { status: 200 });
  }, [0, 0, 0], async () => undefined);
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true
  }, { cardRouting: cardRouting(), streamClient: { async getAccessToken() { return "fake"; } } as never, cardClient });
  const stream = new ChannelTurnTextStream(adapter.client, "cid-test");
  t.after(() => stream.suspend());
  await stream.progress("开始检查");
  const originalCard = stream.checkpoint().messageId;
  assert.ok(originalCard);
  assert.equal(calls.filter((call) => call.url.endsWith("/streaming")).length, 1);
  assert.ok(warnings.some((line) => line.includes('"httpStatus":403') && line.includes('"code":"Forbidden.AccessDenied.IpNotInWhiteList"')));
  assert.ok(warnings.every((line) => !line.includes("DO_NOT_LOG_PROVIDER_BODY")));
  await stream.progress("最新状态");
  rejected = false;
  t.mock.timers.tick(30_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.url.endsWith("/deliver")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/streaming")).length, 2);
  assert.ok(calls.every((call) => call.body.outTrackId === originalCard));
  assert.match(String(calls.findLast((call) => call.url.endsWith("/streaming"))?.body.content), /最新状态/);
  assert.equal(await stream.finalize("最终结果"), true);
});

test("DingTalk does not reinterpret unrelated 403 permission failures as route recovery", async () => {
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true
  }, {
    streamClient: { async getAccessToken() { return "fake"; } } as never,
    cardClient: {
      async create() {},
      async update() { throw new Error("HTTP 403 Forbidden.AccessDenied.PermissionDenied"); }
    }
  });
  await assert.rejects(adapter.client.updateTextStream({ toUserId: "cid-test", messageId: "original", text: "进度" }),
    (error: unknown) => error instanceof ChannelProgressError && !error.retryable && !error.recoveryProbe);
});

test("DingTalk falls back to the session webhook when AI Card creation fails", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  let creates = 0;
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
      async create() { creates++; throw new Error("template unavailable"); },
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

  const plain = await adapter.client.sendProgressText({ toUserId: "conversation-123", text: "降级进度" });
  assert.equal(plain.messageId, "fallback-text");
  assert.deepEqual(webhookTexts, ["降级进度"]);
  assert.equal(creates, 0, "plain progress bypasses AI Card creation entirely");
  webhookTexts.length = 0;

  assert.deepEqual(await adapter.sendText({ toUserId: "conversation-123", text: "fallback" }), {
    messageId: "fallback-text"
  });
  assert.deepEqual(webhookTexts, ["fallback"]);
  const tableCard = createChoiceCard({ title: "会话", body: "", table: { columns: [{ label: "编号" }, { label: "标题" }], rows: [["R1", "test"]] },
    fallbackText: "[R1] test", choices: [] });
  const receipt = await adapter.client.sendActionCard({ toUserId: "conversation-123", card: tableCard });
  assert.equal(webhookTexts.at(-1), "[R1] test", "failed table is replaced with readable text, not raw Markdown");
  assert.deepEqual(receipt.parts, [{ messageId: "fallback-text", text: "[R1] test" }]);
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

test("DingTalk callback exposes group title as public display identity without confusing it with the sender", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake", savedAt: "", enabled: true }, {
    emotionClient: noEmotionClient(), streamClient: streamClientThatCaptures(callback => { listener = callback; }) });
  const abort = new AbortController(), ready = Promise.withResolvers<void>();
  const monitor = adapter.monitor({ signal: abort.signal, async onMessage() { ready.resolve(); } });
  try {
    listener!(frame({ ...robotMessage(), conversationTitle: "诊断群", senderNick: "张三" }));
    await ready.promise;
    assert.deepEqual(adapter.client.conversationIdentity("conversation-123"), { kind: "group", name: "诊断群" });
    assert.deepEqual(adapter.client.conversationIdentity("staff-123"), { kind: "direct", name: "张三" });
  } finally { abort.abort(); await monitor; }
});

test("unconfigured DingTalk @ uses native webhook recipients without inventing a card", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const sent: any[] = [], received: any[] = [];
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake",
    clientSecret: "fake", savedAt: "", enabled: true }, {
    apiTransport: new PinnedNetworkLifecycleTransport("ipv4", async (_family, _url, init) => {
      sent.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ errcode: 0, processQueryKey: "mention" }), { status: 200 });
    }), cardClient: { async create() { throw new Error("must not create card"); }, async update() {} },
    emotionClient: noEmotionClient(), streamClient: streamClientThatCaptures(callback => { listener = callback; }), now: () => 1_800_000_000_000
  });
  const abort = new AbortController(), ready = Promise.withResolvers<void>();
  const monitor = adapter.monitor({ signal: abort.signal, async onMessage(message) { received.push(message); ready.resolve(); } });
  try {
    listener!(frame(robotMessage())); await ready.promise;
    assert.deepEqual(received[0].mention, { userId: "staff-123", name: "Tester" });
    await adapter.client.sendMentionNotification({ toUserId: "conversation-123", text: "回复命令：\n\n```text\n/answer Q38 --option 1\n```", mentions: [{ userId: "staff-123" }, { userId: "staff-456" }] });
    assert.deepEqual(sent, [{ msgtype: "text", text: { content: "@staff-123 @staff-456\n回复命令：\n\n/answer Q38 --option 1" }, at: { atUserIds: ["staff-123", "staff-456"], isAtAll: false } }]);
  } finally { abort.abort(); await monitor; }
});

test("DingTalk IDE approval keeps the real staff identity separate from group routing and never infers context from matching IDs", async () => {
  for (const [conversationType, conversationId, expected] of [["1", "staff-123", "direct"], ["2", "cid-group", "group"], ["2", "staff-123", "group"], ["unknown", "staff-123", undefined]] as const) {
    let listener: ((message: DWClientDownStream) => void) | undefined;
    const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake", savedAt: "", enabled: true }, {
      emotionClient: noEmotionClient(), streamClient: streamClientThatCaptures(callback => { listener = callback; }) });
    const abort = new AbortController(), ready = Promise.withResolvers<NormalizedWeixinMessage>();
    const monitor = adapter.monitor({ signal: abort.signal, async onMessage(message) { ready.resolve(message); } });
    try {
      const command = "/ide access abcdef123456";
      listener!(frame(robotMessage({ conversationType, conversationId, senderId: "encrypted-other-id",
        text: { content: conversationType === "2" ? `<@fake> ${command}` : command } })));
      const message = await ready.promise;
      assert.equal(message.senderId, "staff-123"); assert.equal(message.replyTargetId, conversationId);
      assert.equal(message.text, command, "a group mention before the explicit command does not change its actor or arguments");
      assert.equal(message.conversationKind, expected);
    } finally { abort.abort(); await monitor; }
  }
});

test("configured DingTalk questions and native @ share one static Markdown card even while the webhook is available", async () => {
  let listener: ((message: DWClientDownStream) => void) | undefined;
  const writes: any[] = [], cards: any[] = [], updates: any[] = [];
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake",
    clientSecret: "fake", cardTemplateId: "template", savedAt: "", enabled: true }, {
    webhookSender: async input => { writes.push(input); return { messageId: "question" }; },
    cardClient: { async create(input) { cards.push(input); }, async update(input) { updates.push(input); } },
    emotionClient: noEmotionClient(), streamClient: streamClientThatCaptures(callback => { listener = callback; }), now: () => 1_800_000_000_000
  });
  const abort = new AbortController(), ready = Promise.withResolvers<void>();
  const monitor = adapter.monitor({ signal: abort.signal, async onMessage() { ready.resolve(); } });
  try {
    listener!(frame(robotMessage())); await ready.promise;
    const question = createChoiceCard({ title: "Codex 问题 Q7", body: "项目在哪里？", fallbackText: "【Codex 问题 Q7】\n项目在哪里？", choices: [{ label: "继续", command: "answer", arg: "Q7 --option 1" }] });
    const receipt = await adapter.client.sendActionCard({ toUserId: "conversation-123", card: question, mentions: [{ userId: "staff-123" }] });
    assert.equal(writes.length, 0); assert.equal(cards.length, 1); assert.equal(receipt.messageId, cards[0].outTrackId);
    assert.deepEqual(cards[0].atUserIds, { "staff-123": "参与者" });
    assert.equal(cards[0].text, `<a atId=staff-123>参与者</a>\n\n${question.fallbackText}`);
    assert.match(cards[0].text, /```text\n\/answer Q7 --option 1\n```/);
    assert.equal(cards[0].finalize, true); assert.equal(updates[0].presentation, "static");
  } finally { abort.abort(); await monitor; }
});

test("DingTalk question @ uses persisted card routing after restart, with full Q instructions", async () => {
  const created: any[] = [], updated: any[] = [];
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true }, { cardRouting: cardRouting(),
    cardClient: { async create(input) { created.push(input); }, async update(input) { updated.push(input); } },
    streamClient: { async getAccessToken() { return "fake"; } } as never,
    async webhookSender() { throw new Error("no ephemeral webhook after restart"); } });
  const question = createChoiceCard({ title: "Codex 问题 Q8", body: "继续吗？", fallbackText: "【Codex 问题 Q8】\n继续吗？\n/answer Q8 yes", choices: [] });
  await adapter.client.sendActionCard({ toUserId: "cid-test", card: question, mentions: [{ userId: "staff-123", name: "Tester" }] });
  assert.equal(created.length, 1); assert.equal(updated.length, 1);
  assert.deepEqual(created[0].atUserIds, { "staff-123": "Tester" });
  assert.equal(created[0].text, `<a atId=staff-123>Tester</a>\n\n${question.fallbackText}`);
  assert.equal(updated[0].text, created[0].text);
});

test("long DingTalk questions preserve every page and notify only on the first page", async () => {
  const created: any[] = [];
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true }, { cardRouting: cardRouting(),
    cardClient: { async create(input) { created.push(input); }, async update() {} },
    streamClient: { async getAccessToken() { return "fake"; } } as never });
  const text = `【Codex 问题 Q9】\n${"中文说明".repeat(2_000)}\n/answer Q9 text`;
  const question = createChoiceCard({ title: "Codex 问题 Q9", body: text, fallbackText: text, choices: [] });
  const receipt = await adapter.client.sendActionCard({ toUserId: "cid-test", card: question, mentions: [{ userId: "staff-123" }] });
  assert.ok(created.length > 1); assert.equal(created.filter(item => item.atUserIds).length, 1);
  assert.ok(created.every(item => Buffer.byteLength(item.text) <= 6_000));
  assert.equal(receipt.parts?.length, created.length);
  assert.match(created.at(-1)!.text, /\/answer Q9 text/);
  assert.equal((created.map(item => item.text).join("").match(/中文说明/g) ?? []).length, 2_000);
});

for (const transport of ["https", "sdk"] as const) {
  test(`DingTalk ${transport} completion card @ survives ephemeral webhook loss using the persisted group route`, async () => {
    const deliveries: any[] = [], creations: any[] = [], frames: string[] = [];
    const client = transport === "https" ? new DingTalkHttpsAICardClient(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/deliver")) deliveries.push(body);
      else if (init?.method === "POST") creations.push(body);
      else frames.push(body.content ?? selectedBody(body.cardData.cardParamMap));
      return new Response(JSON.stringify({ success: true, result: init?.method === "PUT" ? true
        : String(url).endsWith("/deliver") ? [{ success: true }] : "instance" }), { status: 200 });
    }, [0], async () => {}) : new DingTalkSdkAICardClient({
      async createCardWithOptions(request: unknown) { creations.push(request); return { statusCode: 200, body: { success: true, result: "instance" } }; },
      async deliverCardWithOptions(request: unknown) { deliveries.push(request); return { statusCode: 200, body: { success: true, result: [{ success: true }] } }; },
      async updateCardWithOptions(request: any) { frames.push(selectedBody(request.cardData.cardParamMap)); return { statusCode: 200, body: { success: true, result: true } }; },
      async streamingUpdateWithOptions(request: any) { frames.push(request.content); return { statusCode: 200, body: { success: true, result: true } }; }
    } as never, [0], async () => {});
    const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
      cardTemplateId: "template", savedAt: "", enabled: true }, { cardRouting: cardRouting(), cardClient: client,
      streamClient: { async getAccessToken() { return "fake"; } } as never,
      async webhookSender() { throw new Error("no ephemeral route after restart"); } });
    await adapter.client.sendMentionNotification({ toUserId: "cid-test", text: "完成", mentions: [{ userId: "staff-123", name: "Tester" }] });
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0].openSpaceId, "dtv1.card//IM_GROUP.cid-test");
    assert.deepEqual(deliveries[0].imGroupOpenDeliverModel.atUserIds, { "staff-123": "Tester" });
    assert.deepEqual(creations[0].cardAtUserIds, ["staff-123"]);
    assert.equal(creations[0].userIdType, 1);
    const expected = "<a atId=staff-123>Tester</a>\n\n完成";
    assert.equal(selectedBody(creations[0].cardData.cardParamMap), expected);
    assert.equal(creations[0].cardData.cardParamMap.flowStatus, "3");
    assert.deepEqual(frames, [expected], "static notifications never enter input mode or open a native stream");
  });
}

for (const transport of ["https", "sdk"] as const) {
  test(`DingTalk ${transport} merges full result and native @, then summarizes only the original segment`, async () => {
    const calls: Array<{ operation: string; body: any }> = [];
    const client = transport === "https" ? new DingTalkHttpsAICardClient(async (url, init) => {
      const operation = String(url).endsWith("/deliver") ? "deliver" : init?.method === "POST" ? "create"
        : String(url).endsWith("/streaming") ? "stream" : "state";
      calls.push({ operation, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true, result: operation === "create" ? "instance"
        : operation === "deliver" ? [{ success: true }] : true }), { status: 200 });
    }, [0], async () => {}) : new DingTalkSdkAICardClient({
      async createCardWithOptions(body: unknown) { calls.push({ operation: "create", body }); return { statusCode: 200, body: { success: true, result: "instance" } }; },
      async deliverCardWithOptions(body: unknown) { calls.push({ operation: "deliver", body }); return { statusCode: 200, body: { success: true, result: [{ success: true }] } }; },
      async updateCardWithOptions(body: unknown) { calls.push({ operation: "state", body }); return { statusCode: 200, body: { success: true, result: true } }; },
      async streamingUpdateWithOptions(body: unknown) { calls.push({ operation: "stream", body }); return { statusCode: 200, body: { success: true, result: true } }; }
    } as never, [0], async () => {});
    let listener: ((message: DWClientDownStream) => void) | undefined;
    const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
      cardTemplateId: "template", savedAt: "", enabled: true }, { cardClient: client,
      streamClient: streamClientThatCaptures(callback => { listener = callback; }), emotionClient: noEmotionClient(),
      async webhookSender() { throw new Error("a combined result must not use the otherwise available webhook"); }, now: () => 1_800_000_000_000 });
    const abort = new AbortController(), ready = Promise.withResolvers<void>();
    const monitor = adapter.monitor({ signal: abort.signal, async onMessage() { ready.resolve(); } });
    try {
      listener!(frame(robotMessage())); await ready.promise;
      const receipt = await adapter.client.sendMentionNotification({ toUserId: "conversation-123", text: "full result",
        mentions: [{ userId: "staff-123", name: "Tester" }, { userId: "staff-456", name: "Other" }],
        completedCard: { messageId: "original-segment", text: "full result", summary: "phase summary" } });
      assert.notEqual(receipt.messageId, "original-segment");
      assert.equal(calls.filter(item => item.operation === "create").length, 1);
      const created = calls.find(item => item.operation === "create")!.body;
      const expected = "<a atId=staff-123>Tester</a> <a atId=staff-456>Other</a>\n\nfull result";
      assert.deepEqual(created.cardAtUserIds, ["staff-123", "staff-456"]);
      assert.equal(created.userIdType, 1);
      assert.equal(selectedBody(created.cardData.cardParamMap), expected);
      const delivery = calls.find(item => item.operation === "deliver")!.body;
      assert.equal(delivery.outTrackId, receipt.messageId); assert.equal(delivery.openSpaceId, "dtv1.card//IM_GROUP.conversation-123");
      assert.deepEqual(delivery.imGroupOpenDeliverModel.atUserIds, { "staff-123": "Tester", "staff-456": "Other" });
      assert.deepEqual(calls.filter(item => item.operation === "stream").map(item => [item.body.outTrackId, item.body.content]),
        [], "a sealed source card must never reopen its streaming component for an @ summary");
      assert.deepEqual(calls.filter(item => item.operation === "state" && item.body.outTrackId === "original-segment")
        .map(item => [item.body.cardData.cardParamMap.flowStatus, selectedBody(item.body.cardData.cardParamMap)]), [["3", "phase summary"]]);
      assert.deepEqual(calls.filter(item => item.operation === "state" && item.body.outTrackId === receipt.messageId)
        .map(item => selectedBody(item.body.cardData.cardParamMap)), [expected]);
      assert.deepEqual(calls.map(item => item.operation), ["create", "deliver", "state", "state"]);
      const newFinal = calls.findIndex(item => item.operation === "state" && item.body.outTrackId === receipt.messageId && item.body.cardData.cardParamMap.flowStatus === "3");
      const oldFirst = calls.findIndex(item => item.body.outTrackId === "original-segment");
      assert.ok(newFinal > 0 && oldFirst > newFinal, "never remove the old answer before the new final content is acknowledged");
      assert.equal(calls.filter(item => item.operation === "deliver").length, 1, "no re-delivery of the source card and no extra reminder");
      assert.equal(calls.at(-1)!.body.outTrackId, "original-segment");
    } finally { abort.abort(); await monitor; }
  });
}

for (const transport of ["https", "sdk"] as const) {
  test(`DingTalk ${transport} rejects invalid @ metadata before creating or delivering anything`, async () => {
    const unexpected = async (): Promise<never> => { throw new Error("unexpected external write"); };
    const client = transport === "https" ? new DingTalkHttpsAICardClient(unexpected, [0]) : new DingTalkSdkAICardClient({
      createCardWithOptions: unexpected, deliverCardWithOptions: unexpected,
      updateCardWithOptions: unexpected, streamingUpdateWithOptions: unexpected
    } as never, [0]);
    for (const atUserIds of [{}, { "@ALL": "@ALL" }, { "bad id": "name" }, { alice: "" },
      Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`u${i}`, "name"]))]) {
      const input = { accessToken: "fake", outTrackId: "invalid", robotCode: "fake", target: { type: "group" as const, conversationId: "group" }, atUserIds };
      await assert.rejects(client.create({ ...input, cardTemplateId: "template", contentKey: "content", text: "body" }), /Invalid DingTalk/);
      await assert.rejects(client.deliver!(input), /Invalid DingTalk/);
    }
    await assert.rejects(client.create({ accessToken: "fake", outTrackId: "dm", robotCode: "fake", cardTemplateId: "template",
      contentKey: "content", text: "body", target: { type: "user", staffId: "alice" }, atUserIds: { alice: "Alice" } }), /Invalid DingTalk/);
  });
}

for (const failure of ["create", "deliver", "final", "summary"] as const) {
  test(`DingTalk merged result ${failure} failure never causes a second delivery or prematurely removes the original answer`, async () => {
    const calls: Array<{ operation: string; outTrackId: string; text?: string }> = [];
    const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
      cardTemplateId: "template", savedAt: "", enabled: true }, { cardRouting: cardRouting(), emotionClient: noEmotionClient(),
      streamClient: { async getAccessToken() { return "fake"; } } as never,
      async webhookSender() { throw new Error("no fallback"); },
      cardClient: {
        async create(input) {
          calls.push({ operation: "create", outTrackId: input.outTrackId, text: input.text });
          if (failure === "create") throw new Error("unknown create receipt");
          calls.push({ operation: "deliver", outTrackId: input.outTrackId });
          if (failure === "deliver") throw new Error("unknown delivery receipt");
        },
        async update(input) {
          const summary = input.outTrackId === "original-segment";
          calls.push({ operation: summary ? "summary" : "final", outTrackId: input.outTrackId, text: input.text });
          if (failure === (summary ? "summary" : "final")) throw new Error("unknown update receipt");
        }
      } });
    const operation = adapter.client.sendMentionNotification({ toUserId: "cid-test", text: "result", mentions: [{ userId: "staff-123" }],
      completedCard: { messageId: "original-segment", text: "result", summary: "summary" } });
    if (failure === "summary") assert.ok((await operation).messageId);
    else await assert.rejects(operation);
    assert.equal(calls.filter(item => item.operation === "create").length, 1);
    assert.equal(calls.some(item => item.operation === "summary"), failure === "summary");
    assert.equal(calls.some(item => item.operation === "deliver" && item.outTrackId === "original-segment"), false);
  });
}
