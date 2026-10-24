import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { DAY_MS } from "../src/state/binding-expiry.js";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexThreadState } from "../src/codex/backend.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { saveAccount } from "../src/weixin/accounts.js";

async function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "expiry-manager-")), paths = resolveStatePaths(root);
  saveAccount(paths, { channel: "dingtalk", accountId: "one", clientId: "fake", clientSecret: "fake", savedAt: "", enabled: true });
  const states = new Map<string, Partial<CodexThreadState>>(), queries: string[] = [], writes: string[] = [];
  let store!: RuntimeStateStore, service!: BridgeService;
  let queue: unknown[] = [], queueFails = false, inspectFails = false, beforeRead: (() => void) | undefined;
  const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), allowedSenderIds: ["actor"], taskboardEnabled: false }),
    bridgeFactory: input => { store = input.stateStore; return service = new BridgeService(input); },
    adapterFactory: () => ({ client: createChannelClient("generic", TEXT_CAPABILITIES, {
      async sendText(input) { writes.push(input.text); return { messageId: "notice" }; }
    }), async monitor(input) {
      input.onStatus?.({ state: "connected" });
      await new Promise<void>(resolve => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
    } }),
    runnerFactory: () => ({ async warmUp() {}, close() {},
      backendInfo() { return { id: "app-server", capabilities: { ...APP_SERVER_BACKEND_CAPABILITIES, liveFollow: false, nativeQueue: true } }; },
      async inspectThread(threadId: string) {
        queries.push(threadId); beforeRead?.(); if (inspectFails) throw new Error("state timeout");
        return { threadId, persistence: "active", runtimeStatus: "idle", activeFlags: [], ...states.get(threadId) };
      },
      async listQueuedSubmissions() { if (queueFails) throw new Error("queue timeout"); return { data: queue }; },
      async run() { throw new Error("expiry must not run tasks"); }, async stop() { throw new Error("expiry must not stop tasks"); }
    } as never),
    codexSessionMonitorFactory: () => ({ start() {}, async stop() {} } as never),
    codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} } as never)
  });
  await manager.startAccount("one");
  const session = store.createSession("room", root, "original", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(session.id, "thread"); store.prepareBindingExpiry(15);
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, store, service, session, queries, writes, states,
    queue(value: unknown[]) { queue = value; }, queueFails(value: boolean) { queueFails = value; },
    inspectFails(value: boolean) { inspectFails = value; }, beforeRead(callback: () => void) { beforeRead = callback; } };
}

test("manager expires one confirmed-idle binding through existing cleanup; native task and other chat survive", async t => {
  const f = await fixture(t);
  const other = f.store.createSession("other", f.session.workspace, "other", undefined, "session", undefined, { standalone: true });
  f.store.setSessionThread(other.id, "thread"); f.store.prepareBindingExpiry(15);
  t.mock.timers.tick(16 * DAY_MS); f.store.recordBindingHumanActivity("other");
  await f.manager.checkBindingExpiry();
  assert.equal(f.store.getBoundSession("room"), undefined); assert.equal(f.store.getBoundSession("other")?.id, other.id);
  assert.equal(f.store.getSession(f.session.id)?.threadId, "thread"); assert.deepEqual(f.queries, ["thread"]);
  assert.equal(f.writes.length, 0, "cleanup is silent, not a fresh AI card");
  await f.service.handleMessage({ id: "next", senderId: "actor", replyTargetId: "room", text: "continue", attachments: [], raw: {} });
  assert.match(f.writes.at(-1)!, /长期没有人工消息已自动解绑/);
  assert.equal(f.store.getBoundSession("room"), undefined);
});

test("manager retains running, queued, approval/input-waiting and unknown states, including native queue read failures", async t => {
  const f = await fixture(t); t.mock.timers.tick(16 * DAY_MS);
  for (const state of [{ runtimeStatus: "active" }, { runtimeStatus: "notLoaded" }, { runtimeStatus: "unknown" },
    { runtimeStatus: "systemError" }, { pendingTurnWithoutId: true }, { activeFlags: ["waitingOnApproval"] },
    { activeFlags: ["waitingOnUserInput"] }, { latestTurnStatus: "inProgress" }, { persistence: "unknown" }] as Partial<CodexThreadState>[]) {
    f.states.set("thread", state); await f.manager.checkBindingExpiry(); assert.equal(f.store.getBoundSession("room")?.id, f.session.id);
  }
  f.states.clear(); f.queue([{ id: "native" }]); await f.manager.checkBindingExpiry();
  assert.equal(f.store.getBoundSession("room")?.id, f.session.id);
  f.queue([]); f.queueFails(true); await f.manager.checkBindingExpiry(); assert.ok(f.store.getBoundSession("room"));
  f.queueFails(false); f.inspectFails(true); await f.manager.checkBindingExpiry(); assert.ok(f.store.getBoundSession("room"));
});

test("a late human input or rebind during native inspection defeats expiry", async t => {
  const f = await fixture(t); t.mock.timers.tick(16 * DAY_MS);
  f.beforeRead(() => f.store.recordBindingHumanActivity("room"));
  await f.manager.checkBindingExpiry(); assert.equal(f.store.getBoundSession("room")?.id, f.session.id);
  t.mock.timers.tick(16 * DAY_MS);
  f.beforeRead(() => f.store.activateSession(f.session.id));
  await f.manager.checkBindingExpiry(); assert.equal(f.store.getBoundSession("room")?.id, f.session.id);
});

test("a pending IM question protects an idle-looking native snapshot until withdrawn", async t => {
  const f = await fixture(t);
  const request = { hostId: "local", threadId: "thread", turnId: "turn", itemId: "item", requestId: "question", autoResolutionMs: null,
    questions: [{ id: "q", header: "Question", question: "Continue?" }] };
  const pending = f.service.requestUserInput("room", request);
  t.mock.timers.tick(16 * DAY_MS); await f.manager.checkBindingExpiry(); assert.ok(f.store.getBoundSession("room"));
  assert.equal(f.queries.length, 0);
  await f.service.reportUserInputResult("room", request, "withdrawn"); await pending;
  await f.manager.checkBindingExpiry(); assert.equal(f.store.getBoundSession("room"), undefined);
});

test("QA and normal selected slots are both protected before existing conversation detach is used", async t => {
  const f = await fixture(t), project = f.store.createProject("Project", f.session.workspace);
  const normal = f.store.createSession("room", f.session.workspace, "normal", project.id);
  f.store.setSessionThread(normal.id, "normal");
  const qa = f.store.createSession("room", f.session.workspace, "QA", project.id, "qa");
  f.store.setSessionThread(qa.id, "qa"); f.store.setInteractionMode("room", "qa"); f.store.prepareBindingExpiry(15);
  t.mock.timers.tick(16 * DAY_MS); f.states.set("normal", { runtimeStatus: "active" });
  await f.manager.checkBindingExpiry(); assert.equal(f.store.getBoundSession("room")?.id, qa.id);
  f.states.clear(); await f.manager.checkBindingExpiry(); assert.equal(f.store.getBoundSession("room"), undefined);
  assert.equal(f.store.getSession(normal.id)?.threadId, "normal"); assert.equal(f.store.getSession(qa.id)?.threadId, "qa");
});
