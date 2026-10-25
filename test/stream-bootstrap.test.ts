import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelTurnTextStream } from "../src/channels/progress.js";
import type { ChannelStreamCheckpoint } from "../src/channels/progress.js";
import type { ChannelStreamBootstrap } from "../src/channels/stream-bootstrap.js";
import { DingTalkChannelAdapter, DingTalkHttpsAICardClient } from "../src/channels/dingtalk.js";
import { DingTalkCardRouting } from "../src/channels/dingtalk-card-routing.js";
import { assertDingTalkCardMutationSucceeded, DingTalkCardMutationError } from "../src/channels/dingtalk-card-response.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { formatFollowStatus } from "../src/bridge/session-follow.js";
import { migrateCardBootstrap } from "../src/server/migrate-card-bootstrap.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";

const account = { channel: "dingtalk" as const, accountId: "test", clientId: "app", clientSecret: "SECRET",
  cardTemplateId: "template", savedAt: "", enabled: true };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function provider() {
  let rejected = true, uncertain = false;
  const calls: Array<{ url: string; body: any }> = [];
  const client = () => new DingTalkHttpsAICardClient(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const deliver = String(url).endsWith("/deliver");
    const result = init?.method === "POST" ? deliver ? [{ success: true }] : "instance" : true;
    return new Response(JSON.stringify(deliver && rejected
      ? uncertain ? {} : { success: true, result: [{ success: false, errorMsg: "RecipientRejected" }], requestId: "request-rejected" }
      : { success: true, result }), { status: 200 });
  }, [0], async () => {});
  const routing = new DingTalkCardRouting("app"); routing.remember("cid-private", "1", "staff", "app");
  const adapter = (restoreRoute = true) => new DingTalkChannelAdapter(account, {
    streamClient: { async getAccessToken() { return "TOKEN"; } } as never, cardClient: client(),
    ...(restoreRoute ? { cardRouting: routing } : {}) });
  return { calls, adapter, setRejected(value: boolean) { rejected = value; }, setUncertain() { uncertain = true; } };
}

test("created-but-rejected delivery persists each phase and force sync resumes only the original instance", async t => {
  const io = provider(); const phases: string[] = [];
  let checkpoint!: ChannelStreamCheckpoint;
  const stream = new ChannelTurnTextStream(io.adapter().client, "cid-private", { save: value => { checkpoint = value; phases.push(value.bootstrap?.stage ?? "intent"); } });
  t.after(() => stream.suspend());
  await stream.progress("当前进展");
  assert.equal(checkpoint.bootstrap?.stage, "delivery-rejected");
  assert.equal(checkpoint.bootstrap?.failure?.code, "RecipientRejected");
  assert.equal(checkpoint.bootstrap?.failure?.uncertain, false);
  assert.equal(checkpoint.messageId, undefined);
  assert.ok(phases.includes("created")); assert.ok(phases.includes("delivery-pending"));
  assert.equal(io.calls.filter(call => !call.url.endsWith("/deliver")).length, 1, "no update before delivery receipt");
  await stream.suspend();
  io.setRejected(false);
  const restored = new ChannelTurnTextStream(io.adapter(false).client, "cid-private", { restore: checkpoint, save: value => { checkpoint = value; } });
  t.after(() => restored.suspend());
  assert.equal(await restored.synchronize(), "updated");
  assert.equal(checkpoint.bootstrap?.stage, "delivered");
  assert.equal(io.calls.filter(call => call.url.endsWith("/instances") && call.body.cardTemplateId).length, 1);
  const deliveries = io.calls.filter(call => call.url.endsWith("/deliver"));
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every(call => call.body.outTrackId === checkpoint.streamId));
  assert.ok(deliveries.every(call => call.body.openSpaceId === "dtv1.card//IM_ROBOT.staff"), "CID must not imply group");
});

test("unknown delivery is never replayed on restart or ordinary sync; explicit confirmation retries exactly that instance", async t => {
  const io = provider(); io.setUncertain();
  const stream = new ChannelTurnTextStream(io.adapter().client, "cid-private");
  t.after(() => stream.suspend()); await stream.progress("开始");
  assert.equal(stream.checkpoint().bootstrap?.stage, "delivery-unconfirmed");
  const restored = new ChannelTurnTextStream(io.adapter(false).client, "cid-private", { restore: stream.checkpoint(), save() {} });
  t.after(() => restored.suspend());
  const before = io.calls.length;
  assert.equal(await restored.synchronize(), "unavailable"); assert.equal(io.calls.length, before);
  io.setRejected(false);
  assert.equal(await restored.synchronize({ confirmUncertainDelivery: true }), "updated");
  assert.equal(io.calls.filter(c => c.body.cardTemplateId).length, 1);
  assert.equal(io.calls.filter(c => c.url.endsWith("/deliver")).length, 2);
});

test("delivery sub-results with explicit false are rejections, not ambiguous business acknowledgements", () => {
  assert.throws(() => assertDingTalkCardMutationSucceeded("deliver", { statusCode: 200,
    body: { success: true, result: [{ success: false, errorMsg: "SECRET with https://token" }], requestId: "safe-request" } }), error => {
    assert.ok(error instanceof DingTalkCardMutationError); assert.equal(error.uncertain, false);
    assert.equal(error.code, "DeliveryRejected"); assert.doesNotMatch(error.message, /SECRET|https/); return true;
  });
  assert.throws(() => assertDingTalkCardMutationSucceeded("deliver", { statusCode: 200,
    body: { success: true, result: [{ success: true }, { success: false }] } }), error => {
    assert.ok(error instanceof DingTalkCardMutationError); assert.equal(error.uncertain, true); return true;
  });
});

test("failed continuation delivery recovers its own instance without recreating acknowledged pages", async t => {
  const creates: string[] = [], deliveries: string[] = [];
  let reject = true;
  const cardClient = new DingTalkHttpsAICardClient(async (url, init) => {
    const body = JSON.parse(String(init?.body)); const deliver = String(url).endsWith("/deliver");
    if (init?.method === "POST") { if (deliver) deliveries.push(body.outTrackId); else creates.push(body.outTrackId); }
    const rejected = deliver && body.outTrackId.endsWith("_page_2") && reject;
    return new Response(JSON.stringify(rejected ? { success: true, result: [{ success: false, code: "RecipientRejected" }] }
      : { success: true, result: init?.method === "POST" ? deliver ? [{ success: true }] : "instance" : true }), { status: 200 });
  }, [0], async () => {});
  const routes = new DingTalkCardRouting("app"); routes.remember("chat", "1", "staff", "app");
  const adapter = new DingTalkChannelAdapter(account, { cardRouting: routes, cardClient, streamClient: { async getAccessToken() { return "TOKEN"; } } as never });
  const client = { ...adapter.client, capabilities: { ...adapter.client.capabilities, resultPageBytes: 1024 } };
  const stream = new ChannelTurnTextStream(client, "chat"); t.after(() => stream.suspend());
  const text = "完整结果内容\n".repeat(120);
  assert.equal(await stream.finalize(text), false);
  assert.equal(stream.checkpoint().terminalPages?.[1].bootstrap?.stage, "delivery-rejected");
  reject = false;
  assert.equal(await stream.finalize(text, false, { recoverBootstrap: true }), true);
  assert.equal(creates.filter(id => id.endsWith("_page_2")).length, 1);
  assert.equal(deliveries.filter(id => id.endsWith("_page_2")).length, 2);
});

test("terminal delivery recovery uses the same bootstrap and does not need a Gateway restart", async t => {
  const io = provider(); const stream = new ChannelTurnTextStream(io.adapter().client, "cid-private");
  t.after(() => stream.suspend());
  await stream.progress("开始"); assert.equal(await stream.finalize("最终回复"), false);
  io.setRejected(false);
  assert.equal(await stream.finalize("最终回复", false, { recoverBootstrap: true }), true);
  assert.equal(io.calls.filter(call => call.body.cardTemplateId).length, 1);
  assert.equal(io.calls.filter(call => call.url.endsWith("/deliver")).length, 2);
});

test("bootstrap cannot resume a different recipient or account", async () => {
  const io = provider(); const stream = new ChannelTurnTextStream(io.adapter().client, "cid-private");
  await stream.progress("开始"); const bootstrap = stream.checkpoint().bootstrap!; await stream.suspend();
  const count = io.calls.length;
  await assert.rejects(io.adapter(false).client.resumeTextStream({ toUserId: "other", streamId: bootstrap.instanceId, bootstrap, text: "wrong" }), /progress unavailable/);
  const alien = { ...bootstrap, adapterData: { ...bootstrap.adapterData, accountId: "another" } } as ChannelStreamBootstrap;
  await assert.rejects(io.adapter(false).client.resumeTextStream({ toUserId: "cid-private", streamId: alien.instanceId, bootstrap: alien, text: "wrong" }), /progress unavailable/);
  assert.equal(io.calls.length, count);
});

test("public routes survive restart without persisting webhooks, text or access tokens", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-route-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "routing.json"); const routes = new DingTalkCardRouting("app", filePath);
  routes.remember("cid-private", "1", "staff", "app"); routes.remember("cid-group", "2", "staff", "app");
  const restored = new DingTalkCardRouting("app", filePath);
  assert.equal(restored.get("cid-private")?.type, "user"); assert.equal(restored.get("cid-private")?.targetId, "staff");
  assert.equal(restored.get("cid-group")?.type, "group");
  assert.equal(new DingTalkCardRouting("another-app", filePath).get("cid-group"), undefined);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /webhook|accessToken|sessionWebhook|SECRET/);
});

test("unknown routing causes no create mutation and does not guess a group from CID", async () => {
  const io = provider(); const stream = new ChannelTurnTextStream(io.adapter(false).client, "cid-private");
  assert.equal(io.adapter(false).client.deliveryRouteStatus("cid-private"),"unconfirmed");
  assert.equal(io.adapter().client.deliveryRouteStatus("cid-private"),"available");
  await stream.progress("开始"); assert.equal(io.calls.length, 0);
  assert.equal(stream.checkpoint().bootstrap?.stage, "create-rejected");
  assert.equal(stream.checkpoint().bootstrap?.failure?.code, "RouteUnconfirmed");
  await stream.suspend();
});

test("slow old final recovery cannot block force-sync of a current running turn", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "follow-old-final-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "follow.json");
  const saved = { streamId: "old-card", messageId: "old-card", creationAttempted: true, startedAt: Date.now(), progressEntries: [],
    thought: "", answerPreview: "", finished: false, terminal: { text: "old answer", error: false } };
  fs.writeFileSync(filePath, JSON.stringify({ binding: { eventVersion: 2, deliveryVersion: 1, hostId: "local", threadId: "thread",
    turnId: "old-turn", checkpointTurnId: "old-turn", checkpoint: saved, terminalPending: { turnId: "old-turn", text: "old answer", fallbackSent: false },
    initialized: true, sequence: 0, delivered: [], completed: [], baseline: [] } }));
  let release!: () => void; const stalled = new Promise<void>(resolve => { release = resolve; });
  const writes: string[] = [];
  const sub: ThreadSubscription = { key: "binding", threadId: "thread", hostId: "local", recipientId: "chat", managed: false,
    client: { resumableTextStream: true, async sendText() { return { messageId: "text" }; },
      async startTextStream() { return { messageId: "current-card" }; },
      async updateTextStream(input) { writes.push(input.messageId); if (input.messageId === "old-card") await stalled; } } };
  const hub = new ThreadEventHub({ filePath, subscriptions: () => [sub], backend: () => ({ async readThreadSnapshot() {
    return { state: { threadId: "thread", persistence: "active", runtimeStatus: "active", activeTurnId: "current", activeFlags: [] },
      turns: [{ id: "current", status: "inProgress", messages: [{ id: "progress", role: "assistant", kind: "progress", text: "current progress" }] }] };
  } }) });
  t.after(async () => { release(); await hub.stop(); });
  const synced = await hub.synchronize("binding");
  assert.equal(synced.status, "synced"); assert.equal(synced.presentation, "updated");
  assert.equal(synced.resultDelivery?.pending, 1); assert.ok(writes.includes("current-card")); assert.ok(writes.includes("old-card"));
  assert.doesNotMatch(formatFollowStatus(synced).join("\n"), /同步失败/);
  release(); await tick();
  assert.equal(hub.status("binding").resultDelivery?.pending, 0);
});

test("legacy migration restores acknowledged creation only, retains unknown deliveries and never changes a binding", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-migration-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root); saveAccount(paths, account); fs.mkdirSync(path.join(paths.runtimeDir, "test"), { recursive: true });
  fs.writeFileSync(path.join(paths.runtimeDir, "test", "state.json"), JSON.stringify({ sessions: [{ id: "session", senderId: "chat" }] }));
  const id = "codex_bridge_original";
  const checkpoint = { streamId: id, creationAttempted: true, startedAt: Date.now(), progressEntries: [], thought: "", answerPreview: "", finished: false };
  const state = { [JSON.stringify(["test", "session"])]: { threadId: "thread", checkpoint,
    pendingTerminals: { unknown: { checkpoint: { ...checkpoint, streamId: "codex_bridge_unknown" } } } } };
  const journal = path.join(paths.runtimeDir, "thread-subscriptions.json"); fs.writeFileSync(journal, JSON.stringify(state));
  fs.writeFileSync(path.join(root, "service.log"), `[codex-im-gateway] DingTalk AI Card ${JSON.stringify({ event: "api_acknowledged", operation: "create", httpStatus: 200, outTrackId: id })}\n`);
  migrateCardBootstrap(paths); const result = JSON.parse(fs.readFileSync(journal, "utf8"))[Object.keys(state)[0]];
  assert.equal(result.threadId, "thread"); assert.equal(result.checkpoint.bootstrap.stage, "delivery-unconfirmed");
  assert.equal(result.checkpoint.bootstrap.instanceId, id); assert.equal(result.checkpoint.messageId, undefined);
  assert.equal(result.pendingTerminals.unknown.checkpoint.bootstrap, undefined);
  const before = fs.readFileSync(journal, "utf8"); migrateCardBootstrap(paths); assert.equal(fs.readFileSync(journal, "utf8"), before);
});
