import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { HybridCodexRunner } from "../src/codex/runner.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("uses the Codex V2 initialize, thread, and turn lifecycle", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

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

  assert.deepEqual(await runner.listSessions(), {
    data: [{ id: "thread-new" }],
    nextCursor: null,
    backwardsCursor: null
  });

  assert.deepEqual(await runner.getHistory("thread-existing"), [
    {
      id: "history-user-1",
      role: "user",
      text: "hello history",
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

test("routes command, file, and permission approvals to the active channel turn", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  for (const kind of ["command", "file", "permissions"] as const) {
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runner.stop("thread-stop");
  }
  const result = await outcome;
  assert.match(result.error?.message ?? "", /interrupted/i);
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

test("auto backend falls back to codex exec for an existing thread", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "continue",
    cwd: fixturesDir,
    threadId: "thread-existing"
  });

  assert.equal(result.threadId, "thread-existing");
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-resumed/);
});

test("exec backend uses app-server when true streaming is requested", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
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

  assert.deepEqual(deltas, ["reply:", "stream"]);
  assert.equal(result.text, "reply:stream");
});

test("streaming fallback to exec sends only the final answer", async (t) => {
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
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-new/);
});
