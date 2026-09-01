import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveLocalAppServerTransport } from "../src/codex/app-server-daemon.js";
import {
  APP_SERVER_BACKEND_CAPABILITIES,
  EXEC_BACKEND_CAPABILITIES
} from "../src/codex/backend.js";
import { CodexBackendRouter } from "../src/codex/runner.js";

test("declares the protocol capabilities of the two Codex backends explicitly", () => {
  assert.equal(EXEC_BACKEND_CAPABILITIES.streaming, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.history, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.structuredOutput, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.projectCatalog, true);
  assert.equal(EXEC_BACKEND_CAPABILITIES.projects, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.threadNaming, false);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.streaming, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.history, true);
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
