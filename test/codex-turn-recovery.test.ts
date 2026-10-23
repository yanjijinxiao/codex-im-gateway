import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexTurnExecutionError, type CodexThreadSnapshot } from "../src/codex/backend.js";
import { codexFailureCode } from "../src/codex/turn-failure.js";
import { codexTurnRecovery, codexRecoverySummary, type CodexTurnRecovery } from "../src/codex/turn-recovery.js";
import { parseDesktopSnapshot } from "../src/codex/desktop-runner.js";
import { userFacingMessageHandlingError } from "../src/bridge/errors.js";
import { ChannelTurnPresentation } from "../src/channels/turn-presentation.js";
import { ChannelTurnTextStream, type ChannelStreamCheckpoint } from "../src/channels/progress.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-codex-app-server.mjs");
const recovery: CodexTurnRecovery = { threadId: "thread", turnId: "turn", code: "model-capacity", willRetry: true };

function transport() {
  const starts: Array<{ toUserId: string; streamId?: string }> = [];
  const frames: Array<{ messageId: string; text: string; finalize?: boolean; error?: boolean }> = [];
  return { starts, frames, client: { resumableTextStream: true,
    async sendText() { throw new Error("must not send extra notifications"); },
    async startTextStream(input: { toUserId: string; streamId?: string }) {
      starts.push(input); return { messageId: `card-${input.toUserId}-${starts.length}` };
    },
    async updateTextStream(input: { messageId: string; text: string; finalize?: boolean; error?: boolean }) { frames.push(input); }
  } };
}

test("current and legacy native errors have safe, precise classification", () => {
  for (const info of ["serverOverloaded", "ServerOverloaded", "server_overloaded"]) {
    assert.equal(codexFailureCode({ codexErrorInfo: info }), "model-capacity");
  }
  assert.equal(codexFailureCode("Selected model is at capacity. Please try a different model."), "model-capacity");
  for (const [code, expected] of [["rateLimitExceeded", "rate-limit"], ["usageLimitExceeded", "usage-limit"],
    ["sessionBudgetExceeded", "usage-limit"], ["contextWindowExceeded", "context-window"],
    ["unauthorized", "unauthorized"], ["cyberPolicy", "safety-blocked"], ["misalignmentPolicyViolation", "safety-blocked"]]) {
    assert.equal(codexFailureCode({ codexErrorInfo: code }), expected);
  }
  assert.equal(codexFailureCode({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } }), "upstream-connection");
  assert.equal(codexFailureCode({ message: "unknown", additionalDetails: "Selected model is at capacity" }), "upstream-error");
  const summary = userFacingMessageHandlingError(new CodexTurnExecutionError("failed", "PRIVATE_TOKEN", "model-capacity"));
  assert.match(summary, /容量不足/); assert.match(summary, /没有继续重试/);
  assert.doesNotMatch(summary, /PRIVATE_TOKEN/);
});

test("active Desktop error snapshots are nonterminal observations, not retry authority", () => {
  const turn = { turnId: "turn", status: "inProgress", turnStartedAtMs: 1000,
    error: { message: "Selected model is at capacity. Please try a different model.", additionalDetails: "PRIVATE_TOKEN" }, items: [] };
  const snapshot = parseDesktopSnapshot("thread", { turns: [turn], threadRuntimeStatus: { type: "active" } });
  assert.deepEqual(snapshot.state.recovery, { threadId: "thread", turnId: "turn", code: "model-capacity" });
  assert.equal(snapshot.state.lastTurnFailure, undefined);
  assert.match(codexRecoverySummary(snapshot.state.recovery!), /尚未确认是否会自动重试/);
  assert.doesNotMatch(codexRecoverySummary(snapshot.state.recovery!), /PRIVATE_TOKEN|确认.*失败/);
  assert.equal(codexTurnRecovery("thread", { ...turn, status: "failed" }), undefined);
  assert.equal(parseDesktopSnapshot("thread", { turns: [turn], threadRuntimeStatus: { type: "idle" } }).state.recovery, undefined);
});

for (const prompt of ["fixture-capacity-recovered", "fixture-capacity-before-ack", "fixture-capacity-exhausted"]) {
  test(`native recovery never resubmits or rotates a card: ${prompt}`, async t => {
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 2000, transport: {
      command: process.execPath, args: [fixture], mode: "remote-daemon"
    } });
    const io = transport();
    const stream = new ChannelTurnPresentation(io.client, "chat", { save() {} });
    t.after(async () => { await stream.suspend(); runner.close(); });
    await stream.progress("初始进展");
    const observed: CodexTurnRecovery[] = [];
    let accepted = 0;
    const run = runner.run({ cwd: "/tmp/project", threadId: "thread-existing", prompt,
      onTurnStarted() { accepted++; },
      async onRecovery(event) {
        assert.equal(accepted, 1); assert.equal(event.turnId, "turn-1");
        assert.equal(stream.checkpoint().terminal, undefined);
        observed.push(event);
        await stream.waitForRecovery(codexRecoverySummary(event));
      },
      async onProgress(text) { await stream.progress(text); }
    });
    if (prompt.endsWith("exhausted")) {
      await assert.rejects(run, error => {
        assert.ok(error instanceof CodexTurnExecutionError);
        assert.equal(error.failureCode, "model-capacity");
        return true;
      });
      assert.deepEqual(observed.map(e => e.willRetry), [true, false]);
      await stream.fail("容量不足，本轮原生执行已失败。");
    } else {
      const result = await run;
      assert.equal(result.turnId, "turn-1"); assert.equal(result.text, "恢复后的完整结果");
      assert.deepEqual(observed.map(e => e.willRetry), [true]);
      await stream.finalize(result.text);
    }
    assert.equal(accepted, 1);
    assert.equal(io.starts.length, 1);
    assert.ok(io.frames.some(f => f.text.includes("原生正在自动重试") && !f.finalize));
    assert.equal(io.frames.filter(f => f.finalize).length, 1);
    assert.ok(io.frames.every(f => f.messageId === "card-chat-1"));
    assert.doesNotMatch(io.frames.map(f => f.text).join("\n"), /PRIVATE_TOKEN|\/private\/provider/);
    assert.equal(stream.checkpoint().recoveryNotice, undefined);
    const maps = runner as unknown as { activeTurns: Map<string, string>; turnRecoveries: Map<string, CodexTurnRecovery> };
    assert.equal(maps.activeTurns.size, 0); assert.equal(maps.turnRecoveries.size, 0);
  });
}

test("retry notice survives restart on the same handle and clears on real progress", async t => {
  const io = transport();
  let saved: ChannelStreamCheckpoint | undefined;
  const first = new ChannelTurnTextStream(io.client, "chat", { save(c) { saved = c; } });
  t.after(() => first.suspend());
  await first.progress("进展");
  await first.waitForRecovery(codexRecoverySummary(recovery));
  assert.ok(saved?.recoveryNotice); assert.equal(saved?.terminal, undefined);
  await first.suspend();
  const restored = new ChannelTurnTextStream(io.client, "chat", { restore: saved, save(c) { saved = c; } });
  t.after(() => restored.suspend());
  await restored.synchronize();
  assert.equal(io.starts.length, 1);
  assert.match(io.frames.at(-1)!.text, /原生正在自动重试/);
  const count = io.frames.length;
  await restored.waitForRecovery(codexRecoverySummary(recovery));
  assert.equal(io.frames.length, count);
  await restored.progress("模型已恢复"); await restored.flush();
  assert.equal(saved?.recoveryNotice, undefined);
  assert.doesNotMatch(io.frames.at(-1)!.text, /原生正在自动重试/);
  await restored.finalize("完整结果");
  assert.equal(await restored.waitForRecovery(codexRecoverySummary(recovery)), false);
  assert.equal(io.starts.length, 1);
});

for (const channel of ["dingtalk", "weixin", "feishu", "wecom"] as const) {
  test(`${channel}: bridge native retry retains original card and does not notify completion early`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-bridge-recovery-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
    const project = store.createProject("Project", root);
    const session = store.createSession("actor", root, "Task", project.id);
    store.setSessionThread(session.id, "thread");
    const io = transport();
    const client = createChannelClient(channel, { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true }, io.client);
    const events: Array<{ success: boolean }> = [];
    let runs = 0, stream: ChannelTurnTextStream | undefined;
    const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: true },
      stateStore: store, channel: client,
      createTextStream: async () => stream = new ChannelTurnTextStream(client, "actor", { save() {} }),
      onTurnCompleted: async e => { events.push(e); },
      runner: { async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
        async run(input: import("../src/codex/backend.js").CodexRunnerInput) {
          runs++; await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" });
          await input.onProgress?.("模型已恢复，继续处理");
          await input.onRecovery?.({ ...recovery, turnId: "other" });
          assert.equal(stream?.checkpoint().recoveryNotice, undefined);
          await input.onRecovery?.(recovery);
          assert.match(stream!.checkpoint().recoveryNotice!, /原生正在自动重试/);
          assert.equal(stream?.checkpoint().terminal, undefined);
          assert.equal(events.length, 0);
          await input.onProgress?.("模型已恢复，继续处理");
          assert.equal(stream?.checkpoint().recoveryNotice, undefined);
          return { threadId: "thread", turnId: "turn", text: "完整答案", raw: "" };
        }, async stop() { throw new Error("must not stop or replay native work"); } } as never
    });
    t.after(async () => { await stream?.suspend(); });
    await service.handleMessage({ id: "first", senderId: "actor", text: "legitimate request", raw: {} });
    assert.equal(runs, 1); assert.equal(io.starts.length, 1);
    assert.equal(io.frames.filter(f => f.finalize).length, 1);
    assert.deepEqual(events.map(e => e.success), [true]);
    assert.equal(store.getBoundSession("actor")?.id, session.id);
  });
}

test("managed Desktop snapshot recovery updates only its existing current-turn card", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-managed-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const io = transport();
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", client: io.client, managed: true };
  let observed = recovery;
  const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), subscriptions: () => [sub],
    backend: () => ({ async readThreadSnapshot() { return { state: { threadId: "thread", persistence: "active", runtimeStatus: "active",
      activeFlags: [], activeTurnId: "turn", recovery: observed }, turns: [{ id: "turn", status: "inProgress", messages: [] }] } as CodexThreadSnapshot; } }) });
  t.after(() => hub.stop());
  await hub.managedTurnStarted(sub, "turn");
  const stream = hub.managedStream(sub);
  await stream.progress("初始进展");
  await hub.refresh();
  assert.match(io.frames.at(-1)!.text, /原生正在自动重试/);
  assert.equal(stream.checkpoint().terminal, undefined);
  observed = { ...recovery, turnId: "foreign" };
  const count = io.frames.length;
  await hub.refresh();
  assert.equal(io.frames.length, count); assert.equal(io.starts.length, 1);
});

test("read-only multi-binding follow projects recovery without new cards or execution", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const io = transport();
  const subs: ThreadSubscription[] = ["chat1", "chat2"].map(key => ({
    key, recipientId: key, hostId: "local", threadId: "thread", client: io.client, managed: false
  }));
  let snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "active",
    activeFlags: [], activeTurnId: "turn", recovery }, turns: [{ id: "turn", status: "inProgress", messages: [] }] };
  const options = { filePath: path.join(root, "follow.json"), subscriptions: () => subs,
    backend: () => ({ async readThreadSnapshot() { return snapshot; } }) };
  let hub = new ThreadEventHub(options);
  t.after(() => hub.stop());
  await hub.refresh();
  assert.equal(io.starts.length, 2);
  assert.ok(io.frames.every(f => !f.finalize));
  assert.match(io.frames.at(-1)!.text, /原生正在自动重试/);
  await hub.stop();
  hub = new ThreadEventHub(options);
  await hub.refresh();
  assert.equal(io.starts.length, 2);
  snapshot = { state: { ...snapshot.state, runtimeStatus: "idle", recovery: undefined, activeTurnId: undefined,
    lastTurnFailure: { turnId: "turn", code: "model-capacity" } }, turns: [{ id: "turn", status: "failed", messages: [] }] };
  await hub.refresh();
  assert.equal(io.starts.length, 2);
  assert.equal(io.frames.filter(f => f.finalize).length, 2);
  assert.ok(io.frames.filter(f => f.finalize).every(f => f.text.includes("容量不足")));
  await hub.refresh();
  assert.equal(io.frames.filter(f => f.finalize).length, 2);
});
