import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveLocalAppServerTransport } from "../src/codex/app-server-daemon.js";
import {
  APP_SERVER_BACKEND_CAPABILITIES,
  EXEC_BACKEND_CAPABILITIES
} from "../src/codex/backend.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import type { CodexRunnerInput, CodexThreadState } from "../src/codex/backend.js";

for (const operation of ["inspect", "snapshot"] as const) {
  test(`failed private ${operation} reads recover only through a confirmed Desktop owner`, async t => {
    let desktopReads = 0, writes = 0;
    const state: CodexThreadState = { threadId: "thread", persistence: "active", runtimeStatus: "active",
      activeFlags: [], executionOwner: "desktop", activeTurnId: "native-turn" };
    const failed = async () => { throw new Error("app-server request thread/read timed out after 15000ms"); };
    const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: {
      inspectThread: failed, readThreadSnapshot: failed, async run() { writes++; }, close() {}
    } as never, desktopRunner: {
      async inspectThread() { desktopReads++; return state; },
      async readThreadSnapshot() { desktopReads++; return { state, turns: [] }; },
      async run() { writes++; }, close() {}
    } as never });
    t.after(() => router.close());
    const read = () => operation === "inspect" ? router.inspectThread("thread") : router.readThreadSnapshot("thread").then(s => s.state);
    assert.equal((await read()).activeTurnId, "native-turn"); assert.equal(desktopReads, 1); assert.equal(writes, 0);
    const failure = operation === "inspect" ? { name: "CodexCommunicationError", code: "timeout" } : /timed out/;
    state.threadId = "different-host-thread"; await assert.rejects(read(), failure);
    state.threadId = "thread"; state.runtimeStatus = "notLoaded"; await assert.rejects(read(), failure);
    assert.equal(writes, 0);
  });
}

test("message inspection reads metadata first and hydrates turns only for an active guard", async t => {
  const reads: Array<unknown> = [];
  let active = false;
  const app = { capabilities: APP_SERVER_BACKEND_CAPABILITIES,
    async inspectThread(_id: string, observation?: { includeTurns: false; timeoutMs: number }) {
      reads.push(observation);
      return { threadId: "thread", persistence: "active", runtimeStatus: active ? "active" : "idle", activeFlags: [],
        ...(active && !observation ? { activeTurnId: "turn" } : {}) };
    }, close() {}
  } as never;
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: app,
    desktopRunner: { async inspectThread() { return undefined; }, close() {} } as never });
  t.after(() => router.close());
  assert.equal((await router.inspectThread("thread")).runtimeStatus, "idle");
  assert.deepEqual(reads, [{ includeTurns: false, timeoutMs: 5000 }]);
  active = true;
  assert.equal((await router.inspectThread("thread")).activeTurnId, "turn");
  assert.deepEqual(reads.slice(1), [{ includeTurns: false, timeoutMs: 5000 }, undefined]);
});

test("inspection and following share in-flight metadata, select the real owner before expensive private history, and never cache old state", async t => {
  let metadata = 0, fullReads = 0, snapshots = 0;
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: {
    async inspectThread() { metadata++; await gate; return { threadId: "thread", persistence: "active", runtimeStatus: "notLoaded", activeFlags: [] }; },
    async readThreadSnapshot() { fullReads++; throw new Error("must not hydrate foreign history"); }, close() {}
  } as never, desktopRunner: {
    async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: "idle", executionOwner: "desktop", activeFlags: [] }; },
    async readThreadSnapshot() { snapshots++; return { state: { threadId: "thread", persistence: "active", runtimeStatus: "active",
      executionOwner: "desktop", activeFlags: [], activeTurnId: "native-turn" }, turns: [] }; }, close() {}
  } as never });
  t.after(() => router.close());
  const inspecting = router.inspectThread("thread");
  const following = router.readThreadSnapshot("thread");
  const secondFollower = router.readThreadSnapshot("thread", "local");
  await new Promise(resolve => setImmediate(resolve)); assert.equal(metadata, 1);
  release(); await Promise.all([inspecting, following, secondFollower]);
  assert.equal(fullReads, 0); assert.equal(snapshots, 1);
  gate = Promise.resolve(); await router.readThreadSnapshot("thread");
  assert.equal(metadata, 2); assert.equal(snapshots, 2);
});

test("declares the protocol capabilities of the two Codex backends explicitly", () => {
  assert.equal(EXEC_BACKEND_CAPABILITIES.streaming, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.history, true);
  assert.equal(EXEC_BACKEND_CAPABILITIES.historyPaging, true);
  assert.equal(EXEC_BACKEND_CAPABILITIES.turnSteering, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.liveFollow, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.structuredOutput, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.projectCatalog, true);
  assert.equal(EXEC_BACKEND_CAPABILITIES.projects, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.threadNaming, false);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.streaming, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.history, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.historyPaging, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.turnSteering, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.liveFollow, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.approvals, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.collaborationModes, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.projectCatalog, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.projects, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.threadNaming, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.developerInstructions, true);
});

test("auto app-server transport uses stdio when the managed daemon is unavailable", () => {
  const transport = resolveLocalAppServerTransport({
    mode: "auto",
    codexHome: path.join(path.sep, "missing-codex-home"),
    existsSync: () => false
  });

  assert.equal(transport, undefined);
});

test("stdio app-server transport always starts a private app-server", () => {
  const transport = resolveLocalAppServerTransport({
    mode: "stdio",
    existsSync: () => true
  });

  assert.equal(transport, undefined);
});

test("daemon app-server transport exposes a proxy and fails preflight clearly", async () => {
  const codexHome = path.join(path.sep, "missing-codex-home");
  const transport = resolveLocalAppServerTransport({
    mode: "daemon",
    codexHome,
    existsSync: () => false
  });

  assert.equal(transport?.mode, "daemon-proxy");
  assert.deepEqual(transport?.args, ["app-server", "proxy"]);
  await assert.rejects(
    transport?.prepare?.(),
    /managed standalone Codex install.*codexAppServerTransport to stdio/i
  );
});

test("daemon app-server transport targets the managed standalone executable", () => {
  const codexHome = path.join(path.sep, "test-codex-home");
  const transport = resolveLocalAppServerTransport({
    mode: "daemon",
    codexHome,
    platform: "darwin",
    existsSync: () => true
  });

  assert.equal(
    transport?.command,
    path.join(codexHome, "packages", "standalone", "current", "codex")
  );
  assert.equal(transport?.label, "managed-daemon");
});

test("routes project listing through the selected concrete backend", async (t) => {
  const calls: string[] = [];
  const appServerBackend = {
    id: "app-server",
    capabilities: APP_SERVER_BACKEND_CAPABILITIES,
    async listProjects() {
      calls.push("app-server");
      return { backend: "app-server", projects: [{ id: "app", name: "App", roots: ["/app"] }] };
    },
    async warmUp() {},
    async stop() { return "not-active"; },
    close() {}
  } as any;
  const execBackend = {
    id: "exec",
    capabilities: EXEC_BACKEND_CAPABILITIES,
    async listProjects() {
      calls.push("exec");
      return { backend: "exec", projects: [{ id: "cli", name: "CLI", roots: ["/cli"] }] };
    },
    async warmUp() {},
    async stop() { return "not-active"; },
    close() {}
  } as any;
  const desktopRunner = {
    async run() { throw new Error("unused"); },
    async stop() { return "not-active" as const; },
    close() {}
  };

  const execRouter = new CodexBackendRouter({
    backend: "exec",
    appServerBackend,
    execBackend,
    desktopRunner
  });
  t.after(() => execRouter.close());
  assert.equal((await execRouter.listProjects()).backend, "exec");

  const appRouter = new CodexBackendRouter({
    backend: "app-server",
    appServerBackend,
    execBackend,
    desktopRunner
  });
  t.after(() => appRouter.close());
  assert.equal((await appRouter.listProjects()).backend, "app-server");
  assert.deepEqual(calls, ["exec", "app-server"]);
});

test("marks an auto project-list fallback as the CLI catalog", async (t) => {
  const appServerBackend = {
    id: "app-server",
    capabilities: APP_SERVER_BACKEND_CAPABILITIES,
    async listProjects() { throw new Error("daemon unavailable"); },
    async warmUp() {},
    async stop() { return "not-active"; },
    close() {}
  } as any;
  const execBackend = {
    id: "exec",
    capabilities: EXEC_BACKEND_CAPABILITIES,
    async listProjects() {
      return { backend: "exec", projects: [{ id: "cli", name: "CLI", roots: ["/cli"] }] };
    },
    async warmUp() {},
    async stop() { return "not-active"; },
    close() {}
  } as any;
  const runner = new CodexBackendRouter({
    backend: "auto",
    appServerBackend,
    execBackend,
    desktopRunner: {
      async run() { throw new Error("unused"); },
      async stop() { return "not-active" as const; },
      close() {}
    }
  });
  t.after(() => runner.close());

  const catalog = await runner.listProjects();
  assert.equal(catalog.backend, "exec");
  assert.deepEqual(catalog.projects.map((project) => project.id), ["cli"]);
});

test("Desktop observations and writes use the real owner while CLI remains isolated", async t => {
  const calls: string[] = [];
  const desktopState: CodexThreadState = { threadId: "thread", persistence: "active", runtimeStatus: "active",
    activeTurnId: "desktop-turn", activeFlags: [], executionOwner: "desktop" };
  const storedState: CodexThreadState = { threadId: "thread", persistence: "active", runtimeStatus: "notLoaded", activeFlags: [] };
  const app = {
    capabilities: APP_SERVER_BACKEND_CAPABILITIES,
    async inspectThread() { calls.push("app-inspect"); return storedState; },
    async readThreadSnapshot() { calls.push("app-read"); return { state: storedState, turns: [] }; },
    async run() { calls.push("app-run"); throw new Error("wrong writer"); },
    async stop() { calls.push("app-stop"); return "not-active"; },
    close() {}
  } as never;
  const desktop = {
    async inspectThread() { calls.push("desktop-inspect"); return desktopState; },
    async readThreadSnapshot() { calls.push("desktop-read"); return { state: desktopState, turns: [] }; },
    async run(input: CodexRunnerInput) { calls.push("desktop-run"); assert.equal(input.prompt, "你是 GPT？"); return { text: "ok", raw: "" }; },
    async steer() { calls.push("desktop-steer"); throw new Error("safe steering unsupported"); },
    async stop(_thread?: string, expectedTurnId?: string) { calls.push("desktop-stop:" + expectedTurnId); return "interrupted" as const; },
    close() {}
  };
  const cli = { capabilities: EXEC_BACKEND_CAPABILITIES,
    async inspectThread() { calls.push("cli-inspect"); return storedState; },
    async readThreadSnapshot() { calls.push("cli-read"); return { state: storedState, turns: [] }; },
    async run() { calls.push("cli-run"); return { text: "cli", raw: "" }; },
    async stop() { calls.push("cli-stop"); return "not-active"; }, close() {}
  } as never;
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: app, execBackend: cli, desktopRunner: desktop });
  t.after(() => router.close());
  assert.equal((await router.inspectThread("thread")).activeTurnId, "desktop-turn");
  assert.equal((await router.readThreadSnapshot("thread")).state.executionOwner, "desktop");
  await router.run({ threadId: "thread", cwd: "/tmp", prompt: "你是 GPT？" });
  await assert.rejects(router.steer({ threadId: "thread", prompt: "extra", expectedTurnId: "desktop-turn" }), /safe steering unsupported/);
  assert.equal(await router.stop("thread"), "interrupted");
  desktopState.runtimeStatus = "idle";
  desktopState.activeTurnId = undefined;
  desktopState.pendingTurnWithoutId = true;
  assert.equal(await router.stop("thread"), "not-active", "an orphan spinner is not an interrupt target");
  assert.ok(calls.includes("desktop-stop:desktop-turn"));
  assert.ok(!calls.includes("app-run") && !calls.includes("app-stop"));
  storedState.persistence = "archived";
  assert.equal((await router.inspectThread("thread")).persistence, "archived", "Desktop runtime must not hide archival");
  assert.equal((await router.readThreadSnapshot("thread")).state.persistence, "archived");
  calls.length = 0;
  const cliRouter = new CodexBackendRouter({ backend: "exec", appServerBackend: app, execBackend: cli, desktopRunner: desktop });
  t.after(() => cliRouter.close());
  await cliRouter.inspectThread("thread");
  await cliRouter.readThreadSnapshot("thread");
  await cliRouter.run({ threadId: "thread", cwd: "/tmp", prompt: "ordinary" });
  await cliRouter.stop("thread");
  assert.deepEqual(calls, ["cli-inspect", "cli-read", "cli-run", "cli-stop"]);
});

test("a task active on the selected app-server is not overridden by unrelated Desktop state", async t => {
  let desktopReads = 0;
  const state: CodexThreadState = { threadId: "thread", persistence: "active", runtimeStatus: "active", activeTurnId: "owned", activeFlags: [] };
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: {
    async inspectThread() { return state; }, async readThreadSnapshot() { return { state, turns: [] }; }, close() {}
  } as never, execBackend: { close() {} } as never, desktopRunner: {
    async inspectThread() { desktopReads++; return undefined; },
    async readThreadSnapshot() { desktopReads++; return undefined; },
    async run() { throw new Error("unused"); }, async steer() { throw new Error("unused"); },
    async stop() { return "not-active" as const; }, close() {}
  } });
  t.after(() => router.close());
  assert.equal((await router.inspectThread("thread")).activeTurnId, "owned");
  assert.equal((await router.readThreadSnapshot("thread")).state.activeTurnId, "owned");
  assert.equal(desktopReads, 0);
});
