import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import type { CodexThreadSnapshot } from "../src/codex/backend.js";

function fixture(t: test.TestContext, ghost = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-late-queue-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "follow.json"), starts: string[] = [], updates: Array<{messageId: string; text: string; finalize?: boolean}> = [];
  let reject = false;
  const checkpoint = { streamId: ghost ? "ghost" : "current", messageId: ghost ? "ghost" : "current", startedAt: 1,
    progressEntries: [], thought: ghost ? "原生队列任务已开始…" : "新任务的进展", answerPreview: "", finished: false };
  fs.writeFileSync(filePath, JSON.stringify({ binding: { eventVersion: 2, deliveryVersion: 1, hostId: "local", threadId: "thread",
    turnId: ghost ? "done" : "new", checkpointTurnId: ghost ? "done" : "new", sequence: 0, delivered: [], completed: ["done"], baseline: [], initialized: true, checkpoint } }));
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "room", managed: true,
    client: { resumableTextStream: true, async sendText() { assert.fail("no extra notice"); },
      async startTextStream(input) { starts.push(input.text); return {messageId: input.streamId!}; },
      async updateTextStream(input) { updates.push(input); if (reject) throw Error("lost update"); } } };
  let status: "completed" | "inProgress" = "completed";
  const hub = new ThreadEventHub({ filePath, subscriptions: () => [sub], backend: () => ({ async readThreadSnapshot(): Promise<CodexThreadSnapshot> {
    return {state: {threadId: "thread", persistence: "active", runtimeStatus: status === "completed" ? "idle" : "active",
      activeFlags: [], ...(status === "inProgress" ? {activeTurnId: "done"} : {})}, turns: [{id: "done", status, messages: [{id: "final", role: "assistant", text: "ORIGINAL_FINAL"}]}]};
  } }) });
  t.after(() => hub.stop());
  return {hub, sub, starts, updates, read: () => JSON.parse(fs.readFileSync(filePath, "utf8")).binding,
    reject(value: boolean) {reject = value;}, nativeRunning() {status = "inProgress";} };
}

test("late queue acceptance for an already delivered turn cannot rotate a newer presentation or create progress", async t => {
  const f = fixture(t);
  const stream = await f.hub.prepareManagedStream(f.sub, "done");
  await stream.progress("🤔 原生队列任务已开始…");
  await f.hub.managedTurnStarted(f.sub, "done");
  assert.equal(await f.hub.managedCompletion(f.sub, "done", "ORIGINAL_FINAL"), true);
  assert.equal(f.read().turnId, "new");
  assert.equal(f.read().checkpoint.messageId, "current");
  assert.equal(f.starts.length, 0); assert.equal(f.updates.length, 0);
  await stream.suspend();
});

for (const retry of [false, true]) test(`an already delivered exact turn closes only its stray live progress card: retry=${retry}`, async t => {
  const f = fixture(t, true); f.reject(retry);
  await f.hub.refresh();
  if (retry) { assert.equal(f.read().checkpoint.presentationCorrection.delivered, false); f.reject(false); await f.hub.refresh(); }
  assert.equal(f.starts.length, 0);
  assert.ok(f.updates.length > 0);
  assert.ok(f.updates.every(update => update.messageId === "ghost" && update.finalize && !update.text.includes("ORIGINAL_FINAL") && !update.text.includes("/stop")));
  assert.equal(f.read().checkpoint.finished, true);
  assert.equal(f.read().checkpoint.presentationCorrection.delivered, true);
  const count = f.updates.length; await f.hub.refresh(); assert.equal(f.updates.length, count);
});

test("a native still-running observation is not closed by an old completion ledger", async t => {
  const f = fixture(t, true); f.nativeRunning(); await f.hub.refresh();
  assert.equal(f.updates.filter(update => update.finalize).length, 0);
});

for (const status of ["completed", "failed", "interrupted"] as const) test(`queue recovery carries observed ${status} status without a native start`, async t => {
  const { AppServerCodexRunner } = await import("../src/codex/app-server-runner.js");
  const runner: any = new AppServerCodexRunner(); t.after(() => runner.close());
  runner.ensureConnected = async () => {};
  runner.recyclePrivateTransportIfIdle = async () => {};
  runner.readThreadSnapshot = async () => ({state: {threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: []},
    turns: [{id: "done", status, messages: [{id: "final", role: "assistant", text: "ORIGINAL_FINAL"}]}]});
  runner.request = async () => {assert.fail("read-only recovery cannot start/resume a native task");};
  const events: any[] = [];
  const pending = runner.runQueuedSubmission({threadId: "thread", cwd: os.tmpdir(), observeOnly: true, acceptedTurnId: "done", onTurnStarted(event: unknown) {events.push(event);}});
  if (status === "completed") assert.equal((await pending).text, "ORIGINAL_FINAL");
  else await assert.rejects(pending, (error: any) => error.status === status);
  assert.deepEqual(events, [{threadId: "thread", turnId: "done", status}]);
});

test("Bridge terminal queue recovery records identity and result without a live card or active indicator", async t => {
  const {BridgeService} = await import("../src/bridge/service.js");
  const {RuntimeStateStore} = await import("../src/state/runtime-state.js");
  const {resolveStatePaths} = await import("../src/state/paths.js");
  const {defaultConfig} = await import("../src/state/config.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-ended-queue-bridge-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const project = store.createProject("Project", root), session = store.createSession("room", root, "Session", project.id);
  store.setSessionThread(session.id, "thread");
  const activity: boolean[] = [], accepted: string[] = [], results: string[] = [];
  const service: any = new BridgeService({config: {...defaultConfig(root), allowedSenderIds: ["room"]}, stateStore: store,
    runner: {async inspectThread() {return {threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: []};},
      async runQueuedSubmission(input: any) {await input.onTurnStarted({threadId: "thread", turnId: "done", status: "completed"});return {threadId: "thread", turnId: "done", text: "ORIGINAL_FINAL", raw: ""};}} as never,
    weixin: {async sendText() {assert.fail("no duplicate reply");}},
    createTextStream() {assert.fail("known terminal receipt cannot open live progress");},
    onTurnStatus(event: any) {activity.push(event.active);},
    async deliverTurnResult(_session: unknown, id: string, text: string) {results.push(`${id}:${text}`);return true;}});
  t.after(() => service.suspendUserInputs());
  await service.runCodexTurn({id: "message", senderId: "room", text: "", attachments: [], raw: {}}, "", [], {
    receipt: {accountId: "account", conversationId: "room", actorId: "room", sessionId: session.id, threadId: "thread", status: "completed", turnId: "done"},
    starting() {assert.fail("no queued start");}, started(id: string) {accepted.push(id);}});
  assert.deepEqual(accepted, ["done"]); assert.deepEqual(results, ["done:ORIGINAL_FINAL"]); assert.deepEqual(activity, []);
});
