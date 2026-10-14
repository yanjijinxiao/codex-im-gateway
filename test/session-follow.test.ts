import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { followSyncFailure, formatFollowStatus, type SessionFollowStatus } from "../src/bridge/session-follow.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES, EXEC_BACKEND_CAPABILITIES, type CodexThreadSnapshot } from "../src/codex/backend.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { userFacingMessageHandlingError } from "../src/bridge/errors.js";

for (const completed of [false, true]) {
  test(`exact legacy transport terminals recover their original card: backendCompleted=${completed}`, async t => {
    const f = hubFixture(t);
    await f.hub.refresh(); await f.hub.stop();
    const states = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
    states.binding.checkpoint.terminal = { text: userFacingMessageHandlingError(new Error("thread-follower-start-turn-timeout")).replace(/^\[codex-im-gateway\]\s*/, ""), error: true };
    states.binding.checkpoint.finished = true;
    states.binding.checkpointTurnId = "turn";
    states.binding.checkpoint.terminalPages = [{ delivered: true, messageId: "original-card" }];
    if (completed) states.binding.completed = ["turn"];
    fs.writeFileSync(f.filePath, JSON.stringify(states));
    await f.restart();
    if (completed) f.setRead(async () => ({ state: { ...snapshot().state, runtimeStatus: "idle", activeTurnId: undefined },
      turns: [{ id: "turn", status: "completed", messages: [{ id: "final", role: "assistant", text: "模型的实际最终回复" }] }] }));
    const status = await f.hub.synchronize("binding");
    assert.equal(status.status, "synced");
    assert.equal(f.starts, 1);
    assert.equal(f.writes.at(-1)?.messageId, "original-card");
    const saved = JSON.parse(fs.readFileSync(f.filePath, "utf8")).binding;
    assert.equal(saved.checkpoint.finished, completed);
    if (completed) assert.equal(f.writes.at(-1)?.text, "模型的实际最终回复");
    else assert.equal(saved.checkpoint.terminal, undefined);
  });
}

test("a genuinely failed task with a finished card is never reopened as progress", async t => {
  const f = hubFixture(t);
  await f.hub.refresh(); await f.hub.stop();
  const states = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  states.binding.checkpoint.terminal = { text: "模型任务确实执行失败", error: true };
  states.binding.checkpoint.finished = true; states.binding.checkpointTurnId = "turn";
  fs.writeFileSync(f.filePath, JSON.stringify(states));
  await f.restart();
  assert.equal((await f.hub.synchronize("binding")).status, "unconfirmed");
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).binding.checkpoint.finished, true);
  assert.equal(f.starts, 1);
});

function snapshot(threadId = "thread", text = "当前公开进展"): CodexThreadSnapshot {
  return { state: { threadId, persistence: "active", runtimeStatus: "active", activeFlags: [], activeTurnId: "turn" },
    turns: [{ id: "turn", status: "inProgress", messages: [{ id: "progress", role: "assistant", kind: "progress", text }] }] };
}

function hubFixture(t: test.TestContext, readTimeoutMs = 1000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-follow-sync-"));
  const reads: Array<{ threadId: string; hostId?: string }> = [];
  const writes: Array<{ messageId?: string; text: string; finalize?: boolean }> = [];
  let starts = 0, updateFails = false;
  let read = async (id: string) => snapshot(id);
  const client = {
    resumableTextStream: true,
    async sendText(x: { text: string }) { writes.push(x); return { messageId: "text" }; },
    async startTextStream(x: { text: string }) { starts++; writes.push(x); return { messageId: "original-card" }; },
    async updateTextStream(x: { messageId: string; text: string; finalize?: boolean }) {
      writes.push(x);
      if (updateFails) throw new Error("HTTP 403 provider-private-token=NEVER_EXPOSE");
    }
  };
  let subscriptions: ThreadSubscription[] = [{ key: "binding", hostId: "remote-host", threadId: "thread", recipientId: "group", managed: false, client }];
  const options = { filePath: path.join(root, "follow.json"), subscriptions: () => subscriptions, readTimeoutMs,
    backend: () => ({ async readThreadSnapshot(threadId: string, hostId?: string) {
      reads.push({ threadId, hostId }); return read(threadId);
    } }) };
  let hub = new ThreadEventHub(options);
  t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { reads, writes, get starts() { return starts; }, get hub() { return hub; }, filePath: options.filePath,
    setRead(fn: typeof read) { read = fn; }, setUpdateFails(value: boolean) { updateFails = value; },
    setSubscriptions(value: ThreadSubscription[]) { subscriptions = value; }, get subscriptions() { return subscriptions; },
    async restart() { await hub.stop(); hub = new ThreadEventHub(options); } };
}

test("restart restores the same active card even when every progress message was already delivered", async t => {
  const f = hubFixture(t);
  await f.hub.refresh();
  await f.restart();
  await f.hub.refresh();
  assert.equal(f.starts, 1);
  assert.equal(f.writes.at(-1)?.messageId, "original-card");
  assert.match(f.writes.at(-1)!.text, /当前公开进展/);
  assert.equal(f.hub.status("binding").status, "synced");
});

test("a live writer can recover a pre-upgrade local shutdown error without replacing the card", async t => {
  const f = hubFixture(t);
  await f.hub.refresh();
  await f.hub.stop();
  const state = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  state.binding.checkpoint.terminal = { text: "Gateway connection closed", error: true };
  fs.writeFileSync(f.filePath, JSON.stringify(state));
  await f.restart();
  const result = await f.hub.synchronize("binding");
  assert.equal(result.status, "synced");
  assert.equal(f.starts, 1);
  assert.equal(f.writes.at(-1)?.messageId, "original-card");
  const recovered = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  assert.equal(recovered.binding.checkpoint.terminal, undefined);
  assert.equal(recovered.binding.checkpoint.finished, false);
});

test("unconfirmed runtime cannot reopen an old presentation error", async t => {
  const f = hubFixture(t);
  await f.hub.refresh();
  await f.hub.stop();
  const state = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  state.binding.checkpoint.terminal = { text: "Gateway connection closed", error: true };
  fs.writeFileSync(f.filePath, JSON.stringify(state));
  await f.restart();
  f.setRead(async () => ({ state: { ...snapshot().state, runtimeStatus: "notLoaded" }, turns: snapshot().turns }));
  assert.equal((await f.hub.synchronize("binding")).status, "unconfirmed");
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).binding.checkpoint.terminal.error, true);
  assert.equal(f.starts, 1);
});

test("explicit sync is scoped by binding and host, coalesces concurrent calls and reuses the card", async t => {
  const f = hubFixture(t);
  await f.hub.refresh();
  const [first, second] = await Promise.all([f.hub.synchronize("binding"), f.hub.synchronize("binding")]);
  assert.equal(first.status, "synced");
  assert.equal(second.lastSyncedAt, first.lastSyncedAt);
  assert.equal(first.presentation, "updated");
  assert.deepEqual(f.reads, [{ threadId: "thread", hostId: "remote-host" }, { threadId: "thread", hostId: "remote-host" }]);
  assert.equal(f.starts, 1);
});

test("targeted sync does not wait for another binding's stalled background read", async t => {
  const f = hubFixture(t);
  let release!: (x: CodexThreadSnapshot) => void;
  const stalled = new Promise<CodexThreadSnapshot>(resolve => { release = resolve; });
  f.setSubscriptions([...f.subscriptions, { ...f.subscriptions[0], key: "other", threadId: "other-thread" }]);
  f.setRead(id => id === "other-thread" ? stalled : Promise.resolve(snapshot(id)));
  let finished = false;
  const scan = f.hub.refresh().then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const result = await f.hub.synchronize("binding");
  assert.equal(result.status, "synced");
  assert.equal(finished, false);
  release(snapshot("other-thread"));
  await scan;
});

test("a late background snapshot cannot overwrite a newer explicit synchronization", async t => {
  const f = hubFixture(t);
  let release!: (x: CodexThreadSnapshot) => void;
  const oldRead = new Promise<CodexThreadSnapshot>(resolve => { release = resolve; });
  f.setRead(() => oldRead);
  const background = f.hub.refresh();
  await new Promise<void>(resolve => setImmediate(resolve));
  f.setRead(async () => snapshot("thread", "新的公开进展"));
  await f.hub.synchronize("binding");
  release(snapshot("thread", "STALE_PROGRESS_MUST_NOT_SEND"));
  await background;
  assert.ok(f.writes.every(x => !x.text.includes("STALE_PROGRESS_MUST_NOT_SEND")));
  assert.equal(f.hub.status("binding").status, "synced");
});

test("switching bindings during sync discards the old response without creating a card", async t => {
  const f = hubFixture(t);
  let release!: (x: CodexThreadSnapshot) => void;
  f.setRead(() => new Promise(resolve => { release = resolve; }));
  const work = f.hub.synchronize("binding");
  f.setSubscriptions([{ ...f.subscriptions[0], threadId: "new-thread" }]);
  release(snapshot());
  const result = await work;
  assert.equal(result.failure?.code, "binding-changed");
  assert.equal(f.starts, 0);
  assert.deepEqual(f.writes, []);
});

test("sync has a bounded read deadline and ignores late results", async t => {
  const f = hubFixture(t, 10);
  let release!: (x: CodexThreadSnapshot) => void;
  f.setRead(() => new Promise(resolve => { release = resolve; }));
  const result = await f.hub.synchronize("binding");
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "timeout");
  release(snapshot());
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.starts, 0);
  assert.equal(f.hub.status("binding").lastSyncedAt, undefined);
});

test("turning progress off while sync is reading prevents late progress delivery", async t => {
  const f = hubFixture(t);
  let release!: (x: CodexThreadSnapshot) => void;
  f.setRead(() => new Promise(resolve => { release = resolve; }));
  const work = f.hub.synchronize("binding");
  f.setSubscriptions([{ ...f.subscriptions[0], progressEnabled: false }]);
  release(snapshot());
  const result = await work;
  assert.equal(result.status, "synced");
  assert.equal(result.presentation, "off");
  assert.equal(f.starts, 0);
  assert.deepEqual(f.writes, []);
});

test("unloaded and orphan App states are unconfirmed, never false sync success", async t => {
  const f = hubFixture(t);
  f.setRead(async () => ({ state: { ...snapshot().state, runtimeStatus: "notLoaded", activeTurnId: undefined }, turns: [] }));
  assert.equal((await f.hub.synchronize("binding")).failure?.code, "unconfirmed");
  f.setRead(async () => ({ state: { ...snapshot().state, runtimeStatus: "idle", activeTurnId: undefined, pendingTurnWithoutId: true }, turns: [] }));
  assert.equal((await f.hub.synchronize("binding")).failure?.code, "orphan-turn");
  assert.equal(f.starts, 0);
});

test("unloaded bindings report safe diagnostics and continue waiting for their live owner", async t => {
  const logs: string[] = [];
  t.mock.method(console, "warn", (line: string) => logs.push(line));
  const f = hubFixture(t);
  f.setRead(async () => ({ state: { ...snapshot().state, runtimeStatus: "notLoaded", activeTurnId: undefined }, turns: [] }));
  const result = await f.hub.synchronize("binding");
  assert.equal(result.status, "unconfirmed");
  assert.match(result.failure!.message, /绑定已保留.*同一会话.*不会启动任务/);
  const detail = JSON.parse(logs.find(line => line.includes("thread follow sync"))!.split("thread follow sync ")[1]);
  assert.equal(detail.operation, "follow-synchronize");
  assert.equal(detail.snapshotRuntime, "notLoaded");
  assert.equal(detail.snapshotPersistence, "active");
  assert.match(detail.message, /绑定已保留/);
  f.setRead(async () => snapshot());
  assert.equal((await f.hub.synchronize("binding")).status, "synced");
});

test("a wrong thread or active runtime without a confirmed turn cannot create a placeholder card", async t => {
  const f = hubFixture(t);
  f.setRead(async () => snapshot("WRONG_THREAD"));
  assert.equal((await f.hub.synchronize("binding")).status, "failed");
  f.setRead(async () => ({ state: snapshot().state, turns: [] }));
  assert.equal((await f.hub.synchronize("binding")).status, "unconfirmed");
  assert.equal(f.starts, 0);
});

test("sync diagnostics safely classify failures and do not call an old snapshot the current state", () => {
  for (const [message, code] of [["IPC timed out private-token=NEVER_EXPOSE", "timeout"],
    ["ECONNREFUSED private-token=NEVER_EXPOSE", "connection"], ["permission denied private-token=NEVER_EXPOSE", "permission"]] as const) {
    const failure = followSyncFailure(new Error(message));
    assert.equal(failure.code, code);
    const rendered = formatFollowStatus({ status: "failed", failure, runtime: snapshot().state }).join("\n");
    assert.doesNotMatch(rendered, /NEVER_EXPOSE/);
    assert.match(rendered, /不代表当前/);
  }
});

test("card update failure remains visible; retry sync uses the original handle and never leaks provider errors", async t => {
  const f = hubFixture(t);
  await f.hub.refresh();
  f.setUpdateFails(true);
  const failure = await f.hub.synchronize("binding");
  assert.equal(failure.status, "failed");
  assert.equal(failure.failure?.code, "presentation");
  assert.doesNotMatch(formatFollowStatus(failure).join("\n"), /NEVER_EXPOSE/);
  await f.hub.refresh();
  assert.equal(f.hub.status("binding").status, "failed", "polling must not hide a card delivery failure");
  f.setUpdateFails(false);
  const recovered = await f.hub.synchronize("binding");
  assert.equal(recovered.status, "synced");
  assert.equal(f.starts, 1);
  assert.equal(f.writes.at(-1)?.messageId, "original-card");
});

test("closed following does not read the backend; /stream off sync does not create progress", async t => {
  const f = hubFixture(t);
  f.setSubscriptions([{ ...f.subscriptions[0], enabled: false }]);
  assert.equal((await f.hub.synchronize("binding")).status, "disabled");
  assert.equal(f.reads.length, 0);
  f.setSubscriptions([{ ...f.subscriptions[0], enabled: true, progressEnabled: false }]);
  const result = await f.hub.synchronize("binding");
  assert.equal(result.status, "synced");
  assert.equal(result.presentation, "off");
  assert.equal(f.starts, 0);
});

test("health persists errors across restarts and detects stale successful observations", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const f = hubFixture(t);
  await f.hub.synchronize("binding");
  t.mock.timers.tick(61_000);
  assert.equal(f.hub.status("binding").status, "stale");
  f.setRead(async () => { throw new Error("provider-private-token=NEVER_EXPOSE"); });
  await f.hub.synchronize("binding");
  await f.restart();
  assert.equal(f.hub.status("binding").status, "failed");
  assert.ok(f.hub.status("binding").lastSyncedAt);
  assert.doesNotMatch(formatFollowStatus(f.hub.status("binding")).join("\n"), /NEVER_EXPOSE/);
});

for (const channel of ["dingtalk", "weixin", "feishu"] as const) {
  for (const backend of ["app-server", "exec"] as const) {
    test(`${channel}/${backend}: follow commands use the shared port without starting or rebinding a session`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-follow-command-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const store = new RuntimeStateStore(resolveStatePaths(root));
      const session = store.createSession("group", root);
      store.setSessionThread(session.id, "thread");
      store.setSessionFollow(session.id, true);
      const texts: string[] = [];
      let syncs = 0;
      let health: SessionFollowStatus = { status: "failed", failure: { code: "timeout", message: "读取超时" } };
      const bridge = new BridgeService({
        stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["actor"], codexBackend: backend },
        channel: createChannelClient(channel, TEXT_CAPABILITIES, { async sendText(x) { texts.push(x.text); return { messageId: "text" }; } }),
        sessionFollow: { status: () => health, async synchronize(s) {
          assert.equal(s.id, session.id); syncs++; health = { status: "synced", lastSyncedAt: new Date().toISOString() }; return health;
        } },
        runner: {
          backendInfo: () => ({ id: backend, capabilities: backend === "exec" ? EXEC_BACKEND_CAPABILITIES : APP_SERVER_BACKEND_CAPABILITIES }),
          async run() { throw new Error("MUST_NOT_START_A_TURN"); }, async getRuntimeInfo() { return {}; },
          async inspectThread() { return snapshot().state; }
        } as never
      });
      let seq = 0;
      const send = (text: string) => bridge.handleMessage({ id: String(++seq), senderId: "actor", replyTargetId: "group", text, raw: {}, attachments: [] });
      await send("/follow");
      if (backend === "exec") {
        await assert.rejects(send("/follow sync"), /does not support liveFollow/);
        assert.equal(syncs, 0);
        assert.match(texts.at(-1)!, /不支持/);
      } else {
        assert.match(texts.at(-1)!, /已开启.*同步失败/s);
        await send("/follow on"); // Already on must still synchronize.
        await send("/follow sync");
        assert.equal(syncs, 2);
        assert.match(texts.at(-1)!, /同步成功/);
        await send("/status");
        assert.ok(texts.some(x => x.includes("最后成功同步")));
        await send("/follow off");
        await send("/follow sync");
        assert.equal(syncs, 2);
        assert.equal(store.getSession(session.id)?.follow, false);
        assert.match(texts.at(-1)!, /已关闭.*未执行同步/);
      }
      assert.equal(store.getActiveSession("group")?.id, session.id);
      assert.equal(store.getSession(session.id)?.threadId, "thread");
    });
  }
}

test("a viewer can inspect follow health but cannot force delivery or change the setting", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-follow-role-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const session = store.createSession("group", root);
  store.setSessionThread(session.id, "thread");
  store.setRole("group", "actor", "viewer");
  const texts: string[] = [];
  let syncs = 0;
  const bridge = new BridgeService({
    stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["actor"] },
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(x) { texts.push(x.text); return { messageId: "text" }; } }),
    sessionFollow: { status: () => ({ status: "pending" }), async synchronize() { syncs++; return { status: "synced" }; } },
    runner: { backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }) } as never
  });
  await bridge.handleMessage({ id: "1", senderId: "actor", replyTargetId: "group", text: "/follow", raw: {}, attachments: [] });
  assert.match(texts.at(-1)!, /等待首次同步/);
  await bridge.handleMessage({ id: "2", senderId: "actor", replyTargetId: "group", text: "/follow sync", raw: {}, attachments: [] });
  assert.equal(syncs, 0);
  assert.match(texts.at(-1)!, /权限/);
});

test("only explicit controller confirmation opts into unknown-instance redelivery", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "follow-redelivery-role-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)); const session = store.createSession("group", root);
  store.setSessionThread(session.id, "thread"); store.setRole("group", "actor", "participant");
  const options: unknown[] = []; const texts: string[] = [];
  const bridge = new BridgeService({ stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["actor"] },
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) { texts.push(input.text); return { messageId: "text" }; } }),
    sessionFollow: { status: () => ({ status: "pending" }), async synchronize(_session, recovery) { options.push(recovery); return { status: "synced" }; } },
    runner: { backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }) } as never });
  const send = (text: string) => bridge.handleMessage({ id: String(texts.length), senderId: "actor", replyTargetId: "group", text, raw: {}, attachments: [] });
  await send("/follow sync --retry-delivery"); assert.equal(options.length, 0); assert.match(texts.at(-1)!, /controller 权限/);
  store.setRole("group", "actor", "controller");
  await send("/follow sync"); assert.equal(options[0], undefined);
  await send("/follow sync --retry-delivery"); assert.deepEqual(options[1], { confirmUncertainDelivery: true });
  assert.equal(store.getActiveSession("group")!.id, session.id); assert.equal(store.getSession(session.id)!.threadId, "thread");
});
