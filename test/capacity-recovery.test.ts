import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CapacityRecoveryCoordinator, type CapacityFailure } from "../src/server/capacity-recovery.js";
import { CodexTurnExecutionError, type CodexCapacityResumeInput, type CodexBridgeBackend } from "../src/codex/backend.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { ChannelTurnTextStream } from "../src/channels/progress.js";
import { meaningfulProgress, progressKind } from "../src/channels/progress-summary.js";
import { TurnAudienceJournal } from "../src/bridge/turn-audience.js";
import { InteractionRoutingJournal } from "../src/bridge/interaction-routing.js";

const scope = { hostId: "local", threadId: "thread", turnId: "failed" };

test("recovery questions wait for accepted identity routing, then return the native answer receipt", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 1000, transport: { command: process.execPath,
    args: [path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-capacity-app-server.mjs"), "--ask"], mode: "remote-daemon" } });
  t.after(() => runner.close());
  let ready = false, answers = 0, confirmed = 0;
  const result = await runner.resumeAfterCapacity({ ...scope, failedTurnId: "failed", clientUserMessageId: "stable-attempt", assertCurrent() {},
    async onTurnStarted() { await new Promise(r => setTimeout(r, 10)); ready = true; },
    async onUserInput(request) { assert.equal(ready, true); assert.equal(request.turnId, "continued"); answers++; return { choice: { answers: ["continue"] } }; },
    onUserInputResult(_, result) { if (result === "confirmed") confirmed++; }
  });
  assert.equal(result.text, "continued without replay"); assert.equal(answers, 1); assert.equal(confirmed, 1);
});

for (const [queued, systemError] of [[false, false], [true, false], [false, true]]) {
  test(`App Server continuation sends only empty input with inherited settings: queue=${queued}, systemError=${systemError}`, async t => {
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 1000, transport: { command: process.execPath,
      args: [path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-capacity-app-server.mjs"), ...(queued ? ["--queued"] : []), ...(systemError ? ["--system-error"] : [])], mode: "remote-daemon" } });
    t.after(() => runner.close());
    let accepted = 0;
    const task = runner.resumeAfterCapacity({ ...scope, failedTurnId: "failed", clientUserMessageId: "stable-attempt", assertCurrent() {},
      onTurnStarted(e) { accepted++; assert.equal(e.turnId, "continued"); } });
    if (queued) { await assert.rejects(task, /queue takes precedence/); assert.equal(accepted, 0); }
    else { assert.equal((await task).text, "continued without replay"); assert.equal(accepted, 1); }
  });
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail("condition did not settle");
}
function fixture(t: test.TestContext, run?: (input: CodexCapacityResumeInput) => Promise<never | { text: string; threadId: string; turnId: string; raw: string }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-capacity-"));
  const calls: CodexCapacityResumeInput[] = [], notices: string[] = [], terminals: string[] = [], accepted: string[] = [];
  let eligible = true;
  const backend = { backendInfo: () => ({ id: "app-server" }), async resumeAfterCapacity(input: CodexCapacityResumeInput) {
    calls.push(input); input.assertCurrent();
    if (run) return run(input);
    await input.onTurnStarted({ threadId: "thread", turnId: "resumed" });
    return { threadId: "thread", turnId: "resumed", text: "完整结果", raw: "" };
  } } as CodexBridgeBackend;
  const options = { filePath: path.join(root, "recovery.json"), backend: () => backend, eligible: () => eligible,
    async notice(_: CapacityFailure, text: string) { notices.push(text); },
    async accepted(_: CapacityFailure, id: string) { accepted.push(id); },
    async progress() {}, async terminal(_: CapacityFailure, text: string) { terminals.push(text); }, delaysMs: [2, 2, 2, 2] };
  const coordinator = new CapacityRecoveryCoordinator(options);
  t.after(() => { coordinator.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { coordinator, options, calls, notices, terminals, accepted, setEligible: (value: boolean) => { eligible = value; } };
}

test("duplicate capacity failures across bindings dispatch exactly one continuation", async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) assert.equal(f.coordinator.offer(scope), true);
  await until(() => f.terminals.length > 0);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.accepted, ["resumed"]);
  assert.deepEqual(f.terminals, ["完整结果"]);
  assert.equal(f.calls[0].failedTurnId, "failed");
  assert.match(f.calls[0].clientUserMessageId, /^capacity-/);
  assert.equal("prompt" in f.calls[0], false);
  assert.equal(f.coordinator.offer(scope), true); // late superseded failure never creates a notice.
  assert.equal(f.calls.length, 1);
});

test("capacity failures have bounded attempts, fresh client IDs and a single terminal result", async t => {
  let attempt = 0;
  const f = fixture(t, async input => {
    attempt++;
    await input.onTurnStarted({ threadId: "thread", turnId: `retry-${attempt}` });
    throw new CodexTurnExecutionError("failed", "capacity", "model-capacity");
  });
  f.coordinator.offer(scope);
  await until(() => f.terminals.length > 0);
  assert.equal(f.calls.length, 4); assert.equal(new Set(f.calls.map(c => c.clientUserMessageId)).size, 4);
  assert.deepEqual(f.calls.map(c => c.failedTurnId), ["failed", "retry-1", "retry-2", "retry-3"]);
  assert.equal(f.terminals.length, 1); assert.match(f.terminals[0], /容量不足/);
  assert.equal(f.coordinator.offer({ ...scope, turnId: "retry-4" }), false);
});

for (const change of ["user-input", "unbind"] as const) {
  test(`${change} cancels a pending continuation before submission`, async t => {
    const f = fixture(t);
    f.coordinator.offer(scope);
    if (change === "user-input") f.coordinator.cancel("thread"); else f.setEligible(false);
    await new Promise(r => setTimeout(r, 25));
    assert.equal(f.calls.length, 0); assert.equal(f.accepted.length, 0);
  });
}

test("uncertain submission survives restart without another external write", async t => {
  const f = fixture(t, async () => { throw new CodexCommunicationError("submission", "turn/start", "thread", undefined, { code: "Timeout" }); });
  f.coordinator.offer(scope);
  await until(() => f.notices.some(text => text.includes("结果尚未确认")));
  f.coordinator.stop();
  const restored = new CapacityRecoveryCoordinator(f.options); t.after(() => restored.stop()); restored.start();
  assert.equal(restored.offer(scope), true);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(f.calls.length, 1); assert.equal(f.terminals.length, 0);
});

test("new input after acceptance cancels future retries but still delivers the accepted result", async t => {
  let finish!: () => void;
  const f = fixture(t, async input => {
    await input.onTurnStarted({ threadId: "thread", turnId: "resumed" });
    await new Promise<void>(resolve => { finish = resolve; });
    return { threadId: "thread", turnId: "resumed", text: "回答后继续完成", raw: "" };
  });
  f.coordinator.offer(scope);
  await until(() => Boolean(finish));
  f.coordinator.cancel("thread"); finish();
  await until(() => f.terminals.length > 0);
  assert.deepEqual(f.terminals, ["回答后继续完成"]); assert.equal(f.calls.length, 1);
});

test("a channel result callback failure cannot restart native execution", async t => {
  const f = fixture(t);
  let delivered = 0;
  const coordinator = new CapacityRecoveryCoordinator({ ...f.options,
    async terminal() { delivered++; throw Error("delivery disconnected"); } });
  t.after(() => coordinator.stop()); coordinator.offer(scope);
  await until(() => delivered > 0);
  assert.equal(coordinator.offer({ ...scope, turnId: "resumed" }), false);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(f.calls.length, 1);
  assert.equal(f.notices.some(text => text.includes("结果尚未确认")), false);
});

test("noncapacity terminal errors never schedule another continuation", async t => {
  const f = fixture(t, async input => {
    await input.onTurnStarted({ threadId: "thread", turnId: "resumed" });
    throw new CodexTurnExecutionError("failed", "PRIVATE_DETAILS", "safety-blocked");
  });
  f.coordinator.offer(scope); await until(() => f.terminals.length > 0);
  assert.equal(f.calls.length, 1); assert.doesNotMatch(f.terminals[0], /PRIVATE_DETAILS/);
});

test("recovered native turns inherit the existing interaction destination without changing primary", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-recovery-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new InteractionRoutingJournal(path.join(root, "route.json"));
  const one = { accountId: "one", sessionId: "one", recipientId: "chat-one", hostId: "local", threadId: "thread" };
  const two = { ...one, accountId: "two", sessionId: "two", recipientId: "chat-two" };
  journal.rememberTurn(one, "failed"); journal.setPrimary(two);
  journal.inheritTurn("local", "thread", "failed", "resumed");
  assert.deepEqual(journal.resolve("local", "thread", [one, two], "resumed").destination, one);
  assert.deepEqual(journal.resolve("local", "thread", [one, two]).destination, two);
});

test("waiting plan survives restart, but write-ahead submitting plans do not replay", async t => {
  const f = fixture(t);
  f.coordinator.offer(scope); f.coordinator.stop();
  const restored = new CapacityRecoveryCoordinator(f.options); t.after(() => restored.stop()); restored.start();
  await until(() => f.terminals.length > 0); assert.equal(f.calls.length, 1);
  const data = JSON.parse(fs.readFileSync(f.options.filePath, "utf8"));
  const record = Object.values(data.records)[0] as Record<string, unknown>;
  record.status = "submitting"; record.acceptedTurnId = undefined;
  fs.writeFileSync(f.options.filePath, JSON.stringify(data));
  const uncertain = new CapacityRecoveryCoordinator(f.options); t.after(() => uncertain.stop()); uncertain.start();
  await new Promise(r => setTimeout(r, 15)); assert.equal(f.calls.length, 1);
});

test("failure details and routine tool receipts cannot displace meaningful task updates", async t => {
  const frames: Array<{ text: string }> = [];
  const stream = new ChannelTurnTextStream({ async sendText() {}, async startTextStream() { return { messageId: "original" }; },
    async updateTextStream(frame) { frames.push(frame); } }, "chat");
  t.after(() => stream.suspend());
  await stream.progress("一路构建已经完成打包，另一条正在链接 SQLTask。");
  for (let i = 0; i < 25; i++) await stream.progress(`✅ Python 脚本完成，退出码 0，耗时 ${i}ms`);
  await stream.progress("🔎 正在执行本地操作"); await stream.flush();
  assert.match(frames.at(-1)!.text, /正在链接 SQLTask/);
  assert.doesNotMatch(frames.at(-1)!.text, /耗时 \d+ms|退出码 0|分析刚完成/);
  assert.match(frames.at(-1)!.text, /工具活动/);
  assert.equal(stream.checkpoint().progressEntries.length, 1);
  assert.equal(progressKind("✅ 1098 项回归测试通过"), "update");
  assert.deepEqual(meaningfulProgress(["已定位根因", "✅ Python 脚本完成，退出码 0，耗时 13ms", "❌ 验证测试失败"]), ["已定位根因", "❌ 验证测试失败"]);
});

test("new native recovery identity keeps each bound chat on its original card, even when start beats receipt", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-capacity-cards-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starts: string[] = [], frames: Array<{ messageId: string; text: string; finalize?: boolean }> = [];
  const audience = new TurnAudienceJournal(path.join(root, "audience.json"));
  const subs: ThreadSubscription[] = ["chat-a", "chat-b"].map(key => ({ key, hostId: "local", threadId: "thread", recipientId: key, managed: false,
    client: { resumableTextStream: true, async sendText() { throw Error("no extra notices"); },
      async startTextStream() { const id = `original-${key}`; starts.push(id); return { messageId: id }; },
      async updateTextStream(frame) { frames.push(frame); } } }));
  let hold = false;
  for (const sub of subs) audience.record({ ...scope, bindingKey: sub.key, conversationId: sub.recipientId },
    { bindingKey: sub.key, conversationId: sub.recipientId, actorId: `actor-${sub.key}` });
  const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), turnAudience: audience, subscriptions: () => subs, backend: () => ({ async readThreadSnapshot() {
    return { state: { threadId: "thread", persistence: "active", runtimeStatus: "active", activeFlags: [], activeTurnId: "new-native" },
      turns: [{ id: "new-native", status: "inProgress", messages: [] }] };
  } }), holdsCapacityStart: () => hold });
  t.after(() => hub.stop());
  await hub.started("local", "thread", "failed", new Date().toISOString());
  await hub.activity("local", "thread", "failed", "实际进展");
  hold = true;
  await hub.started("local", "thread", "new-native", new Date().toISOString());
  await hub.activity("local", "thread", "new-native", "早到的进展");
  await hub.refresh();
  assert.equal(starts.length, 2);
  await hub.capacityAccepted(scope, "new-native");
  for (const sub of subs) assert.equal(audience.participants({ ...scope, turnId: "new-native", bindingKey: sub.key, conversationId: sub.recipientId })[0]?.actorId, `actor-${sub.key}`);
  hold = false;
  await hub.activity("local", "thread", "new-native", "恢复后继续执行");
  await hub.capacityTerminal({ ...scope, turnId: "new-native" }, "最终结果");
  assert.equal(starts.length, 2);
  assert.deepEqual(frames.filter(f => f.finalize).map(f => f.messageId).sort(), ["original-chat-a", "original-chat-b"]);
});
