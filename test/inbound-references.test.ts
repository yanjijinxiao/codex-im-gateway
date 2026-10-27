import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeDingTalkInbound } from "../src/channels/dingtalk-inbound.js";
import { InboundReferenceStore, referenceContext } from "../src/bridge/inbound-references.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { normalizeWeixinMessage } from "../src/weixin/messages.js";
import { responseBytes } from "../src/channels/inbound-bytes.js";
import type { ChannelMessage } from "../src/channels/message.js";
import { BridgeService } from "../src/bridge/service.js";

for(const raw of ["{invalid", "{}", '[{"conversationId":"chat","messageId":"original","text":"unsafe","at":1,"attachments":{}}]'])
test("corrupt optional reference caches preserve evidence without blocking an account",t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"reference-corruption-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,"cache.json");fs.writeFileSync(file,raw);
 const cache=new InboundReferenceStore(file),preserved=fs.readdirSync(dir).find(name=>name.endsWith(".corrupt"));
 assert.ok(preserved);assert.equal(fs.readFileSync(path.join(dir,preserved),"utf8"),raw);
 const message:ChannelMessage={id:"reply",senderId:"actor",replyTargetId:"chat",text:"read quote",raw:{},references:[{messageId:"original",type:"text",attachments:[],availability:"metadata-only"}]};
 assert.equal(cache.resolve(message).references![0].availability,"metadata-only");
 cache.remember({...message,id:"new",text:"new reference"},[]);
 assert.equal(JSON.parse(fs.readFileSync(file,"utf8"))[0].messageId,"new");
});
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

test("DingTalk separates current command from a quoted file and keeps credentials opaque", () => {
  const decoded = decodeDingTalkInbound({ msgtype: "text", text: { content: "你能看吗？", repliedMsg: {
    msgType: "file", msgId: "original", content: JSON.stringify({ fileName: "MCT.md", downloadCode: "private-download-code" })
  } } });
  assert.equal(decoded.text, "你能看吗？");
  assert.equal(decoded.references[0].attachments[0].kind, "file");
  assert.equal(decoded.references[0].attachments[0].sourceMessageId, "original");
  assert.doesNotMatch(referenceContext({ ...decoded, id: "reply", senderId: "actor", raw: {} }), /private-download-code/);
  const quoted = decodeDingTalkInbound({ msgtype: "text", text: { content: "解释", repliedMsg: {
    msgType: "text", content: { text: "/stop" }
  } } });
  assert.equal(quoted.text, "解释");
  assert.equal(quoted.references[0].text, "/stop");
});

test("DingTalk reports unavailable quoted files honestly and decodes direct files/links", () => {
  const file = decodeDingTalkInbound({ msgtype: "file", content: { fileName: "MCT.md", downloadCode: "secret" } });
  assert.equal(file.attachments[0].label, "MCT.md");
  const missing = decodeDingTalkInbound({ msgtype: "text", text: { content: "阅读", repliedMsg: {
    msgType: "file", msgId: "missing", content: { fileName: "MCT.md", fileId: "not-downloadable" }
  } } });
  assert.equal(missing.references[0].availability, "metadata-only");
  assert.match(missing.references[0].reason!, /下载凭据/);
  const card = decodeDingTalkInbound({ msgtype: "interactiveCard", content: { title: "文档", biz_custom_action_url: "https://example.com/doc" } });
  assert.match(card.text, /https:\/\/example.com\/doc/);
});

test("account reference cache survives reload and never leaks across conversations or stores tokens", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reference-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "cache.json");
  const message: ChannelMessage = { id: "original", senderId: "actor", replyTargetId: "chat", text: "说明", attachments: [], raw: {} };
  new InboundReferenceStore(filePath).remember(message, [{ kind: "file", label: "MCT.md", path: path.join(dir, "MCT.md"), item: { downloadCode: "TOKEN" } }]);
  const cache = new InboundReferenceStore(filePath);
  const reply = { ...message, id: "reply", references: [{ messageId: "original", type: "file", attachments: [], availability: "metadata-only" as const }] };
  assert.equal(cache.resolve(reply).references![0].attachments[0].sourceMessageId, "original");
  assert.equal(cache.resolve({ ...reply, replyTargetId: "other-chat" }).references![0].availability, "metadata-only");
  assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /TOKEN/);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("shared client resolves both direct and quoted media once, including Weixin mixed replies", async () => {
  const image = { type: 2, image_item: { media: { encrypt_query_param: "image" } } };
  const message = normalizeWeixinMessage({ from_user_id: "actor", message_id: "new", item_list: [
    image, { type: 1, text_item: { text: "比较" }, ref_msg: { message_id: "old", message_item: image } }
  ] })!;
  let count = 0;
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, inbound: { ...TEXT_CAPABILITIES.inbound, image: "available" } }, {
    async sendText() { return { messageId: "unused" }; },
    async resolveAttachments(value) { count = value.attachments.length; assert.equal(value.references?.length, 0); return value.attachments; }
  });
  await client.resolveAttachments(message);
  assert.equal(count, 2);
});

test("streaming downloads enforce the limit even without Content-Length", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }));
  await assert.rejects(responseBytes(response, 1500), /1500/);
  assert.equal(cancelled, true);
});

test("Bridge checks actor ACL before reference reads/downloads and stages quoted files for the selected remote backend", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-reference-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "MCT.md");
  fs.writeFileSync(file, "Inventory 完整正文");
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = store.createProject("remote", root, { hostId: "remote-ssh-discovered:test-host", projectKind: "remote" });
  store.createSession("chat", root, "bound", project.id);
  let referenceReads = 0, downloads = 0, stages = 0;
  const prompts: string[] = [];
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, inbound: { ...TEXT_CAPABILITIES.inbound, file: "available" } }, {
    async sendText() { return { messageId: "reply" }; },
    async resolveReferences(message) { referenceReads++; return message; },
    async resolveAttachments(message) { downloads++; return message.attachments.map(item => ({ ...item, path: file, item: {} })); }
  });
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, stateStore: store,
    channel: client, inboundDir: root, inboundReferences: new InboundReferenceStore(path.join(root, "references.json")),
    runner: {
      async stageAttachments(files, options) {
        stages++; assert.equal(options.hostId, "remote-ssh-discovered:test-host");
        assert.equal(files[0].path, fs.realpathSync(file)); return files.map(item => ({ ...item, path: "/remote/inbound/MCT.md" }));
      },
      async run(input) { prompts.push(input.prompt); return { text: "已读取", raw: "", threadId: "thread" }; },
      async stop() {},
      async getRuntimeInfo() { return {}; }
    } as never
  });
  const decoded = decodeDingTalkInbound({ msgtype: "text", text: { content: "读取这份文件", repliedMsg: {
    msgType: "file", msgId: "original", content: { fileName: "MCT.md", downloadCode: "secret" }
  } } });
  await service.handleMessage({ ...decoded, id: "blocked", senderId: "intruder", replyTargetId: "chat", raw: {} });
  assert.equal(referenceReads + downloads + stages, 0);
  await service.handleMessage({ ...decoded, id: "allowed", senderId: "actor", replyTargetId: "chat", raw: {} });
  assert.equal(downloads, 1); assert.equal(stages, 1);
  assert.match(prompts[0], /用户引用/);
  assert.match(prompts[0], /\/remote\/inbound\/MCT.md/);
  assert.doesNotMatch(prompts[0], /secret|Users\/|bridge-reference-/);
});
