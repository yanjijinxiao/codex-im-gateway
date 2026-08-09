import assert from "node:assert/strict";
import test from "node:test";

import { createChoiceCard } from "../src/channels/action-card.js";
import { feishuActionCard } from "../src/channels/feishu-action-card.js";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";

test("returns the Feishu v2 callback envelope for a replacement card instead of silently patching it", async () => {
  let dispatcher: { handles: Map<string, (event: unknown) => unknown> } | undefined;
  const patches: Array<Record<string, unknown>> = [];
  const adapter = new FeishuChannelAdapter({
    channel: "feishu",
    accountId: "feishu-test",
    appId: "cli_test",
    appSecret: "secret",
    savedAt: "2026-08-09T00:00:00.000Z",
    enabled: true
  }, {
    apiClient: {
      im: { v1: {
        image: { async create() { return { image_key: "unused" }; } },
        message: {
          async create() { return { data: { message_id: "unused" } }; },
          async patch(input: Record<string, unknown>) {
            patches.push(input);
            return { data: {} };
          }
        },
        messageResource: { async get() { throw new Error("not used"); } }
      } }
    },
    wsClient: {
      async start(input) { dispatcher = input.eventDispatcher; },
      close() {}
    }
  });
  const replacement = createChoiceCard({
    title: "选择会话",
    body: "请选择要继续的会话。",
    fallbackText: "请选择要继续的会话。",
    choices: [{ label: "会话一", command: "session", arg: "R1", style: "primary" }]
  });
  const controller = new AbortController();
  const monitor = adapter.monitor({
    signal: controller.signal,
    async onMessage(message) {
      if (message.interaction?.kind !== "card") throw new Error("expected a card interaction");
      await adapter.updateActionCard({ messageId: message.interaction.messageId, card: replacement });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(dispatcher);

  const response = await dispatcher.handles.get("card.action.trigger")?.({
    token: "callback-token",
    context: { open_message_id: "card-message", open_chat_id: "oc_test" },
    operator: { open_id: "ou_operator" },
    action: { tag: "button", value: { version: 1, command: "sessions", arg: "" } }
  });
  controller.abort();
  await monitor;

  assert.deepEqual(response, {
    card: {
      type: "raw",
      data: feishuActionCard(replacement)
    }
  });
  assert.equal(patches.length, 0);
});
