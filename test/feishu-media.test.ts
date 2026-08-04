import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

test("Feishu uploads a local image and sends its image key to the target chat", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-image-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "result.png");
  fs.writeFileSync(imagePath, Buffer.from("image bytes"));
  const uploads: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const adapter = new FeishuChannelAdapter({
    channel: "feishu",
    accountId: "feishu-test",
    appId: "cli_test",
    appSecret: "secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    apiClient: {
      im: {
        v1: {
          image: {
            async create(input: Record<string, unknown>) {
              uploads.push(input);
              return { image_key: "img_test" };
            }
          },
          message: {
            async create(input: Record<string, unknown>) {
              messages.push(input);
              return { data: { message_id: "message-test" } };
            }
          }
        }
      }
    },
    wsClient: {
      async start() {},
      close() {}
    }
  });

  const sent = await adapter.sendImage({ toUserId: "oc_test", path: imagePath });

  assert.deepEqual(sent, { messageId: "message-test" });
  assert.equal(uploads.length, 1);
  assert.equal((uploads[0].data as { image_type?: string }).image_type, "message");
  assert.ok(Buffer.isBuffer((uploads[0].data as { image?: unknown }).image));
  assert.deepEqual(messages, [{
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: "oc_test",
      msg_type: "image",
      content: JSON.stringify({ image_key: "img_test" })
    }
  }]);
});

test("Bridge sends a local Markdown image through a channel image capability", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-image-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "result.png");
  fs.writeFileSync(imagePath, Buffer.from("image bytes"));
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  store.createProject("Test", root);
  const images: Array<{ toUserId: string; path: string }> = [];
  const replies: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] },
    stateStore: store,
    weixin: {
      async sendText(input) {
        replies.push(input.text);
        return { messageId: "text-message" };
      },
      async sendImage(input) {
        images.push(input);
        return { messageId: "image-message" };
      }
    },
    runner: {
      async run() {
        return { raw: "", text: `![result.png](${imagePath})` };
      },
      async stop() {}
    }
  });

  await service.handleMessage({ id: "message-1", senderId: "oc_test", text: "发图片", raw: {} });

  assert.deepEqual(images, [{ toUserId: "oc_test", path: imagePath }]);
  assert.equal(replies.some((reply) => reply.includes("暂不支持直接发送")), false);
});

test("Feishu downloads an inbound image before forwarding it to Bridge", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-inbound-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let dispatcher: { handles: Map<string, (event: unknown) => unknown> } | undefined;
  const resourceRequests: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const messages: Array<{ attachments: Array<{ kind: string; path?: string }> }> = [];
  const adapter = new FeishuChannelAdapter({
    channel: "feishu",
    accountId: "feishu-test",
    appId: "cli_test",
    appSecret: "secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    inboundDir: root,
    apiClient: {
      im: {
        v1: {
          image: { async create() { return { image_key: "unused" }; } },
          message: { async create() { return { data: { message_id: "unused" } }; } },
          messageResource: {
            async get(input: Record<string, unknown>) {
              resourceRequests.push(input);
              return {
                async writeFile(filePath: string) {
                  fs.writeFileSync(filePath, Buffer.from("downloaded image"));
                },
                getReadableStream() { throw new Error("not used"); },
                headers: {}
              };
            }
          }
        }
      }
    },
    wsClient: {
      async start(input) {
        dispatcher = input.eventDispatcher;
      },
      close() {}
    }
  });
  const monitor = adapter.monitor({
    signal: controller.signal,
    async onMessage(message) {
      messages.push(message);
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(dispatcher);

  await dispatcher.handles.get("im.message.receive_v1")?.({
    message: {
      message_id: "om_test",
      chat_id: "oc_test",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_inbound" })
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await monitor;

  assert.deepEqual(resourceRequests, [{
    params: { type: "image" },
    path: { message_id: "om_test", file_key: "img_inbound" }
  }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].attachments[0].kind, "image");
  assert.ok(messages[0].attachments[0].path);
  assert.equal(fs.readFileSync(messages[0].attachments[0].path, "utf8"), "downloaded image");
});

test("Bridge includes a downloaded channel image in the Codex prompt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-inbound-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "inbound.png");
  fs.writeFileSync(imagePath, Buffer.from("image bytes"));
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  store.createProject("Test", root);
  const prompts: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] },
    stateStore: store,
    inboundDir: root,
    weixin: {
      async sendText() {
        return { messageId: "text-message" };
      }
    },
    runner: {
      async run(input) {
        prompts.push(input.prompt);
        return { raw: "", text: "收到图片" };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "message-1",
    senderId: "oc_test",
    text: "分析图片",
    attachments: [{ kind: "image", label: "inbound.png", item: {}, path: imagePath }],
    raw: {}
  });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /inbound\.png/);
  assert.match(prompts[0], new RegExp(imagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(prompts[0], /Attachment download failed/);
});
