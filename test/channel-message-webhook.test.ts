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
