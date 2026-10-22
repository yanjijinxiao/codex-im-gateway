import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TurnAudienceJournal, type TurnAudienceScope, type TurnParticipantOrigin } from "../src/bridge/turn-audience.js";
import { SessionControlJournal } from "../src/bridge/session-control.js";
import { BridgeService } from "../src/bridge/service.js";
import { ChannelUserInputController } from "../src/bridge/user-input-controller.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { ChannelCapabilityError } from "../src/channels/errors.js";
import type { ChannelMentionInput } from "../src/channels/types.js";
import type { CodexRunnerInput } from "../src/codex/backend.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

const scope: TurnAudienceScope = { bindingKey: '["account","binding"]', conversationId: "group", hostId: "local", threadId: "thread", turnId: "turn" };
const origin = (actorId: string, s = scope): TurnParticipantOrigin => ({ bindingKey: s.bindingKey, conversationId: s.conversationId,
  actorId, mention: { userId: actorId } });
const current = { isCurrent: () => true };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function root(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-turn-audience-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function channel(writes: ChannelMentionInput[], fail = false) {
  return createChannelClient("generic", { ...TEXT_CAPABILITIES, mentions: "available", mentionBatchSize: 50 }, {
    async sendText() { return { messageId: "answer" }; },
    async sendMentionNotification(input) {
      writes.push(input);
      if (fail) throw new Error("ack lost");
      return { messageId: `mention-${writes.length}` };
    }
  });
}

test("audience preserves first participation order, actor deduplication and exact destination across restart", async t => {
  const file = path.join(root(t), "audience.json");
  let journal = new TurnAudienceJournal(file);
  journal.record(scope, origin("bob"), 20); journal.record(scope, origin("alice"), 10);
  journal.record(scope, origin("alice"), 30);
  journal.record(scope, { ...origin("impostor"), conversationId: "another-group" }, 0);
  for (const other of [ { ...scope, bindingKey: '["other-account","binding"]' },
    { ...scope, bindingKey: "other-binding" }, { ...scope, conversationId: "other-group" },
    { ...scope, hostId: "remote" }, { ...scope, threadId: "other-thread" }, { ...scope, turnId: "next-turn" } ]) {
    journal.record(other, origin("unrelated", other), 0);
  }
  journal = new TurnAudienceJournal(file);
  assert.deepEqual(journal.participants(scope).map(item => item.actorId), ["alice", "bob"]);
  const writes: ChannelMentionInput[] = [];
  await Promise.all([journal.notify(scope, channel(writes), current), journal.notify(scope, channel(writes), current)]);
  await new TurnAudienceJournal(file).notify(scope, channel(writes), current);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].toUserId, "group");
  assert.deepEqual(writes[0].mentions.map(item => item.userId), ["alice", "bob"]);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /prompt|answerDigest|accessToken/);
});

test("unknown notification acknowledgement and a crash after the write-ahead claim never trigger a replay", async t => {
  const dir = root(t), writes: ChannelMentionInput[] = [];
  const file = path.join(dir, "audience.json");
  const journal = new TurnAudienceJournal(file); journal.record(scope, origin("alice"));
  await journal.notify(scope, channel(writes, true), current);
  await new TurnAudienceJournal(file).notify(scope, channel(writes), current);
  assert.equal(writes.length, 1);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.values(state.records).forEach((r: any) => r.notices[0].status = "attempted");
  fs.writeFileSync(file, JSON.stringify(state));
  await new TurnAudienceJournal(file).notify(scope, channel(writes), current);
  assert.equal(writes.length, 1);
});

test("each native mention batch is bounded, ordered and never retried after detach or restart", async t => {
  const file = path.join(root(t), "audience.json"), journal = new TurnAudienceJournal(file);
  for (let i = 0; i < 102; i++) journal.record(scope, origin(`member-${i}`), i);
  let live = true;
  const writes: ChannelMentionInput[] = [], driver = channel(writes);
  const send = driver.sendMentionNotification;
  driver.sendMentionNotification = async input => { const result = await send(input); live = false; return result; };
  await journal.notify(scope, driver, { isCurrent: () => live });
  assert.equal(writes.length, 1); assert.equal(writes[0].mentions.length, 50);
  // Explicitly resume the same still-current binding; only never-attempted batches run.
  await new TurnAudienceJournal(file).notify(scope, channel(writes), current);
  assert.deepEqual(writes.map(item => item.mentions.length), [50, 50, 2]);
  assert.equal(new Set(writes.flatMap(item => item.mentions.map(x => x.userId))).size, 102);
});

test("unsupported transports, DMs and absent provider identities do not fake @ notifications", async t => {
  const journal = new TurnAudienceJournal(path.join(root(t), "audience.json"));
  let writes = 0;
  const client = createChannelClient("weixin", TEXT_CAPABILITIES, { async sendText() { writes++; return { messageId: "x" }; } });
  journal.record(scope, origin("alice"));
  await journal.notify(scope, client, current);
  await assert.rejects(client.sendMentionNotification({ toUserId: "group", text: "x", mentions: [{ userId: "alice" }] }), ChannelCapabilityError);
  const dm = { ...scope, conversationId: "dm" };
  journal.record(dm, { bindingKey: dm.bindingKey, conversationId: "dm", actorId: "alice" });
  await journal.notify(dm, channel([]), current);
  assert.equal(writes, 0);
});

test("structured mention boundary forbids @all and markup injection", async () => {
  const writes: ChannelMentionInput[] = [], client = channel(writes);
  for (const userId of ["all", "@ALL", "a\"/><at user_id=\"all", "<all>", "", "a\nb"]) {
    await assert.rejects(client.sendMentionNotification({ toUserId: "group", text: "x", mentions: [{ userId }] }));
  }
  assert.equal(writes.length, 0);
});

test("completion waits for existing same-turn native receipt observations before freezing the roster", async t => {
  const journal = new TurnAudienceJournal(path.join(root(t), "audience.json")), writes: ChannelMentionInput[] = [];
  journal.record(scope, origin("alice"), 1);
  const releaseBob = journal.hold(scope), releaseUnknown = journal.hold(scope);
  await journal.notify(scope, channel(writes), current);
  assert.equal(writes.length, 0);
  journal.record(scope, origin("bob"), 2); releaseBob();
  assert.equal(writes.length, 0);
  releaseUnknown(); releaseUnknown(); await tick();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].mentions.map(item => item.userId), ["alice", "bob"]);
});

test("accepted steer provenance survives restart; an uncertain native submission never becomes a participant", async t => {
  const file = path.join(root(t), "controls.json");
  const controls = new SessionControlJournal(file), key = JSON.stringify(["local", "thread"]);
  await controls.steer(key, "accepted-message", async () => ({ status: "accepted", threadId: "thread", turnId: "turn" }), "local", origin("alice"));
  await assert.rejects(controls.steer(key, "lost-message", async () => { throw new Error("unknown"); }, "local", origin("bob")));
  const recovered = new SessionControlJournal(file).acceptedPresentationInputs();
  assert.equal(recovered.length, 1); assert.equal(recovered[0].origin?.actorId, "alice");
});

test("question answers become participants only after native confirmation, not when typed or left unknown", async t => {
  const inputs: any[] = [], controller = new ChannelUserInputController(async () => ({ messageId: "question" }), undefined,
    { filePath: path.join(root(t), "questions.json"), sendNotice: async () => {}, onAcceptedInput: async item => { inputs.push(item); } });
  t.after(() => controller.close());
  const request = { requestId: "request", hostId: "local", threadId: "thread", turnId: "turn", itemId: "item",
    autoResolutionMs: null, questions: [{ id: "q", header: "Header", question: "Question?" }] };
  const waiting = controller.request("group", request);
  await tick(); controller.answer("group", "Q1 answer", origin("bob")); await waiting;
  assert.equal(inputs.length, 0);
  await controller.reportResult("group", request, "failed"); assert.equal(inputs.length, 0);
  await controller.reportResult("group", request, "confirmed");
  assert.equal(inputs.length, 1); assert.equal(inputs[0].origin.actorId, "bob");
});

test("real Bridge collects initial sender and accepted steer contributors without crossing multi-bound groups", async t => {
  const dir = root(t), store = new RuntimeStateStore(resolveStatePaths(path.join(dir, "state")));
  const project = store.createProject("Project", dir);
  const session = store.createSession("group", dir, "Session", project.id); store.setSessionThread(session.id, "thread");
  const other = store.createSession("other-group", dir, "Other", project.id); store.setSessionThread(other.id, "thread");
  const audience = new TurnAudienceJournal(path.join(dir, "audience.json"));
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const notices: ChannelMentionInput[] = [];
  let running = false;
  const service = new BridgeService({ accountId: "account", turnAudience: audience, stateStore: store,
    config: { ...defaultConfig(dir), streamReplies: false, allowedSenderIds: ["alice", "bob", "carol", "rejected"] }, channel: channel(notices),
    runner: {
      backendInfo() { return { id: "app-server", capabilities: { turnSteering: true } }; },
      async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: running ? "active" : "idle", activeTurnId: running ? "turn" : undefined }; },
      async run(input: CodexRunnerInput) { running = true; await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" });
        started.resolve(); await finish.promise; running = false; return { threadId: "thread", turnId: "turn", text: "final", raw: "" }; },
      async steer(input: { clientUserMessageId: string }) { if (input.clientUserMessageId === "rejected") throw new Error("unknown receipt");
        return { status: "accepted", threadId: "thread", turnId: "turn" }; }
    } as never });
  const send = (actor: string, text: string, id = actor, group = "group") => service.handleMessage({ id,
    senderId: actor, replyTargetId: group, mention: { userId: actor }, text, attachments: [], raw: {} });
  const run = send("alice", "initial"); await started.promise;
  await send("bob", "/steer first"); await send("alice", "/steer second", "alice-again");
  await send("bob", "/steer third", "bob-again"); await send("carol", "/steer private", "carol", "other-group");
  await assert.rejects(send("rejected", "/steer lost"));
  assert.equal(notices.length, 0, "no @ on any progress or steer receipt");
  finish.resolve(); await run;
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].mentions.map(item => item.userId), ["alice", "bob"]);
  const ownScope = { ...scope, bindingKey: JSON.stringify(["account", session.id]) };
  assert.deepEqual(audience.participants(ownScope).map(item => item.actorId), ["alice", "bob"]);
  assert.deepEqual(audience.participants({ ...ownScope, bindingKey: JSON.stringify(["account", other.id]), conversationId: "other-group" })
    .map(item => item.actorId), ["carol"]);
});

test("follow hub waits for final delivery, recovers accepted input origins and sends only one notice per binding", async t => {
  const dir = root(t), file = path.join(dir, "audience.json"), journal = new TurnAudienceJournal(file);
  const writes: ChannelMentionInput[] = [], client = channel(writes);
  let deliver = false;
  const driver = { ...client, capabilities: { ...client.capabilities, progress: "available" as const, resumableProgress: true }, resumableTextStream: true,
    async startTextStream() { return { messageId: "original-card" }; },
    async updateTextStream(input: { finalize?: boolean }) { if (input.finalize && !deliver) throw new Error("unconfirmed final"); } };
  const subs: ThreadSubscription[] = [ { key: scope.bindingKey, hostId: "local", threadId: "thread", recipientId: "group", managed: false, client: driver },
    { key: "other-binding", hostId: "local", threadId: "thread", recipientId: "other-group", managed: false, client: driver } ];
  journal.record(scope, origin("alice"), 1);
  const inputs = [{ id: "steer", kind: "steer" as const, acceptedAt: 2, hostId: "local", threadId: "thread", turnId: "turn", origin: origin("bob") }];
  const options = { filePath: path.join(dir, "follow.json"), turnAudience: journal, subscriptions: () => subs,
    acceptedInputs: () => inputs, backend: () => ({ async readThreadSnapshot() { return { state: { threadId: "thread", persistence: "active" as const,
      runtimeStatus: "idle" as const, activeFlags: [] }, turns: [{ id: "turn", status: "completed", messages: [{ id: "final", role: "assistant" as const, text: "result" }] }] }; } }) };
  let hub = new ThreadEventHub(options); t.after(() => hub.stop());
  await hub.started("local", "thread", "turn", new Date().toISOString());
  await hub.completion("local", "thread", "turn", "result"); assert.equal(writes.length, 0);
  deliver = true;
  await hub.completion("local", "thread", "turn", "result");
  assert.equal(writes.length, 1); assert.equal(writes[0].toUserId, "group");
  assert.deepEqual(writes[0].mentions.map(item => item.userId), ["alice", "bob"]);
  await hub.stop();
  hub = new ThreadEventHub({ ...options, turnAudience: new TurnAudienceJournal(file) });
  await hub.refresh(); await hub.completion("local", "thread", "turn", "result");
  assert.equal(writes.length, 1);
});

test("queued contributors belong only to the native turn that actually starts, including receipt recovery", async t => {
  const dir = root(t), store = new RuntimeStateStore(resolveStatePaths(path.join(dir, "state")));
  const project = store.createProject("Project", dir);
  const session = store.createSession("group", dir, "Session", project.id); store.setSessionThread(session.id, "thread");
  const audience = new TurnAudienceJournal(path.join(dir, "audience.json"));
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const notices: ChannelMentionInput[] = [];
  let running = false, queued: any, queueStarts = 0;
  const service = new BridgeService({ accountId: "account", turnAudience: audience, stateStore: store,
    config: { ...defaultConfig(dir), streamReplies: false, allowedSenderIds: ["alice", "bob"] }, channel: channel(notices),
    runner: {
      backendInfo() { return { id: "app-server", capabilities: { nativeQueue: true, turnSteering: true } }; },
      async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: running ? "active" : "idle",
        activeTurnId: running ? "turn" : undefined }; },
      async run(input: CodexRunnerInput) { running = true; await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" });
        started.resolve(); await finish.promise; running = false; return { threadId: "thread", turnId: "turn", text: "first final", raw: "" }; },
      async addQueuedSubmission(input: any) { queued = { id: "queued", clientUserMessageId: input.clientUserMessageId, input: [{ type: "text", text: input.prompt }] }; return queued; },
      async listQueuedSubmissions() { return { data: queued ? [queued] : [] }; },
      async getHistoryPage() { return { messages: [] }; },
      async runQueuedSubmission(input: any) { queueStarts++; input.onQueueStarting(); queued = undefined;
        await input.onTurnStarted({ threadId: "thread", turnId: "queue-turn" });
        return { threadId: "thread", turnId: "queue-turn", text: "queued final", raw: "" }; }
    } as never });
  const send = (actor: string, text: string) => service.handleMessage({ id: actor, senderId: actor, replyTargetId: "group",
    mention: { userId: actor }, text, attachments: [], raw: {} });
  const run = send("alice", "initial"); await started.promise; await send("bob", "/queue later"); await tick();
  assert.equal(queueStarts, 0); assert.equal(notices.length, 0);
  const own = { ...scope, bindingKey: JSON.stringify(["account", session.id]) };
  assert.deepEqual(audience.participants(own).map(item => item.actorId), ["alice"]);
  finish.resolve(); await run;
  assert.deepEqual(notices[0].mentions.map(item => item.userId), ["alice"]);
  for (let i = 0; i < 5 && queueStarts === 0; i++) { await tick(); await service.recoverNativeQueue(); }
  assert.equal(queueStarts, 1); assert.equal(notices.length, 2);
  assert.deepEqual(notices[1].mentions.map(item => item.userId), ["bob"]);
});

test("a slow completion mention never holds the native task or progress/control serial queue", { timeout: 2_000 }, async t => {
  const dir = root(t), audience = new TurnAudienceJournal(path.join(dir, "audience.json"));
  audience.record(scope, origin("alice"));
  const gate = Promise.withResolvers<void>(); t.after(() => gate.resolve());
  let mentions = 0;
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, mentions: "available" }, {
    async sendText() { return { messageId: "result" }; },
    async sendMentionNotification() { mentions++; await gate.promise; return { messageId: "mention" }; }
  });
  const sub: ThreadSubscription = { key: scope.bindingKey, hostId: "local", threadId: "thread", recipientId: "group", managed: false, client };
  const hub = new ThreadEventHub({ turnAudience: audience, filePath: path.join(dir, "follow.json"), subscriptions: () => [sub],
    backend: () => ({ async readThreadSnapshot() { throw new Error("not needed"); } }) });
  t.after(() => hub.stop());
  await hub.started("local", "thread", "turn", new Date().toISOString());
  await hub.completion("local", "thread", "turn", "final");
  assert.equal(mentions, 1);
  assert.equal(hub.status(sub.key).resultDelivery?.lastDeliveredTurnId, "turn");
  await hub.started("local", "thread", "next-turn", new Date().toISOString());
  assert.equal(mentions, 1, "new progress is not another completion reminder");
  gate.resolve(); await tick();
});

test("historical original-card repairs and late old completion events stay quiet even with an old participant roster", async t => {
  const dir = root(t), filePath = path.join(dir, "follow.json"), journal = new TurnAudienceJournal(path.join(dir, "audience.json"));
  journal.record(scope, origin("alice"));
  fs.writeFileSync(filePath, JSON.stringify({ [scope.bindingKey]: { eventVersion: 2, deliveryVersion: 1,
    hostId: "local", threadId: "thread", turnId: "current", initialized: true, sequence: 0,
    delivered: [], completed: ["current"], baseline: [], historyBoundary: { version: 1, turnId: "current" },
    pendingTerminals: { turn: { text: "old final", checkpoint: { streamId: "old-card", messageId: "old-card", startedAt: 1,
      progressEntries: [], thought: "", answerPreview: "", finished: false } } } } }));
  const writes: ChannelMentionInput[] = [], updates: string[] = [], base = channel(writes);
  const sub: ThreadSubscription = { key: scope.bindingKey, hostId: "local", threadId: "thread", recipientId: "group", managed: false,
    client: { ...base, resumableTextStream: true, capabilities: { ...base.capabilities, progress: "available" },
      async updateTextStream(input) { updates.push(input.text); }, async startTextStream() { throw new Error("no new historical card"); } } };
  const hub = new ThreadEventHub({ turnAudience: journal, filePath, subscriptions: () => [sub], backend: () => ({ async readThreadSnapshot() {
    return { state: { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] },
      turns: [{ id: "current", status: "completed", messages: [] }] };
  } }) });
  t.after(() => hub.stop());
  await hub.refresh(); await tick(); await tick();
  assert.deepEqual(updates, ["old final"]);
  await hub.completion("local", "thread", "turn", "old final");
  await hub.synchronize(scope.bindingKey);
  assert.equal(writes.length, 0);
});
