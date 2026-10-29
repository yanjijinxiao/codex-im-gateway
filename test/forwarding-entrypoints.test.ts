import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexRunnerInput } from "../src/codex/backend.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import type { ChannelMessage } from "../src/channels/message.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-forwarding-entry-")), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "one", userId: "actor", token: "synthetic", baseUrl: "https://example.invalid", enabled: false });
  const store = new RuntimeStateStore(accountStatePaths(paths, "one"));
  const session = store.createSession("room", root, "Original session", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(session.id, "thread");
  const writes: CodexRunnerInput[] = [], steers: any[] = [], replies: string[] = [], managers: AccountManager[] = [];
  let monitor: any, timeout = false, active = false, delayAcceptance = false, holdFinal = false;
  const entered = Promise.withResolvers<void>(), allowAcceptance = Promise.withResolvers<void>(), accepted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>(), steered = Promise.withResolvers<void>(), delivering = Promise.withResolvers<void>(), allowFinal = Promise.withResolvers<void>();
  const state = () => ({ threadId: "thread", persistence: "active", runtimeStatus: active ? "active" : "idle",
    activeFlags: [], projectMembership: "none", ...(active ? { activeTurnId: "turn-1" } : {}) });
  const backend = { executionLifetime: "independent", hasRestartBlockingWork: () => false,
    isIndependentObservation: () => active, detachIndependentObservations() {},
    backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
    async warmUp() {}, async listProjects() { return { backend: "app-server", projects: [] }; },
    async getRuntimeInfo() { return {}; }, async getHistory() { return []; },
    async inspectThread() { if (timeout) throw new CodexCommunicationError("preflight", "thread/read", "thread", undefined, Error("timeout")); return state(); },
    async readThreadSnapshot() { return { state: state(), turns: active ? [{ id: "turn-1", status: "inProgress", messages: [] }] : [] }; },
    async run(input: CodexRunnerInput) {
      writes.push(input); const turnId = `turn-${writes.length}`; entered.resolve();
      if (writes.length === 1 && delayAcceptance) await allowAcceptance.promise;
      active = true; await input.onTurnStarted?.({ threadId: "thread", turnId }); accepted.resolve();
      if (writes.length === 1) await finish.promise;
      active = false; return { threadId: "thread", turnId, text: "native result", raw: "" };
    },
    async steer(input: any) { steers.push(input); steered.resolve(); return { status: "accepted", threadId: "thread", turnId: "turn-1" }; },
    async addQueuedSubmission() { assert.fail("ordinary input was silently converted to native queue"); },
    async listQueuedSubmissions() { return { data: [] }; }, close() {} };
  const create = () => {
    const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: false, taskboardEnabled: false }),
      runnerFactory: () => backend as never, channelCapabilities: () => [],
      adapterFactory: () => ({ client: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) {
        replies.push(input.text); if (holdFinal && input.text.includes("native result")) { delivering.resolve(); await allowFinal.promise; }
        return { messageId: crypto.randomUUID() };
      } }), async monitor(options) { monitor = options; options.onStatus?.({ state: "connected" });
        await new Promise<void>(r => options.signal?.addEventListener("abort", () => r(), { once: true })); } }),
      codexSessionMonitorFactory: () => ({ start() {}, async stop() {} }) as never,
      codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} }) as never });
    managers.push(manager); return manager;
  };
  let manager = create();
  const message = (id: string, text: string): ChannelMessage => ({ id, text, senderId: "actor", replyTargetId: "room", attachments: [], raw: {} });
  const send = (id: string, text: string) => { const m = message(id, text); assert.equal(monitor.claimMessage(m), true); return monitor.onMessage(m); };
  t.after(async () => { finish.resolve(); allowAcceptance.resolve(); allowFinal.resolve();
    for (const m of managers) await m.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, store, session, writes, steers, replies, entered, allowAcceptance, accepted, finish, steered, delivering, allowFinal, send,
    get manager() { return manager; }, set timeout(value: boolean) { timeout = value; }, set delayAcceptance(value: boolean) { delayAcceptance = value; },
    set holdFinal(value: boolean) { holdFinal = value; },
    async start() { await manager.startAccount("one", false); },
    async restart() { await manager.stopAll(); manager = create(); await manager.startAccount("one", false); } };
}

test("a real inbound timeout saves the full message, keeps status responsive and later steers the accepted turn exactly once", { timeout: 20_000 }, async t => {
  const f = fixture(t); await f.start();
  const first = f.send("first", "start original work"); await f.accepted.promise;
  f.timeout = true; await f.send("second", "follow-up must reach the original turn");
  assert.equal(f.steers.length, 0); assert.equal(f.writes.length, 1);
  const saved = fs.readFileSync(path.join(f.paths.runtimeDir, "one", "forwarding-inbox.json"), "utf8");
  assert.match(saved, /follow-up must reach the original turn/); assert.match(f.replies.at(-1)!, /消息已保存/);
  await f.send("status", "/status"); assert.ok(f.replies.some(s => /消息转发：1 条已保存待转发/.test(s)));
  f.timeout = false; await f.steered.promise;
  assert.equal(f.steers.length, 1); assert.match(f.steers[0].prompt, /follow-up must reach the original turn/);
  assert.equal(f.steers[0].expectedTurnId, "turn-1");
  f.finish.resolve(); await first;
});

test("a burst during turn/start waits only for the acceptance handoff, then follows the normal steer policy", { timeout: 20_000 }, async t => {
  const f = fixture(t); f.delayAcceptance = true; await f.start();
  const first = f.send("first", "start"); await f.entered.promise;
  await f.send("second", "correction during native acceptance");
  assert.equal(f.writes.length, 1); assert.equal(f.steers.length, 0); assert.match(f.replies.at(-1)!, /消息已保存/);
  f.allowAcceptance.resolve(); await f.accepted.promise; await f.steered.promise;
  assert.equal(f.steers.length, 1); assert.equal(f.writes.length, 1);
  f.finish.resolve(); await first;
});

test("a finished native turn with a slow result delivery does not falsely reject the next input as still submitting", { timeout: 20_000 }, async t => {
  const f = fixture(t); f.holdFinal = true; await f.start();
  const first = f.send("first", "first"); await f.accepted.promise; f.finish.resolve(); await f.delivering.promise;
  const second = f.send("second", "next ordinary turn");
  await new Promise<void>(r => setImmediate(r));
  assert.ok(!f.replies.some(s => /上一条消息正在提交|请稍后发送/.test(s)));
  f.allowFinal.resolve(); await Promise.all([first, second]);
  assert.equal(f.writes.length, 2); assert.match(f.writes[1].prompt, /next ordinary turn/); assert.equal(f.steers.length, 0);
});

test("a preflight-only saved message survives real account shutdown/startup and is forwarded once to the same binding", { timeout: 20_000 }, async t => {
  const f = fixture(t); f.timeout = true; await f.start();
  await f.send("saved-before-restart", "durable original body"); assert.equal(f.writes.length, 0);
  const lease = crypto.randomUUID(); f.manager.prepareRelease(lease); assert.equal(f.manager.cancelRelease(lease), true);
  f.timeout = false; await f.restart(); await f.accepted.promise;
  assert.equal(f.writes.length, 1); assert.match(f.writes[0].prompt, /durable original body/);
  assert.equal(f.writes[0].threadId, "thread"); assert.match(f.writes[0].clientUserMessageId!, /^gateway-[a-f0-9]{64}$/);
  f.finish.resolve();
});

test("release permits accepted Codex execution and durably receives another input while native admission is frozen", { timeout: 20_000 }, async t => {
  const f = fixture(t); await f.start();
  const original = f.send("first", "continue independent native work"); await f.accepted.promise;
  const owner = crypto.randomUUID(); assert.equal(f.manager.prepareRelease(owner).prepared, true);
  await f.send("during-release", "save me through the release window");
  assert.equal(f.writes.length, 1); assert.equal(f.steers.length, 0);
  assert.match(fs.readFileSync(path.join(f.paths.runtimeDir, "one", "forwarding-inbox.json"), "utf8"), /save me through the release window/);
  assert.equal(f.manager.cancelRelease(owner), true); await f.steered.promise;
  assert.equal(f.steers.length, 1); f.finish.resolve(); await original;
});
