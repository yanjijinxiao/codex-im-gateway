import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { channelHelpText, parseCommand } from "../src/bridge/channel-commands.js";
import { RuntimeStateStore, SessionBindingConflictError } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

function fixture(t: test.TestContext, channel: "dingtalk" | "weixin" | "feishu" | "wecom" = "dingtalk") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-unbind-"));
  const paths = resolveStatePaths(path.join(root, "state"));
  const store = new RuntimeStateStore(paths);
  const project = store.createProject("Same directory", root, { hostId: "remote-a" });
  const texts: string[] = [];
  let runs = 0, stops = 0, changes = 0, downloads = 0;
  const client = createChannelClient(channel, { ...TEXT_CAPABILITIES, inbound: { ...TEXT_CAPABILITIES.inbound, image: "available" } }, {
    async sendText(input) { texts.push(input.text); return { messageId: `reply-${texts.length}` }; },
    async resolveAttachments() { downloads++; return []; }
  });
  const options = { config: { ...defaultConfig(root), allowedSenderIds: ["actor", "viewer"], streamReplies: false },
    stateStore: store, channel: client, onSubscriptionsChanged: async () => { changes++; },
    runner: { async run() { runs++; return { raw: "", text: "done", threadId: "new-thread" }; }, async stop() { stops++; } } as never };
  const service = new BridgeService(options);
  t.after(() => { service.suspendUserInputs(); fs.rmSync(root, { recursive: true, force: true }); });
  let sequence = 0;
  return { root, paths, store, project, texts, service,
    get runs() { return runs; }, get stops() { return stops; }, get changes() { return changes; }, get downloads() { return downloads; },
    send(text: string, senderId = "actor", replyTargetId = "chat") {
      return service.handleMessage({ id: String(++sequence), senderId, replyTargetId, text, attachments: [], raw: {} });
    } };
}

test("only authorized inbound human messages renew the binding idle clock", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const f = fixture(t), session = f.store.createSession("chat", f.root, "normal", f.project.id);
  f.store.prepareBindingExpiry(15);
  const initial = f.store.getBindingExpiry("chat", 15)!;
  t.mock.timers.tick(86_400_000);
  await f.send("/status", "intruder", "other-room");
  assert.equal(f.store.getBindingExpiry("chat", 15)?.generation, initial.generation);
  await f.send("/help", "actor", "chat");
  assert.equal(f.store.getBoundSession("chat")?.id, session.id);
  assert.notEqual(f.store.getBindingExpiry("chat", 15)?.generation, initial.generation);
  assert.equal(f.store.getBindingExpiry("chat", 15)?.lastHumanAt, new Date().toISOString());
});

for (const channel of ["dingtalk", "weixin", "feishu", "wecom"] as const) {
  test(`${channel}: unbound ordinary messages only explain binding, without creating tasks or sessions`, async t => {
    const f = fixture(t, channel);
    await f.send("帮我执行一下");
    assert.match(f.texts.at(-1)!, /未绑定任何 session/);
    for (const command of ["/sessions", "/session", "/new", "/help"]) assert.ok(f.texts.at(-1)!.includes(command));
    assert.equal(f.store.listSessions().length, 0);
    assert.equal(f.runs, 0); assert.equal(f.stops, 0); assert.equal(f.downloads, 0);
    assert.equal(f.store.getActiveProject("chat"), undefined, "ordinary input must not implicitly select the only project");
  });
}

for (const command of ["/unbind", "/leave"]) {
  test(`${command}: detach persists with project selection, clears QA and normal slots, preserves other chats`, async t => {
    const f = fixture(t);
    const normal = f.store.createSession("chat", f.root, "normal", f.project.id);
    f.store.setSessionThread(normal.id, "same-native-thread");
    const other = f.store.createSession("other-chat", f.root, "other", f.project.id);
    f.store.setSessionThread(other.id, "same-native-thread");
    const qa = f.store.createSession("chat", f.root, "QA", f.project.id, "qa");
    f.store.setSessionThread(qa.id, "qa-thread");
    f.store.setInteractionMode("chat", "qa");
    await f.send(command);
    const restored = new RuntimeStateStore(f.paths);
    assert.equal(restored.getActiveSession("chat"), undefined);
    assert.equal(restored.getActiveQaSession("chat"), undefined);
    assert.equal(restored.getBoundSession("chat"), undefined);
    assert.equal(restored.getSession(normal.id)?.follow, false);
    assert.equal(restored.getSession(qa.id)?.follow, false);
    assert.equal(restored.getBoundSession("other-chat")?.id, other.id);
    assert.equal(restored.getSession(normal.id)?.threadId, "same-native-thread");
    f.store.activateProject("chat", f.project.id);
    await f.send("不要自动接回旧会话");
    await f.send("/model another-model");
    assert.equal(f.store.getBoundSession("chat"), undefined);
    assert.equal(f.store.listSessions().length, 3);
    assert.equal(f.runs, 0); assert.equal(f.stops, 0);
    assert.equal(f.changes, 1);
    await f.send("/unbind");
    assert.match(f.texts.at(-1)!, /已解绑/);
    assert.equal(f.changes, 1, "idempotent detach must not create new subscription changes");
  });
}

test("exact unbind compares host, thread, conversation and current record; stale views cannot detach a replacement", t => {
  const f = fixture(t);
  const first = f.store.createSession("chat", f.root, "first", f.project.id);
  f.store.setSessionThread(first.id, "thread");
  const session = f.store.getSession(first.id)!;
  const expected = f.store.sessionBindingTarget(session);
  for (const wrong of [{ ...expected, hostId: "local" }, { ...expected, conversationId: "other" }, { ...expected, threadId: "other-thread" }]) {
    assert.throws(() => f.store.unbindSession(first.id, wrong), SessionBindingConflictError);
    assert.equal(f.store.getBoundSession("chat")?.id, first.id);
  }
  const second = f.store.createSession("chat", f.root, "replacement", f.project.id);
  assert.throws(() => f.store.unbindSession(first.id, expected), SessionBindingConflictError);
  assert.equal(f.store.getBoundSession("chat")?.id, second.id);
  const target = f.store.sessionBindingTarget(second);
  assert.equal(f.store.unbindSession(second.id, target).changed, true);
  assert.equal(f.store.unbindSession(second.id, target).changed, false);
  assert.equal(f.store.getSession(first.id)?.threadId, "thread");
  f.store.deleteSession(second.id);
  assert.equal(f.store.getBoundSession("chat"), undefined, "deleting a detached record must not revive an older binding");
});

test("deleting an inactive mode record preserves the current QA binding and never falls back", t => {
  const f = fixture(t);
  const normal = f.store.createSession("chat", f.root, "normal", f.project.id);
  const qa = f.store.createSession("chat", f.root, "QA", f.project.id, "qa");
  f.store.setInteractionMode("chat", "qa");
  f.store.deleteSession(normal.id);
  assert.equal(f.store.getBoundSession("chat")?.id, qa.id);
  assert.equal(f.store.isSessionDetached("chat"), false);
  f.store.deleteSession(qa.id);
  assert.equal(f.store.getBoundSession("chat"), undefined);
  assert.equal(f.store.isSessionDetached("chat"), true);
});

test("unbind is discoverable, validates arguments and requires participant authorization", async t => {
  const f = fixture(t);
  const session = f.store.createSession("chat", f.root, "session", f.project.id);
  f.store.setRole("chat", "viewer", "viewer");
  await f.send("/unbind", "viewer");
  assert.equal(f.store.getBoundSession("chat")?.id, session.id);
  assert.match(f.texts.at(-1)!, /participant/);
  await f.send("/unbind all");
  assert.equal(f.store.getBoundSession("chat")?.id, session.id);
  assert.match(f.texts.at(-1)!, /用法/);
  assert.equal(parseCommand("/unbind")?.name, "unbind");
  assert.match(channelHelpText([]), /\/unbind/);
  assert.match(channelHelpText([], "session"), /\/unbind/);
});

test("explicit new rebinds without reviving the old session; unbind also works when session mode is disabled", async t => {
  const f = fixture(t);
  const old = f.store.createSession("chat", f.root, "old", f.project.id);
  await f.send("/unbind");
  await f.send("/new --standalone");
  assert.notEqual(f.store.getBoundSession("chat")?.id, old.id);
  assert.equal(f.store.getBoundSession("chat")?.projectBinding, "none");
  assert.equal(f.store.isSessionDetached("chat"), false);
  assert.equal(f.runs, 0, "creating a binding must not run a task yet");
  f.service.configureModeSettings({ defaultMode: "qa", enabledModes: ["qa"], qaKnowledgeBase: { kind: "project" } });
  await f.send("/unbind");
  assert.equal(f.store.getActiveSession("chat"), undefined);
  assert.equal(f.store.getActiveQaSession("chat"), undefined);
  assert.match(f.texts.at(-1)!, /已解绑/);
});
