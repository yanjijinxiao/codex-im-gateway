import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths, accountStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-architecture-state-")), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "one", userId: "actor", token: "synthetic", baseUrl: "https://example.invalid", enabled: false });
  const stores: RuntimeStateStore[] = [], inputs: any[] = [], notices: boolean[] = [];
  let run = async (input: any) => ({ threadId: input.threadId ?? "thread", turnId: "turn", text: "done", raw: "" });
  const runner = { async warmUp() {}, async listProjects() { return { backend: "app-server", projects: [] }; },
    async inspectThread(threadId: string) { return { threadId, persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
    async run(input: any) { inputs.push(input); return run(input); }, close() {} };
  const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: false }), runnerFactory: () => runner as any,
    adapterFactory: () => ({ client: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "sent" }; } }), async monitor({ signal, onStatus }) {
      onStatus?.({ state: "connected" }); await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    } }),
    bridgeFactory: input => { stores.push(input.stateStore); return { async requestUserInput() { return { q: { answers: ["answer"] } }; },
      async reportUserInputResult() {}, async handleMessage() {}, suspendUserInputs() {} } as any; },
    codexSessionMonitorFactory: () => ({ start() {}, async stop() {} }) as any,
    codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} }) as any });
  (manager as any).notifyProjectCompletion = async (_a: string, _s: string, _t: string, success: boolean) => { notices.push(success); };
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, manager, stores, inputs, notices, runner, setRun(fn: typeof run) { run = fn; } };
}

test("one account owner survives Web reads, starts, stops, restarts and concurrent callbacks", async t => {
  const f = fixture(t), s = f.manager.createSession("one", "chat", f.root, "Original");
  const owner = (f.manager as any).storeFor("one") as RuntimeStateStore;
  await f.manager.startAccount("one", false); await f.manager.stopAccount("one", false); await f.manager.startAccount("one", false);
  assert.ok(f.stores.every(store => store === owner));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  f.setRun(async input => { entered(); await new Promise<void>(r => { release = r; }); return { threadId: input.threadId ?? "thread", turnId: "turn", text: "done", raw: "" }; });
  const pending = f.manager.continueSession("one", s.id, "run"); await started;
  f.manager.renameSession("one", s.id, "Renamed while running"); release(); await pending;
  assert.equal(new RuntimeStateStore(accountStatePaths(f.paths, "one")).getSession(s.id)?.title, "Renamed while running");
});

test("listing stopped account sessions is read-only after initialization", t => {
  const f = fixture(t); for (let i = 0; i < 25; i++) f.manager.createSession("one", `chat-${i}`, f.root, `Session ${i}`);
  const file = accountStatePaths(f.paths, "one").statePath, before = fs.statSync(file, { bigint: true });
  assert.equal(f.manager.listSessions().length, 25); f.manager.listAccounts(); f.manager.listSessions();
  const after = fs.statSync(file, { bigint: true }); assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  new RuntimeStateStore(accountStatePaths(f.paths, "one"));
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before.mtimeNs);
});

test("external state edits refresh the existing owner; stale independent writers cannot overwrite them", t => {
  const f = fixture(t), s = f.manager.createSession("one", "chat", f.root, "Original");
  const stale = new RuntimeStateStore(accountStatePaths(f.paths, "one"));
  f.manager.renameSession("one", s.id, "New name");
  assert.throws(() => stale.setSessionThread(s.id, "old-thread"), /旧快照未保存/);
  stale.refresh(); stale.setSessionThread(s.id, "new-thread");
  assert.equal(f.manager.listSessions()[0].threadId, "new-thread");
});

test("losing a live state file never silently initializes an empty account", t => {
  const f = fixture(t); f.manager.createSession("one", "chat", f.root, "Preserved");
  fs.unlinkSync(accountStatePaths(f.paths, "one").statePath);
  assert.throws(() => f.manager.listSessions(), /未初始化为空状态/);
});

for (const follow of [true, false]) test(`rebind preserves follow preference ${follow} across restart`, t => {
  const f = fixture(t), s = f.manager.createSession("one", "chat", f.root, "Bound");
  const store = (f.manager as any).storeFor("one") as RuntimeStateStore;
  store.setSessionFollow(s.id, follow); store.leaveSession("chat");
  const restarted = new RuntimeStateStore(accountStatePaths(f.paths, "one")); restarted.activateSession(s.id);
  assert.equal(restarted.getSession(s.id)?.follow, follow); assert.equal(restarted.getBoundSession("chat")?.id, s.id);
});

test("Web preflight requires a live interaction destination and never calls native on a stopped account", async t => {
  const f = fixture(t), s = f.manager.createSession("one", "chat", f.root, "Stopped");
  await assert.rejects(f.manager.continueSession("one", s.id, "run"), /请先启动此渠道账号/); assert.equal(f.inputs.length, 0);
});

test("accepted Web observation disconnect does not send a failed task notification or replay the request", async t => {
  const f = fixture(t), s = f.manager.createSession("one", "chat", f.root, "Task"); await f.manager.startAccount("one", false);
  f.setRun(async input => { await input.onTurnStarted({ threadId: "thread", turnId: "accepted" }); throw new CodexCommunicationError("observation", "turn/observe", "thread", "accepted"); });
  await assert.rejects(f.manager.continueSession("one", s.id, "run", [], undefined, "stable-id"), CodexCommunicationError);
  await assert.rejects(f.manager.continueSession("one", s.id, "run", [], undefined, "stable-id"), /未重复提交/);
  assert.equal(f.inputs.length, 1); assert.deepEqual(f.notices, []);
});

test("Web serializes explicit plan/independent settings and stages remote uploads before running", async t => {
  const f = fixture(t), store = (f.manager as any).storeFor("one") as RuntimeStateStore;
  const s = store.createSession("chat", "/remote/work", "Remote", undefined, "session", undefined, { standalone: true, hostId: "remote" });
  store.setSessionCollaborationMode(s.id, "plan"); let staged = 0;
  (f.runner as any).stageAttachments = async (files: any[]) => { staged++; return files.map(file => ({ ...file, path: "/remote/upload" })); };
  await f.manager.startAccount("one", false);
  await f.manager.continueSession("one", s.id, "read", [{ name: "file.txt", data: Buffer.from("synthetic") }]);
  assert.equal(staged, 1); assert.match(f.inputs[0].prompt, /\/remote\/upload/);
  assert.equal(f.inputs[0].projectBinding, "none"); assert.equal(f.inputs[0].collaborationMode, "plan");
  assert.match(f.inputs[0].clientUserMessageId, /^gateway-/);
});

test("global reconfiguration refuses an active Web turn before changing config or closing its owner", async t => {
  const f = fixture(t), s = f.manager.createSession("one", "chat", f.root, "Running");
  await f.manager.startAccount("one", false);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let closes = 0, changes = 0;
  f.runner.close = () => {closes++;};
  f.setRun(async input => { entered.resolve(); await release.promise; return {threadId:input.threadId??"thread",turnId:"turn",text:"done",raw:""}; });
  const pending = f.manager.continueSession("one", s.id, "continue"); await entered.promise;
  await assert.rejects(f.manager.reconfigureRuntime(async()=>{changes++;}), /此次操作未提交/);
  assert.equal(changes,0); assert.equal(closes,0);
  release.resolve(); await pending;
  await f.manager.reconfigureRuntime(async()=>{changes++;});
  assert.equal(changes,1); assert.equal(closes,1);
});

test("configuration transition excludes concurrent configuration and Web submissions, then releases on failure", async t => {
  const f=fixture(t),s=f.manager.createSession("one","chat",f.root,"Idle");await f.manager.startAccount("one",false);
  const release=Promise.withResolvers<void>();const changing=f.manager.reconfigureRuntime(()=>release.promise);
  await assert.rejects(f.manager.reconfigureRuntime(async()=>{assert.fail("concurrent commit");}), /此次操作未提交/);
  await assert.rejects(f.manager.continueSession("one",s.id,"new input"), /此次操作未提交/);assert.equal(f.inputs.length,0);
  release.reject(Error("prepare failed"));await assert.rejects(changing,/prepare failed/);
  await f.manager.continueSession("one",s.id,"allowed after failed preparation");assert.equal(f.inputs.length,1);
});
