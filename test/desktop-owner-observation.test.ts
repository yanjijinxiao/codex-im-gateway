import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DesktopCodexRunner, type DesktopOwnerObservationDiagnostic } from "../src/codex/desktop-runner.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { CodexBackendRouter } from "../src/codex/runner.js";

type Stage = "connect" | "initialize" | "discovery" | "snapshot";
type Options = {
  stage?: Stage;
  failure?: "timeout" | "disconnect" | "reject" | "no-owner" | "late-no-owner" | "invalid-initialize";
  alwaysFail?: boolean;
  healthyDelayMs?: number;
  observationTimeoutMs?: number;
  timeoutMs?: number;
  defaultBudget?: boolean;
  ownerAbsent?: boolean;
  runtime?: "active" | "idle";
  cwd?: string;
  writeTimeout?: boolean;
  onDiagnostic?: (event: DesktopOwnerObservationDiagnostic, runner: DesktopCodexRunner) => void;
};

/** Real framed Unix IPC, not a mocked submit method: count every native write. */
async function fixture(t: test.TestContext, options: Options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-owner-observe-"));
  fs.mkdirSync(path.join(root, "sessions"));
  const socketPath = path.join(root, "ipc.sock");
  const sockets = new Set<net.Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const diagnostics: DesktopOwnerObservationDiagnostic[] = [];
  const received: { attempt: number; method: string; params: unknown }[] = [];
  let connections = 0;
  let sawFault!: () => void;
  const fault = new Promise<void>(resolve => { sawFault = resolve; });
  const server = net.createServer(socket => {
    const attempt = ++connections;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (buffer.length < size + 4) return;
        const m = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        received.push({ attempt, method: m.method, params: m.params });
        const send = (value: object, delay = 0) => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (socket.destroyed) return;
            const payload = Buffer.from(JSON.stringify(value));
            const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
            socket.write(Buffer.concat([header, payload]));
          }, delay);
          timers.add(timer);
        };
        const reply = (result: unknown, error?: string, delay = 0) => send({ type: "response", requestId: m.requestId,
          ...(error ? { resultType: "error", error } : { resultType: "success", result }) }, delay);
        const stage = m.method === "initialize" ? "initialize" : m.method === "thread-owner-discovery" ? "discovery"
          : m.method === "thread-stream-following-changed" ? "snapshot" : undefined;
        if (stage === options.stage && (attempt === 1 || options.alwaysFail)) {
          sawFault();
          if (options.failure === "disconnect") socket.destroy();
          else if (options.failure === "reject") reply({}, "permission denied: timeout secret-provider-body");
          else if (options.failure === "no-owner") reply({}, "no-client-found");
          else if (options.failure === "late-no-owner") reply({}, "no-client-found", 80);
          else if (options.failure === "invalid-initialize") reply({});
          // No response simulates the historical owner-snapshot timeout.
          continue;
        }
        const delay = options.healthyDelayMs ?? 0;
        if (m.method === "initialize") reply({ clientId: "reader" }, undefined, delay);
        if (m.method === "thread-owner-discovery") reply({}, options.ownerAbsent ? "no-client-found" : undefined, delay);
        if (m.method === "thread-stream-following-changed") send({ type: "broadcast", method: "thread-stream-state-changed",
          params: { conversationId: "thread", hostId: "local", change: { type: "snapshot", conversationState: {
            title: `fresh-${attempt}`, threadRuntimeStatus: { type: options.runtime ?? "active" },
            ...(options.cwd ? { cwd: options.cwd } : {}),
            turns: [{ turnId: `turn-${attempt}`, status: "inProgress", items: [] }]
          } } } }, delay);
        if (m.method === "thread-follower-steer-turn" && !options.writeTimeout) reply({ turnId: `turn-${attempt}` });
        if (m.method === "thread-follower-start-turn" && !options.writeTimeout) reply({}); // invalid receipt ends run without a native task
      }
    });
  });
  const listen = () => new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  if (options.stage !== "connect") await listen();
  let listening: Promise<void> | undefined;
  const runner = new DesktopCodexRunner({ socketPath, codexHome: root, timeoutMs: options.timeoutMs ?? 1_000,
    observationTimeoutMs: options.defaultBudget ? undefined : options.observationTimeoutMs ?? 100,
    onObservationDiagnostic(event) {
      diagnostics.push(event);
      if (options.stage === "connect" && event.outcome === "retrying" && !options.alwaysFail) listening = listen();
      options.onDiagnostic?.(event, runner);
    } });
  t.after(async () => {
    runner.close();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await listening;
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runner, diagnostics, received, fault, connections: () => connections,
    writes: () => received.filter(m => /start-turn|steer-turn|interrupt-turn/.test(m.method)) };
}

const input = { threadId: "thread", prompt: "private-prompt-never-log", cwd: "/tmp", clientUserMessageId: "im-id" };

test("live owner metadata uses the same Desktop project identity as the catalog without writing a turn", async t => {
  const f = await fixture(t, { cwd: "/project/worktree" });
  const file = path.join(f.root, ".codex-global-state.json");
  const registry = { "local-projects": { p: { id: "p", rootPaths: ["/project"] } } };
  fs.writeFileSync(file, JSON.stringify(registry));
  const observed = await f.runner.inspectThread("thread");
  assert.equal(observed?.projectId, "p"); assert.equal(observed?.cwd, "/project/worktree");
  fs.writeFileSync(file, JSON.stringify({ ...registry, "projectless-thread-ids": ["thread"] }));
  assert.equal((await f.runner.inspectThread("thread"))?.projectId, undefined);
  assert.equal(f.writes().length, 0);
});

for (const stage of ["connect", "initialize", "discovery", "snapshot"] as const) {
  test(`transient ${stage} observation failure recovers on a fresh connection before exactly one native write`, async t => {
    const f = await fixture(t, { stage });
    let checks = 0;
    assert.equal((await f.runner.submitThreadMessage({ ...input, assertCurrent: () => { checks++; } })).status, "accepted");
    assert.equal(checks, 1);
    assert.equal(f.writes().length, 1);
    assert.equal(f.writes()[0].attempt, stage === "connect" ? 1 : 2);
    assert.deepEqual(f.diagnostics.map(e => e.outcome), ["retrying", "recovered"]);
    assert.equal(f.diagnostics[0].stage, stage);
    assert.equal(f.diagnostics[0].observationId, f.diagnostics[1].observationId);
    assert.equal(f.diagnostics[1].attempt, 2);
    assert.ok(f.diagnostics.every(e => e.messageSubmitted === false));
    assert.ok(!JSON.stringify(f.diagnostics).includes(input.prompt));
  });
}

test("a disconnected handshake recovers without confusing connection failure with owner absence", async t => {
  const f = await fixture(t, { stage: "initialize", failure: "disconnect" });
  assert.equal((await f.runner.readThreadSnapshot("thread"))?.state.title, "fresh-2");
  assert.equal(f.diagnostics[0].code, "disconnected");
  assert.equal(f.connections(), 2); assert.equal(f.writes().length, 0);
});

test("recovery has a larger second-attempt budget, but only one bounded total deadline", async t => {
  const f = await fixture(t, { stage: "initialize", healthyDelayMs: 50 });
  assert.equal((await f.runner.readThreadSnapshot("thread"))?.state.title, "fresh-2");
  assert.equal(f.diagnostics[0].attemptBudgetMs, 100);
  assert.ok(f.diagnostics[1].attemptBudgetMs > 150);
  assert.equal(f.diagnostics[1].totalBudgetMs, 310);
  assert.equal(f.writes().length, 0);
});

test("default preflight outlasts Desktop's 10s negative discovery window, with headroom under the follow deadline", async t => {
  const f = await fixture(t, { stage: "connect", defaultBudget: true, timeoutMs: 60_000 });
  assert.equal((await f.runner.readThreadSnapshot("thread"))?.state.title, "fresh-1");
  assert.equal(f.diagnostics[0].attemptBudgetMs, 12_000);
  assert.equal(f.diagnostics[0].totalBudgetMs, 19_000);
  assert.equal(f.writes().length, 0);
});

test("a delayed negative discovery receipt within the budget is absence, not a transport failure", async t => {
  const f = await fixture(t, { stage: "discovery", failure: "late-no-owner", observationTimeoutMs: 120 });
  assert.equal(await f.runner.readThreadSnapshot("thread"), undefined);
  assert.equal(f.connections(), 1); assert.equal(f.diagnostics.length, 0); assert.equal(f.writes().length, 0);
});

test("recovery ending in explicit owner absence closes the diagnostic chain without treating it as idle", async t => {
  const f = await fixture(t, { stage: "initialize", ownerAbsent: true });
  assert.equal(await f.runner.readThreadSnapshot("thread"), undefined);
  assert.deepEqual(f.diagnostics.map(e => e.outcome), ["retrying", "no-live-owner"]);
  assert.equal(f.diagnostics[1].code, undefined);
  assert.equal(f.connections(), 2); assert.equal(f.writes().length, 0);
});

test("concurrent readers share the entire recovery; subsequent reads do not reuse a stale snapshot", async t => {
  const f = await fixture(t, { stage: "snapshot" });
  const [state, first, second] = await Promise.all([f.runner.inspectThread("thread"), f.runner.readThreadSnapshot("thread"), f.runner.readThreadSnapshot("thread")]);
  assert.equal(state?.title, "fresh-2"); assert.equal(first, second);
  assert.equal(f.connections(), 2);
  assert.equal((await f.runner.readThreadSnapshot("thread"))?.state.title, "fresh-3");
  assert.equal(f.connections(), 3); assert.equal(f.writes().length, 0);
});

test("exhausted observation stays not-submitted, cannot look idle or start/steer/stop a task", async t => {
  const f = await fixture(t, { stage: "discovery", alwaysFail: true, timeoutMs: 260 });
  const started = performance.now();
  await assert.rejects(f.runner.submitThreadMessage(input), e => e instanceof CodexCommunicationError
    && e.code === "timeout" && e.phase === "preflight" && e.submission === "not-submitted");
  assert.equal(f.connections(), 2); assert.equal(f.writes().length, 0);
  assert.deepEqual(f.diagnostics.map(e => e.outcome), ["retrying", "failed"]);
  assert.ok(f.diagnostics.every(e => e.totalBudgetMs === 260));
  assert.ok(performance.now() - started < 800, "bounded chain, not a new full budget for every stage");
});

for (const failure of ["reject", "no-owner", "invalid-initialize"] as const) {
  test(`explicit ${failure} is not transport recovery, and raw errors are not logged`, async t => {
    const f = await fixture(t, { stage: failure === "invalid-initialize" ? "initialize" : "discovery", failure });
    if (failure === "no-owner") assert.equal(await f.runner.readThreadSnapshot("thread"), undefined);
    else await assert.rejects(f.runner.readThreadSnapshot("thread"));
    assert.equal(f.connections(), 1); assert.equal(f.writes().length, 0);
    assert.ok(!f.diagnostics.some(e => e.outcome === "retrying"));
    assert.ok(!JSON.stringify(f.diagnostics).includes("secret-provider-body"));
    if (failure === "reject") assert.equal(f.diagnostics[0].code, "rejected");
  });
}

test("a binding changed during read-only recovery is rechecked before the native write", async t => {
  let bindingCurrent = true;
  const f = await fixture(t, { stage: "snapshot", onDiagnostic(e) { if (e.outcome === "retrying") bindingCurrent = false; } });
  await assert.rejects(f.runner.submitThreadMessage({ ...input, assertCurrent() { if (!bindingCurrent) throw new Error("binding changed"); } }), /binding changed/);
  assert.equal(f.connections(), 2); assert.equal(f.writes().length, 0);
});

for (const when of ["inflight", "backoff"] as const) {
  test(`closing the runner during ${when} cancels observations without reconnecting`, async t => {
    const f = await fixture(t, { stage: "snapshot", onDiagnostic(e, runner) { if (when === "backoff" && e.outcome === "retrying") runner.close(); } });
    const work = f.runner.readThreadSnapshot("thread");
    const rejected = assert.rejects(work, /closed/);
    if (when === "inflight") { await f.fault; f.runner.close(); }
    await rejected;
    await sleep(30);
    assert.equal(f.connections(), 1); assert.equal(f.writes().length, 0);
  });
}

test("shutdown while connecting cancels the pending connect timer and never retries", async t => {
  const fake = new net.Socket();
  let connects = 0;
  t.mock.method(net, "createConnection", () => { connects++; return fake; });
  const runner = new DesktopCodexRunner({ timeoutMs: 10_000, observationTimeoutMs: 1_000, onObservationDiagnostic() {} });
  t.after(() => runner.close());
  const rejected = assert.rejects(runner.readThreadSnapshot("thread"), /closed/);
  runner.close(); await rejected;
  assert.equal(connects, 1); assert.equal(fake.destroyed, true);
});

test("even after successful recovery, a lost native write receipt is unconfirmed and is never replayed", async t => {
  const f = await fixture(t, { stage: "snapshot", writeTimeout: true, timeoutMs: 350 });
  await assert.rejects(f.runner.submitThreadMessage(input), e => e instanceof CodexCommunicationError
    && e.phase === "submission" && e.submission === "unconfirmed");
  assert.equal(f.connections(), 2); assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0].method, "thread-follower-steer-turn");
});

test("idle start-turn uses the same observer, and an invalid native receipt is not retried", async t => {
  const f = await fixture(t, { stage: "snapshot", runtime: "idle" });
  await assert.rejects(f.runner.run(input), e => e instanceof CodexCommunicationError && e.submission === "unconfirmed");
  assert.equal(f.connections(), 2); assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0].method, "thread-follower-start-turn");
});

test("Desktop start rechecks the source after owner observation and never writes a revoked input", async t => {
  let allowed = true;
  const f = await fixture(t, { stage: "snapshot", runtime: "idle", onDiagnostic(event) {
    if (event.outcome === "recovered") allowed = false;
  } });
  await assert.rejects(f.runner.run({ ...input, assertCurrent() { if (!allowed) throw Error("source revoked"); } }), /source revoked/);
  assert.equal(f.writes().length, 0);
});

test("BackendRouter never wraps an exhausted Desktop observation in another retry chain", async t => {
  const f = await fixture(t, { stage: "discovery", alwaysFail: true });
  const router = new CodexBackendRouter({ backend: "app-server", desktopRunner: f.runner,
    appServerBackend: { async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: "notLoaded", activeFlags: [] }; }, close() {} } as never });
  t.after(() => router.close());
  await assert.rejects(router.inspectThread("thread"), e => e instanceof CodexCommunicationError && e.submission === "not-submitted");
  assert.equal(f.connections(), 2); assert.equal(f.writes().length, 0);
  assert.equal(new Set(f.diagnostics.map(e => e.observationId)).size, 1);
});
