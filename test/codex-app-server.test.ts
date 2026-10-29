import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexThreadStateError, CodexTurnExecutionError } from "../src/codex/backend.js";
import { userFacingMessageHandlingError } from "../src/bridge/errors.js";
import { HybridCodexRunner } from "../src/codex/runner.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";

test("a read-only RPC timeout preserves the live transport and does not run a prompt", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 1000, transport: {
    command: process.execPath, args: [path.join(fixturesDir, "fake-codex-app-server.mjs")], mode: "remote-daemon"
  } });
  t.after(() => runner.close());
  await runner.getRuntimeInfo("/tmp/project");
  const processIdentity = (runner as unknown as { child: { pid: number } }).child.pid;
  await assert.rejects(runner.inspectThread("thread-read-unresponsive", { includeTurns: false, timeoutMs: 25 }),
    e => e instanceof CodexCommunicationError && e.submission === "not-submitted" && e.operation === "thread/read");
  await runner.getRuntimeInfo("/tmp/project");
  assert.equal((runner as unknown as { child: { pid: number } }).child.pid, processIdentity);
});

test("an unconfirmed turn/start receipt neither closes the transport nor repeats turn/start", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 50, transport: {
    command: process.execPath, args: [path.join(fixturesDir, "fake-codex-app-server.mjs")], mode: "remote-daemon"
  } });
  t.after(() => runner.close());
  await assert.rejects(runner.run({ cwd: "/tmp/project", threadId: "thread-existing", prompt: "delayed-turn-receipt" }),
    e => e instanceof CodexCommunicationError && e.submission === "unconfirmed" && e.operation === "turn/start");
  const processIdentity = (runner as unknown as { child: { pid: number } }).child.pid;
  const result = await runner.run({ cwd: "/tmp/project", threadId: "thread-existing", prompt: "next-prompt" });
  assert.equal(result.turnId, "turn-2");
  assert.equal((runner as unknown as { child: { pid: number } }).child.pid, processIdentity);
});

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("ordinary execution inspection gets metadata and one item-free turn, without full history or prompt submission", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 2000, transport: {
    command: process.execPath, args: [path.join(fixturesDir, "fake-codex-app-server.mjs"), "--bounded-inspection"], mode: "remote-daemon"
  } });
  t.after(() => runner.close());
  const state = await runner.inspectThread("thread-external-busy");
  assert.equal(state.runtimeStatus, "active"); assert.equal(state.activeTurnId, "external-turn");
  assert.equal(state.latestTurnStatus, "inProgress");
  assert.equal(runner.hasRestartBlockingWork(), false);
});

test("resuming an old thread and waiting for idle never requests its unbounded history", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 2000, transport: {
    command: process.execPath, args: [path.join(fixturesDir, "fake-codex-app-server.mjs"), "--bounded-inspection"], mode: "remote-daemon"
  } });
  t.after(() => runner.close());
  const result = await runner.run({ threadId: "thread-existing", cwd: "/tmp/project", prompt: "bounded-old-thread" });
  assert.equal(result.text, "reply:bounded-old-thread");
});

for (const [prompt, code] of [["fixture-safety-block", "unintended-activity"], ["fixture-coded-failure", "context-window"]] as const) {
  test(`native App Server failures retain normalized reasons and explicit systemError: ${code}`, async t => {
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 2_000, transport: {
      command: process.execPath, args: [path.join(fixturesDir, "fake-codex-app-server.mjs")], mode: "remote-daemon"
    } });
    t.after(() => runner.close());
    let accepted = 0;
    await assert.rejects(runner.run({ cwd: "/tmp/project", threadId: "thread-existing", prompt, onTurnStarted() { accepted++; } }), error => {
      assert.ok(error instanceof CodexTurnExecutionError);
      assert.equal(error.failureCode, code);
      assert.doesNotMatch(userFacingMessageHandlingError(error), /PRIVATE_TOKEN|本轮消息处理失败/);
      return true;
    });
    assert.equal(accepted, 1);
    const states = (runner as unknown as { threadStates: Map<string, import("../src/codex/backend.js").CodexThreadState> }).threadStates;
    assert.equal(states.get("thread-existing")?.runtimeStatus, "systemError");
    assert.deepEqual(states.get("thread-existing")?.lastTurnFailure, { turnId: "turn-1", code });
  });
}

for (const prompt of ["fixture-failure-before-ack", "fixture-error-before-ack"]) {
test(`a start acknowledgement cannot overwrite newer native failure state: ${prompt}`, async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 2_000, transport: {
    command: process.execPath, args: [path.join(fixturesDir, "fake-codex-app-server.mjs")], mode: "remote-daemon"
  } });
  t.after(() => runner.close());
  let accepted = 0;
  await assert.rejects(runner.run({ cwd: "/tmp/project", threadId: "thread-existing",
    prompt, onTurnStarted() { accepted++; } }),
    error => error instanceof CodexTurnExecutionError && error.failureCode === "context-window");
  const internal = runner as unknown as { activeTurns: Map<string, string>;
    threadStates: Map<string, import("../src/codex/backend.js").CodexThreadState> };
  assert.equal(accepted, 1);
  assert.equal(internal.activeTurns.has("thread-existing"), false);
  assert.equal(internal.threadStates.get("thread-existing")?.runtimeStatus, "systemError");
  assert.deepEqual(internal.threadStates.get("thread-existing")?.lastTurnFailure,
    { turnId: "turn-1", code: "context-window" });
});
}

test("native queue add/list/delete/start consumes the stored item and retains approval callbacks", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 2_000, transport: {
    command: process.execPath, args: [path.join(fixturesDir, "fake-codex-app-server.mjs")], mode: "remote-daemon"
  } });
  t.after(() => runner.close());
  const discarded = await runner.addQueuedSubmission({ threadId: "thread-existing", prompt: "discard", clientUserMessageId: "client-discard" });
  assert.equal(await runner.deleteQueuedSubmission("thread-existing", discarded.id), true);
  const item = await runner.addQueuedSubmission({ threadId: "thread-existing", prompt: "approval:command", clientUserMessageId: "client-next", onApproval: async () => "accept" });
  assert.equal((await runner.listQueuedSubmissions("thread-existing")).data[0].id, item.id);
  const events: string[] = [];
  const result = await runner.runQueuedSubmission({ threadId: "thread-existing", queuedSubmissionId: item.id,
    cwd: "/tmp/project", onQueueStarting: () => { events.push("submitting"); },
    onTurnStarted: () => { events.push("accepted"); }, onApproval: async () => { events.push("approval"); return "accept"; } });
  assert.equal(result.threadId, "thread-existing");
  assert.equal(events[0], "submitting");
  assert.deepEqual(events.slice(1).sort(), ["accepted", "approval"]);
  assert.equal((await runner.listQueuedSubmissions("thread-existing")).data.length, 0);
  await assert.rejects(runner.runQueuedSubmission({ threadId: "thread-existing", queuedSubmissionId: item.id, cwd: "/tmp/project" }), /原生队列已发生变化/);
});

test("an older app-server explicitly rejects native queue without execution fallback", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 2_000, transport: {
    command: process.execPath, args: [path.join(fixturesDir, "fake-codex-app-server.mjs"), "--without-queue-api"], mode: "remote-daemon"
  } }); t.after(() => runner.close());
  await assert.rejects(runner.addQueuedSubmission({ threadId: "thread-existing", prompt: "never execute", clientUserMessageId: "client-id" }), /does not support nativeQueue/);
});

for (const infer of [false, true]) {
  test(`independent app-server start has no project and clears unexpected assignment: infer=${infer}`, async t => {
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 2_000, transport: {
      command: process.execPath,
      args: [path.join(fixturesDir, "fake-codex-app-server.mjs"), ...(infer ? ["--infer-new-project"] : [])],
      mode: "remote-daemon"
    } });
    t.after(() => runner.close());
    const result = await runner.run({ cwd: "/tmp/project", prompt: "verify-standalone", projectBinding: "none" });
    assert.equal(result.text, "reply:verify-standalone");
    await assert.rejects(runner.run({ cwd: "/tmp/project", prompt: "invalid", projectBinding: "none", projectName: "Must not bind" }), /independent session cannot/);
  });
}

function pickState(state: {
  persistence: string;
  runtimeStatus: string;
  latestTurnStatus?: string;
}) {
  return {
    persistence: state.persistence,
    runtimeStatus: state.runtimeStatus,
    latestTurnStatus: state.latestTurnStatus
  };
}

test("uses the Codex V2 initialize, thread, and turn lifecycle", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  assert.deepEqual(await runner.listProjects(), {
    backend: "app-server",
    projects: [{
      id: "project-native",
      name: "Fixture Project",
      roots: ["/tmp/project"]
    }]
  });

  const deltas: string[] = [];
  const progress: string[] = [];
  const first = await runner.run({
    prompt: "first",
    cwd: "/tmp/project",
    model: "test-model",
    effort: "high",
    onDelta: async (delta) => {
      deltas.push(delta);
    },
    onProgress: async (message) => {
      progress.push(message);
    }
  });
  assert.equal(first.threadId, "thread-new");
  assert.equal(first.text, "reply:first");
  assert.deepEqual(deltas, ["reply:", "first"]);
  assert.deepEqual(progress, ["working:first"]);
  assert.match(first.raw, /item\/completed/);
  assert.match(first.raw, /turn\/completed/);
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-new"), {
    model: "test-model",
    effort: "high"
  });

  const resumed = await runner.run({
    prompt: "second",
    cwd: "/tmp/project",
    threadId: "thread-existing"
  });
  assert.equal(resumed.threadId, "thread-existing");
  assert.equal(resumed.text, "reply:second");
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-existing"), {
    model: "resumed-model",
    effort: "medium"
  });

  const resumedAgain = await runner.run({
    prompt: "third",
    cwd: "/tmp/project",
    threadId: "thread-existing"
  });
  assert.equal(resumedAgain.text, "reply:third");

  const listed = await runner.listThreads({ cwd: "/tmp/project", persistence: "all" });
  assert.equal(listed.find((thread) => thread.threadId === "thread-new")?.persistence, "active");
  assert.equal(listed.find((thread) => thread.threadId === "thread-archived")?.persistence, "archived");
  assert.equal(listed.find((thread) => thread.threadId === "thread-system-error")?.runtimeStatus, "systemError");

  assert.deepEqual(await runner.getHistory("thread-existing"), [
    {
      id: "history-user-1",
      role: "user",
      text: "hello history",
      turnId: "history-turn-1",
      turnStatus: "completed",
      createdAt: "2023-11-14T22:13:20.000Z"
    },
    {
      id: "history-commentary-1",
      role: "assistant",
      text: "working",
      kind: "progress",
      createdAt: "2023-11-14T22:13:22.000Z"
    },
    {
      id: "history-assistant-1",
      role: "assistant",
      text: "history reply",
      createdAt: "2023-11-14T22:13:22.000Z"
    }
  ]);
  assert.deepEqual(await runner.getHistoryPage("thread-existing", {
    limit: 10,
    sortDirection: "asc"
  }), {
    messages: [
      {
        id: "history-user-1",
        role: "user",
        text: "hello history",
        turnId: "history-turn-1",
        turnStatus: "completed",
        createdAt: "2023-11-14T22:13:20.000Z"
      },
      {
        id: "history-commentary-1",
        role: "assistant",
        text: "working",
        kind: "progress",
        createdAt: "2023-11-14T22:13:22.000Z"
      },
      {
        id: "history-assistant-1",
        role: "assistant",
        text: "history reply",
        createdAt: "2023-11-14T22:13:22.000Z"
      }
    ],
    nextCursor: "older-page",
    backwardsCursor: "newer-page"
  });

  assert.deepEqual(await runner.getRuntimeInfo("/tmp/another-project"), {
    model: "configured-model",
    effort: "high",
    provider: "FixtureProvider"
  });
  assert.deepEqual(await runner.listModels(), [{
    model: "configured-model",
    displayName: "Configured Model",
    description: "Model used by the test fixture.",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deeper reasoning" }
    ]
  }]);
  assert.deepEqual(await runner.getAccountRateLimits(), {
    limitId: "codex",
    limitName: "Codex",
    planType: "plus",
    primary: { usedPercent: 18.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
    credits: { hasCredits: true, unlimited: false, balance: "12.34" },
    spendControlReached: false
  });
});

test("binds new threads to the native app-server project and keeps Bridge policy out of the title", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());
  const created: string[] = [];

  const result = await runner.run({
    prompt: "verify-thread-metadata",
    developerInstructions: "bridge-only-policy",
    cwd: "/tmp/project",
    projectId: "desktop-project-id",
    projectName: "Fixture Project",
    threadTitle: "干净的用户标题",
    onThreadCreated: (threadId) => {
      created.push(threadId);
    }
  });

  assert.equal(result.text, "reply:verify-thread-metadata");
  assert.deepEqual(created, ["thread-new"]);

  const repaired = await runner.run({
    prompt: "verify-thread-metadata",
    developerInstructions: "bridge-only-policy",
    cwd: "/tmp/project",
    projectId: "desktop-project-id",
    projectName: "Fixture Project",
    threadId: "thread-bridge-title",
    threadTitle: "干净的用户标题"
  });
  assert.equal(repaired.text, "reply:verify-thread-metadata");
});

test("starts a remote thread by cwd when the daemon has no project catalog API", async (t) => {
  const runner = new AppServerCodexRunner({
    requestTimeoutMs: 2_000,
    transport: {
      command: process.execPath,
      args: [path.join(fixturesDir, "fake-codex-app-server.mjs"), "--without-project-api"],
      mode: "remote-daemon"
    }
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "legacy-remote-project",
    cwd: "/home/admin/legacy-project",
    projectId: "desktop-remote-project",
    projectName: "Legacy Remote Project"
  });

  assert.equal(result.threadId, "thread-new");
  assert.equal(result.text, "reply:legacy-remote-project");
  assert.deepEqual(await runner.listProjects(), { backend: "app-server", projects: [] });
});

test("keeps an active channel turn alive from its latest progress reply", async (t) => {
  // Given: a turn whose progress arrives before the timeout and final answer arrives after the original deadline.
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 200
  });
  t.after(() => runner.close());

  const progress: string[] = [];

  // When: the originating channel receives progress during the active turn.
  const result = await runner.run({
    prompt: "sliding-timeout",
    cwd: "/tmp/project",
    onProgress: (message) => progress.push(message)
  });

  // Then: the timeout is measured from that reply and the final answer completes.
  assert.deepEqual(progress, ["working:sliding-timeout"]);
  assert.equal(result.text, "reply:sliding-timeout");
});

test("lets an accepted agent turn run past the RPC timeout without requiring activity", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 100
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "silent-long",
    cwd: "/tmp/project"
  });

  assert.equal(result.text, "reply:silent-long");
});

test("recycles a private stdio app-server after the last turn releases its thread", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  await runner.run({ prompt: "release-writer", cwd: "/tmp/project" });

  assert.equal((runner as unknown as { child?: unknown }).child, undefined);
});

test("streams safe tool status and readable reasoning summaries as progress", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());
  const progress: string[] = [];

  await runner.run({
    prompt: "detailed-progress",
    cwd: "/tmp/project",
    onProgress: (message) => progress.push(message)
  });

  assert.equal(progress.some((message) => /正在执行命令.*npm test/.test(message)), true);
  assert.equal(progress.some((message) => /命令完成.*退出码 0/.test(message)), true);
  assert.equal(progress.some((message) => message === "🤔 正在分析测试结果并决定下一步"), true);
});

test("propagates the configured sandbox to an app-server turn", async (t) => {
  // Given: a bridge configured to allow Codex full workspace access.
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000,
    execSandbox: "danger-full-access"
  });
  t.after(() => runner.close());

  // When: a message starts a turn through the app-server path used by channel streaming.
  const result = await runner.run({
    prompt: "verify-danger-full-access",
    cwd: "/tmp/project",
    threadId: "thread-existing"
  });

  // Then: the downstream app-server accepts the expected policy and completes the turn.
  assert.equal(result.text, "reply:verify-danger-full-access");
});

test("runs AI classification on a persistent ephemeral app-server thread", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000,
    execSandbox: "danger-full-access"
  });
  t.after(() => runner.close());

  const result = await runner.runEphemeral({
    prompt: "classify-intent",
    cwd: "/tmp",
    outputSchema: {
      type: "object",
      properties: { intent: { type: "string" } },
      required: ["intent"]
    }
  });

  assert.equal(result.text, "reply:classify-intent");
});

test("registers llm-wiki dynamic tools and routes autonomous tool calls", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());
  const calls: unknown[] = [];

  const result = await runner.run({
    prompt: "dynamic-tool",
    cwd: "/tmp/current-project",
    dynamicTools: [{ type: "namespace", name: "knowledge", description: "read only", tools: [] }],
    onDynamicToolCall: async (call) => {
      calls.push(call);
      return JSON.stringify({ result: [{ anchor: "wiki/fixture.md#answer" }] });
    }
  });

  assert.match(result.text, /wiki\/fixture\.md#answer/);
  assert.deepEqual(calls, [{
    callId: "tool-turn-1",
    threadId: "thread-new",
    turnId: "turn-1",
    namespace: "knowledge",
    tool: "search",
    arguments: { query: "fixture", limit: 3 }
  }]);
});

test("routes Codex request_user_input through a channel-native answer handler", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());
  const receipts: string[] = [];

  const result = await runner.run({
    prompt: "request-user-input",
    cwd: "/tmp/project",
    onUserInput: async (request) => {
      assert.equal(request.questions[0]?.options?.[0]?.label, "方案 A");
      assert.equal(request.requestId, "input-turn-1");
      return { direction: { answers: ["方案 A"] } };
    },
    onUserInputResult: (_request, result) => { receipts.push(result); }
  });

  assert.equal(result.text, "input:方案 A");
  assert.deepEqual(receipts, ["confirmed"]);
});

test("App Server resolved request invalidates a pending IM answer without synthetic skip", async t => {
  const runner = new AppServerCodexRunner({ codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"), requestTimeoutMs: 2000 });
  t.after(() => runner.close());
  const receipts: string[] = [];
  let release!: (answer: Record<string, { answers: string[] }>) => void;
  await assert.rejects(runner.run({ prompt: "withdraw-user-input", cwd: "/tmp/project",
    onUserInput: async () => new Promise(resolve => { release = resolve; }),
    onUserInputResult: (_request, result) => { receipts.push(result); } }), /interrupted/);
  release({ direction: { answers: ["late"] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(receipts, ["withdrawn"]);
});

test("declares experimentalApi before starting plan collaboration mode and manages native thread goals", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "plan-mode",
    cwd: "/tmp/project",
    model: "configured-model",
    collaborationMode: "plan"
  });
  assert.equal(result.text, "reply:plan-mode");

  const goal = await runner.setGoal(result.threadId, { objective: "完成渠道问答", status: "active", tokenBudget: 5000 });
  assert.equal(goal?.objective, "完成渠道问答");
  assert.equal((await runner.getGoal(result.threadId))?.tokenBudget, 5000);
  await runner.clearGoal(result.threadId);
  assert.equal(await runner.getGoal(result.threadId), undefined);
});

test("routes command, file, permission and simple MCP approvals to the active channel turn", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  for (const kind of ["command", "file", "permissions", "mcp"] as const) {
    const requests: Array<{ kind: string; command?: string; reason?: string }> = [];
    const result = await runner.run({
      prompt: `approval:${kind}`,
      cwd: "/tmp/project",
      threadId: `thread-approval-${kind}`,
      onApproval: async (request) => {
        requests.push(request);
        return "accept";
      }
    });

    assert.equal(result.text, `approval:${kind}:accept`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, kind);
    assert.match(requests[0]?.reason ?? "", new RegExp(kind));
    if (kind === "command") assert.equal(requests[0]?.command, "touch approved.txt");
  }
});

test("CLI app-server deduplicates native MCP identity and confirms the exact persistent decision", async t => {
  const runner = new AppServerCodexRunner({ codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"), requestTimeoutMs: 2000 });
  t.after(() => runner.close());
  let calls = 0;
  const receipts: string[] = [];
  const result = await runner.run({ prompt: "approval:mcp-persist", cwd: "/tmp/project", threadId: "thread-persist",
    onApproval: request => {
      calls++; assert.equal(request.hostId, "local"); assert.match(request.nativeKey!, /app-server/);
      assert.deepEqual(request.options?.map(o => o.id), ["session", "always", "decline"]);
      return "always";
    }, onApprovalResult: (_request, result) => { receipts.push(result); } });
  assert.equal(result.text, "approval:mcp-persist:accept");
  assert.equal(calls, 1); assert.deepEqual(receipts, ["confirmed"]);
});

test("CLI app-server preserves command, file and extra-permission session decisions", async t => {
  const runner = new AppServerCodexRunner({ codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"), requestTimeoutMs: 2000 });
  t.after(() => runner.close());
  for (const kind of ["command", "file", "permissions"]) {
    const receipts: string[] = [];
    const result = await runner.run({ prompt: `approval:${kind}`, cwd: "/tmp/project", threadId: `session-${kind}`,
      onApproval: () => "session", onApprovalResult: (_request, result) => { receipts.push(result); } });
    assert.equal(result.text, `approval:${kind}:${kind === "permissions" ? "accept" : "acceptForSession"}`);
    assert.deepEqual(receipts, ["confirmed"]);
  }
});

test("declines an app-server approval when the channel rejects it", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "approval:command",
    cwd: "/tmp/project",
    threadId: "thread-approval-decline",
    onApproval: async () => "decline"
  });

  assert.equal(result.text, "approval:command:decline");
});

test("App Server and Desktop share the typed MCP form mapping and native resolution receipts", async t => {
  const runner = new AppServerCodexRunner({ codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"), requestTimeoutMs: 2000 });
  t.after(() => runner.close()); const receipts: string[] = [];
  const result = await runner.run({ prompt: "approval:mcp-form", cwd: "/tmp/project", onApproval: () => { throw Error("not an approval"); },
    onUserInput: async request => { assert.equal(request.questions[0].valueSchema?.type, "integer"); return { count: { answers: ["2"] }, enabled: { answers: ["false"] } }; },
    onUserInputResult: (_request, result) => { receipts.push(result); } });
  assert.equal(result.text, "approval:mcp-form:accept"); assert.deepEqual(receipts, ["confirmed"]);
});

test("interrupts the active V2 turn with both threadId and turnId", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const run = runner.run({ prompt: "hold", cwd: "/tmp/project", threadId: "thread-stop" });
  const outcome = run.then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error })
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await runner.stop("thread-other"), "not-active");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (await runner.stop("thread-stop") === "interrupted") break;
  }
  const result = await outcome;
  assert.match(result.error?.message ?? "", /interrupted/i);
});

test("steers an active turn with an expected-turn compare guard", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  let started: { threadId: string; turnId: string } | undefined;
  const outcome = runner.run({ prompt: "hold", cwd: "/tmp/project", threadId: "thread-steer",
    onTurnStarted: (event) => { started = event; }
  });
  let activeTurnId: string | undefined;
  for (let attempt = 0; attempt < 20 && !activeTurnId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    activeTurnId = (await runner.inspectThread("thread-steer")).activeTurnId;
  }
  assert.equal(activeTurnId, "turn-1");
  assert.deepEqual(started, { threadId: "thread-steer", turnId: "turn-1" });

  assert.deepEqual(await runner.steer({
    threadId: "thread-steer",
    expectedTurnId: activeTurnId,
    prompt: "优先修复测试"
  }), {
    status: "accepted",
    threadId: "thread-steer",
    turnId: "turn-1"
  });
  assert.equal((await outcome).text, "steered:优先修复测试");
});

test("rejects steering when the thread has no active turn", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  await assert.rejects(
    runner.steer({ threadId: "thread-existing", prompt: "too late" }),
    /没有正在执行的任务|no active turn/i
  );
});

test("models active, archived, missing, and system-error thread lifecycle states", async (t) => {
  const runner = new AppServerCodexRunner({
    requestTimeoutMs: 2_000,
    transport: {
      command: process.execPath,
      args: [path.join(fixturesDir, "fake-codex-app-server.mjs")],
      mode: "daemon-proxy"
    }
  });
  t.after(() => runner.close());

  assert.deepEqual(
    pickState(await runner.inspectThread("thread-existing")),
    { persistence: "active", runtimeStatus: "idle", latestTurnStatus: "completed" }
  );
  assert.deepEqual(
    pickState(await runner.inspectThread("thread-archived")),
    { persistence: "archived", runtimeStatus: "notLoaded", latestTurnStatus: undefined }
  );
  assert.deepEqual(
    pickState(await runner.inspectThread("thread-missing")),
    { persistence: "missing", runtimeStatus: "unknown", latestTurnStatus: undefined }
  );
  assert.equal((await runner.inspectThread("thread-system-error")).runtimeStatus, "systemError");

  await assert.rejects(
    runner.run({ prompt: "must-not-run", cwd: "/tmp/project", threadId: "thread-archived" }),
    (error) => error instanceof CodexThreadStateError && error.code === "archived"
  );
  await assert.rejects(
    runner.run({ prompt: "must-not-run", cwd: "/tmp/project", threadId: "thread-system-error" }),
    (error) => error instanceof CodexThreadStateError && error.code === "system-error"
  );

  await runner.archiveThread("thread-existing");
  assert.equal((await runner.inspectThread("thread-existing")).persistence, "archived");
  assert.equal((await runner.unarchiveThread("thread-existing")).persistence, "active");
  await runner.deleteThread("thread-existing");
  assert.equal((await runner.inspectThread("thread-existing")).persistence, "missing");
});

test("serializes concurrent turns for the same managed session", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());

  const completionOrder: string[] = [];
  const first = runner.run({
    prompt: "slow:first",
    cwd: "/tmp/project",
    queueKey: "managed-session"
  }).then(() => completionOrder.push("first"));
  const second = runner.run({
    prompt: "second",
    cwd: "/tmp/project",
    queueKey: "managed-session"
  }).then(() => completionOrder.push("second"));

  await Promise.all([first, second]);
  assert.deepEqual(completionOrder, ["first", "second"]);
});

test("waits for an existing thread turn before continuing it", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const progress: string[] = [];
  const result = await runner.run({
    prompt: "continue",
    cwd: "/tmp/project",
    threadId: "thread-external-busy",
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.text, "reply:continue");
  assert.deepEqual(progress, ["当前会话的上一条任务仍在执行，已排队等待完成。", "working:continue"]);
});

test("auto backend never moves an existing thread to CLI after an app-server failure", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());

  await assert.rejects(runner.run({
    prompt: "continue",
    cwd: fixturesDir,
    threadId: "thread-existing"
  }));
});

test("relays a Desktop-owned thread through the Desktop follower runner", async (t) => {
  const relayed: Array<Record<string, unknown>> = [];
  const desktopRunner = {
    async run(input: Record<string, unknown>) {
      relayed.push(input);
      return {
        threadId: String(input.threadId),
        turnId: "turn-desktop",
        text: "desktop-relayed",
        raw: "desktop"
      };
    },
    async stop() {},
    close() {}
  };
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000,
    desktopRunner
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "continue in Desktop",
    cwd: "/tmp/project",
    threadId: "thread-desktop-owned",
    onApproval: async () => "accept"
  });

  assert.equal(result.text, "desktop-relayed");
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0]?.threadId, "thread-desktop-owned");
});

test("refreshes the Desktop task list when a local app-server thread is created and completed", async (t) => {
  const refreshedThreadIds: Array<string | undefined> = [];
  const desktopRunner = {
    async run() {
      throw new Error("Desktop relay should not be used for a new thread");
    },
    async stop() {
      return "not-active" as const;
    },
    async refreshTaskList(threadId?: string) {
      refreshedThreadIds.push(threadId);
    },
    close() {}
  };
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000,
    desktopRunner
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "new Desktop-visible task",
    cwd: "/tmp/project"
  });

  assert.equal(result.threadId, "thread-new");
  assert.deepEqual(refreshedThreadIds, ["thread-new", "thread-new"]);
});

test("exec backend stays on codex exec even when streaming callbacks are present", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  const deltas: string[] = [];

  const result = await runner.run({
    prompt: "stream",
    cwd: fixturesDir,
    onDelta: (delta) => {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, []);
  assert.equal(result.text, "exec-new");
});

test("app-server backend never silently falls back to codex exec", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  await assert.rejects(
    runner.run({ prompt: "stream", cwd: fixturesDir }),
    /app-server|initialize|exited|closed/i
  );
});

test("ordinary App Server turn/start transmits the stable source identity", async t => {
  const runner = new AppServerCodexRunner({ codexBin: path.join(fixturesDir, 'fake-codex-app-server.mjs'), requestTimeoutMs: 2000 });
  t.after(() => runner.close());
  const result = await runner.run({ cwd: '/tmp/project', threadId: 'thread-existing', prompt: 'fixture-stable-origin', clientUserMessageId: 'gateway-original-source' });
  assert.equal(result.text, 'reply:fixture-stable-origin');
});
