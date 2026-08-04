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

test("adapts channel events for an Enterprise WeChat incoming webhook", async () => {
  let requestBody: unknown;
  const webhook = new ChannelMessageWebhook({
    accountId: "account-one",
    channel: "feishu",
    webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
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
        "发送者: alice",
        "内容: hello",
        "附件: photo.png"
      ].join("\n")
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
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
