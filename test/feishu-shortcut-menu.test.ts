import assert from "node:assert/strict";
import test from "node:test";

import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import type { FeishuAccount } from "../src/weixin/accounts.js";
import type { NormalizedWeixinMessage } from "../src/weixin/messages.js";

function account(): FeishuAccount {
  return {
    channel: "feishu",
    accountId: "feishu-test",
    appId: "cli_test",
    appSecret: "secret",
    savedAt: "2026-08-08T00:00:00.000Z",
    enabled: true
  };
}

test("routes a native Feishu bot menu event into its matching workbench action", async () => {
  let dispatcher: { handles: Map<string, (event: unknown) => unknown> } | undefined;
  const inbound: NormalizedWeixinMessage[] = [];
  const adapter = new FeishuChannelAdapter(account(), {
    apiClient: {
      im: { v1: {
        image: { async create() { return { image_key: "unused" }; } },
        message: { async create() { return { data: { message_id: "unused" } }; } },
        messageResource: { async get() { throw new Error("not used"); } }
      } }
    },
    wsClient: {
      async start(input) { dispatcher = input.eventDispatcher; },
      close() {}
    }
  });
  const controller = new AbortController();
  const monitor = adapter.monitor({
    signal: controller.signal,
    async onMessage(message) { inbound.push(message); }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(dispatcher);

  await dispatcher.handles.get("application.bot.menu_v6")?.({
    event_id: "menu-event",
    operator: { operator_id: { open_id: "ou_operator" } },
    event_key: "codex.taskboard"
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await monitor;

  assert.deepEqual(inbound, [{
    id: "feishu-menu:menu-event",
    senderId: "ou_operator",
    replyTargetId: "ou_operator",
    source: "native-menu",
    text: "/task",
    attachments: [],
    raw: {
      channel: "feishu",
      event: {
        event_id: "menu-event",
        operator: { operator_id: { open_id: "ou_operator" } },
        event_key: "codex.taskboard"
      }
    }
  }]);
});
