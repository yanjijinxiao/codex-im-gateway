import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const change of ["rebind", "revoke"] as const) test(`late policy capability read cannot change policy after ${change}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-policy-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)); store.setPairedSenderIds(["actor"]);
  const project = store.createProject("Project", root), first = store.createSession("chat", root, "First", project.id);
  store.setSessionThread(first.id, "thread");
  const second = store.createSession("chat", root, "Second", project.id); store.activateSession(first.id);
  const gate = Promise.withResolvers<any>();
  const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "ack" }; } }),
    runner: { inspectThread: () => gate.promise } as never });
  t.after(() => service.suspendUserInputs());
  const result = service.handleMessage({ id: "policy", senderId: "actor", replyTargetId: "chat", text: "/policy steer", attachments: [], raw: {} }).then(() => undefined, error => error);
  await tick();
  if (change === "rebind") store.activateSession(second.id); else store.setPairedSenderIds([]);
  gate.resolve({ threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] });
  assert.ok(await result);
  assert.equal(store.getSession(first.id)?.activeMessagePolicy, undefined);
  assert.equal(store.getSession(second.id)?.activeMessagePolicy, undefined);
});

for (const change of ["rebind", "revoke"] as const) test(`late model lookup cannot change settings after ${change}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-control-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  store.setPairedSenderIds(["actor"]);
  const project = store.createProject("Project", root);
  const first = store.createSession("chat", root, "First", project.id);
  const second = store.createSession("chat", root, "Second", project.id);
  store.activateSession(first.id);
  const gate = Promise.withResolvers<any[]>();
  const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "ack" }; } }),
    listCodexModels: () => gate.promise, runner: { async getRuntimeInfo() { return {}; } } as never });
  t.after(() => service.suspendUserInputs());
  const work = service.handleMessage({ id: "synthetic", senderId: "actor", replyTargetId: "chat", text: "/model new-model", attachments: [], raw: {} });
  const result = work.then(() => undefined, error => error);
  await tick();
  if (change === "rebind") store.activateSession(second.id); else store.setPairedSenderIds([]);
  gate.resolve([{ model: "new-model", displayName: "New", supportedEfforts: [] }]);
  const error = await result;
  assert.equal(store.getSession(first.id)?.model, undefined);
  assert.equal(store.getSession(second.id)?.model, undefined);
  assert.ok(error, "retired control operation must report that it was not applied");
});

test("a late catalog inspect cannot restore a conversation explicitly unbound meanwhile", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-bind-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)); store.setPairedSenderIds(["actor"]);
  const project = store.createProject("Project", root);
  store.createSession("chat", root, "Original", project.id);
  const gate = Promise.withResolvers<any>();
  const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "ack" }; } }),
    runner: { inspectThread: () => gate.promise, async getHistory() { return []; } } as never });
  t.after(() => service.suspendUserInputs());
  const message = (text: string) => ({ id: text, senderId: "actor", replyTargetId: "chat", text, attachments: [], raw: {} });
  const result = service.handleMessage(message("/session target --host local")).then(() => undefined, error => error);
  await tick(); await service.handleMessage(message("/unbind"));
  gate.resolve({ threadId: "target", cwd: root, persistence: "active", runtimeStatus: "idle", activeFlags: [] });
  const error = await result;
  assert.equal(store.getBoundSession("chat"), undefined);
  assert.ok(error);
});

for (const initial of ["never-bound", "detached"] as const) test(`an unbound catalog query is invalidated by a later explicit leave: ${initial}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-unbound-control-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)); store.setPairedSenderIds(["actor"]);
  const project = store.createProject("Project", root);
  if (initial === "detached") { store.createSession("chat", root, "Original", project.id); store.leaveSession("chat"); }
  const gate = Promise.withResolvers<any>();
  const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "ack" }; } }),
    runner: { inspectThread: () => gate.promise, async getHistory() { return []; } } as never });
  t.after(() => service.suspendUserInputs());
  const work = service.handleMessage({ id: "bind", senderId: "actor", replyTargetId: "chat", text: "/session target --host local", attachments: [], raw: {} }).then(() => undefined, error => error);
  await tick();
  if (initial === "detached") store.createSession("chat", root, "Temporary", project.id);
  store.leaveSession("chat");
  gate.resolve({ threadId: "target", cwd: root, persistence: "active", runtimeStatus: "idle", activeFlags: [] });
  assert.ok(await work);
  assert.equal(store.getBoundSession("chat"), undefined);
});
