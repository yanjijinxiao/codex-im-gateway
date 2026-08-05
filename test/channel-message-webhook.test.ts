import assert from "node:assert/strict";
import test from "node:test";

import { ChannelMessageWebhook } from "../src/webhooks/channel-message-webhook.js";

test("does not request a webhook when the channel has no webhook configured", () => {
  let requestCount = 0;
  const webhook = new ChannelMessageWebhook({
    accountId: "account-one",
    channel: "weixin",
    fetch: async () => {
      requestCount += 1;
      return new Response(null, { status: 204 });
    }
  });
  const message = {
    direction: "inbound" as const,
    id: "message-1",
    senderId: "alice",
    text: "hello",
    attachments: []
  };

  webhook.publish(message);
  assert.equal(requestCount, 0);

  webhook.configure("https://hooks.example.test/channel");
  webhook.publish(message);
  assert.equal(requestCount, 1);

  webhook.configure(undefined);
  webhook.publish(message);
  assert.equal(requestCount, 1);
});

test("omits the sender when adapting inbound events for an Enterprise WeChat webhook", async () => {
  let requestBody: unknown;
  const webhook = new ChannelMessageWebhook({
    accountId: "account-one",
    channel: "feishu",
    webhookUrl: "https://hooks.example.test/team",
    webhookProvider: "wecom",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ errcode: 0, errmsg: "ok" });
    }
  });

  webhook.publish({
    direction: "inbound",
    id: "message-1",
    senderId: "alice",
    text: "hello",
    attachments: [{ kind: "image", label: "photo.png" }]
  });

  assert.deepEqual(requestBody, {
    msgtype: "text",
    text: {
      content: [
        "[Codex Channel Bridge] 收到消息",
        "渠道: feishu",
        "内容: hello",
        "附件: photo.png"
      ].join("\n")
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
});

test("omits the recipient when adapting outbound events for each selectable webhook provider", async () => {
  const message = {
    direction: "outbound" as const,
    id: "message-2",
    recipientId: "bob",
    text: "build passed",
    attachments: [{ kind: "file" as const, label: "report.txt" }]
  };
  const expectedText = [
    "[Codex Channel Bridge] 发出消息",
    "渠道: weixin",
    "内容: build passed",
    "附件: report.txt"
  ].join("\n");
  const cases = [
    {
      provider: "feishu" as const,
      response: Response.json({ code: 0, msg: "success" }),
      payload: { msg_type: "text", content: { text: expectedText } }
    },
    {
      provider: "dingtalk" as const,
      response: Response.json({ errcode: 0, errmsg: "ok" }),
      payload: { msgtype: "text", text: { content: expectedText }, at: { isAtAll: false } }
    },
    {
      provider: "slack" as const,
      response: new Response("ok"),
      payload: { text: expectedText }
    },
    {
      provider: "discord" as const,
      response: new Response(null, { status: 204 }),
      payload: { content: expectedText }
    }
  ];

  for (const testCase of cases) {
    let requestBody: unknown;
    const webhook = new ChannelMessageWebhook({
      accountId: "account-one",
      channel: "weixin",
      webhookUrl: "https://hooks.example.test/team",
      webhookProvider: testCase.provider,
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return testCase.response;
      }
    });

    webhook.publish(message);
    assert.deepEqual(requestBody, testCase.payload, testCase.provider);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("auto-detects known webhook providers for saved configurations without a provider", () => {
  let requestBody: unknown;
  const webhook = new ChannelMessageWebhook({
    accountId: "account-one",
    channel: "weixin",
    webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ code: 0, msg: "success" });
    }
  });

  webhook.publish({
    direction: "inbound",
    id: "message-1",
    senderId: "alice",
    text: "hello",
    attachments: []
  });

  assert.deepEqual(requestBody, {
    msg_type: "text",
    content: {
      text: [
        "[Codex Channel Bridge] 收到消息",
        "渠道: weixin",
        "内容: hello"
      ].join("\n")
    }
  });
});

test("reports an Enterprise WeChat business error returned with HTTP 200", async (context) => {
  const warnings: unknown[][] = [];
  context.mock.method(console, "warn", (...arguments_: unknown[]) => {
    warnings.push(arguments_);
  });
  const webhook = new ChannelMessageWebhook({
    accountId: "account-one",
    channel: "feishu",
    webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
    fetch: async () => Response.json({ errcode: 40008, errmsg: "invalid message type" })
  });

  webhook.publish({
    direction: "inbound",
    id: "message-1",
    senderId: "alice",
    text: "hello",
    attachments: []
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings[0]), /40008.*invalid message type/);
});
