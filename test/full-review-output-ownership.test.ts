import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { AccountManager } from "../src/server/account-manager.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { saveAccount } from "../src/weixin/accounts.js";
function fixture(t: test.TestContext, hostId = "local") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-review-output-owner-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(paths), session = store.createSession("chat", root, "Task", undefined, "session", undefined, { standalone: true, hostId });
  store.setSessionThread(session.id, "thread"); const media: string[] = [], text: string[] = []; let send = async (_file: string) => {};
  const channel = createChannelClient("generic", { ...TEXT_CAPABILITIES, outbound: { ...TEXT_CAPABILITIES.outbound, file: "available" } }, {
    async sendText(input) { text.push(input.text); return { messageId: "text" }; },
    async sendMedia(input) { media.push(input.path); await send(input.path); return { messageId: "media" }; }
  });
  const service = new BridgeService({ stateStore: store, config: defaultConfig(root), channel, runner: {} as never });
  return { root, paths, store, session, service, media, text, setSend(value: typeof send) { send = value; } };
}
const actions = (send: string[]) => "Result\n\n```codex-im-gateway-actions\n" + JSON.stringify({ send: send.map(path => ({ type: "file", path })), remember: [{ kind: "knowledge", scope: "account", title: "Synthetic fact", content: "Synthetic value" }] }) + "\n```";
test("recovery output rejects a native thread or host different from its current managed binding", async t => {
  const f = fixture(t);
  for (const scope of [{ hostId: "local", threadId: "other" }, { hostId: "remote", threadId: "thread" }])
    await f.service.applyRecoveredOutput(f.session.id, actions([path.join(f.root, "file")]), scope);
  assert.equal(f.media.length, 0); assert.equal(f.store.listKnowledge().length, 0);
});
test("recovered media rechecks native binding generation between asynchronous sends", async t => {
  const f = fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.setSend(async () => { entered.resolve(); await release.promise; });
  const pending = f.service.applyRecoveredOutput(f.session.id, actions(["/first", "/second"]), { hostId: "local", threadId: "thread" });
  await entered.promise; f.store.setSessionThread(f.session.id, "replacement"); release.resolve(); await pending;
  assert.deepEqual(f.media, ["/first"]);
});
test("remote action paths never cause the local channel to read an identically named local file", async t => {
  const f = fixture(t, "remote"), file = path.join(f.root, "same-name.txt"); fs.writeFileSync(file, "LOCAL-ONLY");
  await f.service.applyRecoveredOutput(f.session.id, actions([file]), { hostId: "remote", threadId: "thread" });
  assert.equal(f.media.length, 0); assert.match(f.text.at(-1)!, /远程/);
});
test("remote history cannot expose a same-path local file as a downloadable attachment", async t => {
  const f = fixture(t), file = path.join(f.root, "same-name.txt"); fs.writeFileSync(file, "LOCAL-ONLY");
  saveAccount(f.paths, { accountId: "one", token: "synthetic", baseUrl: "https://example.invalid", enabled: false });
  const manager = new AccountManager({ paths: f.paths, runnerFactory: () => ({ async warmUp() {}, async getHistory() { return [{ id: "message", role: "assistant", text: actions([file]) }]; }, close() {} }) as any });
  t.after(() => manager.stopAll()); const store = (manager as any).storeFor("one") as RuntimeStateStore;
  const session = store.createSession("remote-chat", "/remote", "Remote", undefined, "session", undefined, { standalone: true, hostId: "remote" }); store.setSessionThread(session.id, "remote-thread");
  const messages = await manager.getSessionMessages("one", session.id);
  assert.equal(messages[0].attachments[0].available, false); assert.equal(messages[0].attachments[0].size, undefined);
  await assert.rejects(manager.getSessionAttachment("one", session.id, "message", 0), /not found/);
});
for (const change of ["binding", "access", "newer-query"]) test(`a delayed IM history result is discarded after ${change}`, async t => {
  const f = fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); f.store.setPairedSenderIds(["chat"]);
  let reads = 0;
  (f.service as any).runner = { async getHistoryPage() { if (++reads === 1) { entered.resolve(); await release.promise; return { messages: [{ id: "old", role: "assistant", text: "STALE_HISTORY" }] }; }
    return { messages: [{ id: "new", role: "assistant", text: "FRESH_HISTORY" }] }; } };
  const pending = (f.service as any).handleHistoryCommand("chat", "1"); await entered.promise;
  if (change === "binding") f.store.setSessionThread(f.session.id, "replacement");
  if (change === "access") f.store.setPairedSenderIds([]);
  if (change === "newer-query") await (f.service as any).handleHistoryCommand("chat", "1");
  release.resolve(); await pending;
  assert.equal(f.text.some(text => text.includes("STALE_HISTORY")), false);
  if (change === "newer-query") assert.equal(f.text.filter(text => text.includes("FRESH_HISTORY")).length, 1);
});
