import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import { DingTalkCardRouting } from "../src/channels/dingtalk-card-routing.js";
import type { ChannelMessage } from "../src/channels/message.js";

test("Feishu durable admission receives decoded text and file keys, before execution and without downloading", async () => {
  let dispatcher: any; const admitted: ChannelMessage[] = [], handled: ChannelMessage[] = [];
  const adapter = new FeishuChannelAdapter({ channel: "feishu", accountId: "one", appId: "synthetic", appSecret: "synthetic" } as never,
    { apiClient: { im: { v1: { message: {} } } } as never, wsClient: { async start(input) { dispatcher = input.eventDispatcher; }, close() {} } });
  const abort = new AbortController(); const monitor = adapter.monitor({ signal: abort.signal,
    claimMessage: message => { admitted.push(structuredClone(message)); return true; }, async onMessage(message) { handled.push(message); } });
  try {
    await new Promise<void>(r => setImmediate(r));
    for (const [message_type, content] of [["text", JSON.stringify({ text: "durable text" })], ["file", JSON.stringify({ file_key: "file-key", file_name: "input.txt" })]])
      await dispatcher.handles.get("im.message.receive_v1")({ sender: { sender_id: { open_id: "actor" } },
        message: { message_id: `message-${message_type}`, chat_id: "room", chat_type: "group", message_type, content } });
    assert.equal(admitted[0].text, "durable text"); assert.equal(admitted[1].attachments[0].item.fileKey, "file-key");
    assert.equal(handled.length, 2); assert.equal(admitted[1].attachments[0].path, undefined);
  } finally { abort.abort(); await monitor; }
});

test("DingTalk resumes attachment download from durable public routing without an old callback or session webhook", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-forwarding-dingtalk-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "routing.json"), routing = new DingTalkCardRouting("synthetic-client", file);
  routing.remember("room", "2", "actor", "actual-robot");
  const calls: any[] = [];
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "one", clientId: "synthetic-client", clientSecret: "synthetic" } as never, {
    inboundDir: root, cardRouting: new DingTalkCardRouting("synthetic-client", file),
    streamClient: { async getAccessToken() { return "synthetic"; } } as never,
    mediaClient: { async download(input) { calls.push(input); return { buffer: Buffer.from("saved attachment"), contentType: "application/octet-stream" }; } }
  });
  const files = await adapter.resolveAttachments({ id: "source", senderId: "actor", replyTargetId: "room", text: "file", raw: {},
    attachments: [{ kind: "file", label: "input.txt", item: { downloadCode: "saved-code" } }] });
  assert.equal(calls.length, 1); assert.equal(calls[0].robotCode, "actual-robot"); assert.equal(calls[0].downloadCode, "saved-code");
  assert.equal(fs.readFileSync(files[0].path!, "utf8"), "saved attachment");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /sessionWebhook|saved-code|saved attachment/);
});
