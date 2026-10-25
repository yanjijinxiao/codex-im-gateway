import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DingTalkCardRouting } from "../src/channels/dingtalk-card-routing.js";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

test("legacy routes survive upgrade; names are provider-only, persisted and isolated from staff aliases", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-conversation-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "routes.json");
  const legacy = new DingTalkCardRouting("app", file);
  legacy.remember("old-cid", "2", undefined, "app");
  const routes = new DingTalkCardRouting("app", file);
  assert.equal(routes.get("old-cid")?.name, undefined);
  routes.remember("group", "2", "staff", "app", { conversationName: "群聊 <tag>", actorName: "张三" });
  assert.equal(routes.get("group")?.name, "群聊 <tag>");
  assert.equal(routes.get("staff")?.name, "张三"); assert.equal(routes.get("staff")?.type, "user");
  routes.remember("group", "2", "staff", "app");
  assert.equal(routes.get("group")?.name, "群聊 <tag>"); assert.equal(routes.get("staff")?.name, "张三");
  routes.remember("group", "2", "other-staff", "app", { conversationName: "改名群" });
  assert.equal(routes.get("other-staff")?.name, undefined);
  const restored = new DingTalkCardRouting("app", file);
  assert.equal(restored.get("group")?.name, "改名群");
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", clientId: "app", clientSecret: "fake", accountId: "a", savedAt: "" } as never,
    { cardRouting: restored, streamClient: {} as never });
  assert.deepEqual(adapter.client.conversationIdentity("group"), { kind: "group", name: "改名群" });
  assert.deepEqual(adapter.client.conversationIdentity("staff"), { kind: "direct", name: "张三" });
  assert.equal(adapter.client.conversationIdentity("unknown-cid"), undefined);
  assert.equal(new DingTalkCardRouting("different-app", file).get("group"), undefined);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /clientSecret|sessionWebhook|accessToken/);
  for (const route of Object.values(JSON.parse(fs.readFileSync(file, "utf8")))) {
    assert.deepEqual(Object.keys(route as object).sort(), ["clientId", "robotCode", "targetId", "type"], "strict legacy routing readers remain compatible");
  }
  fs.writeFileSync(`${file}.identities.json`, "invalid display cache");
  const withoutNames = new DingTalkCardRouting("app", file);
  assert.equal(withoutNames.get("group")?.targetId, "group");
  assert.equal(withoutNames.get("group")?.name, undefined);
});

test("missing metadata never implies a direct chat or a name, and input labels are bounded", () => {
  const client = createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "sent" }; } });
  assert.equal(client.conversationIdentity("anything"), undefined);
  const routes = new DingTalkCardRouting("app");
  routes.remember("direct", "1", "actor", "app", { conversationName: "not-a-person", actorName: "\u0000" + "x".repeat(180) });
  assert.equal(routes.get("direct")?.name, "x".repeat(120));
  routes.remember("invalid", "unknown", "actor", "app", { conversationName: "not-trusted" });
  assert.equal(routes.get("invalid"), undefined);
});
