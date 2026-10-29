import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { resolveLocalAppServerTransport } from "../src/codex/app-server-daemon.js";
import { RestartWork } from "../src/bridge/restart-work.js";
import { AccountManager } from "../src/server/account-manager.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { DesktopCodexRunner } from "../src/codex/desktop-runner.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";

function execution(t: test.TestContext, owner: "gateway" | "daemon" | "desktop", persist?: Promise<void>) {
  const done = Promise.withResolvers<void>(), acknowledged = Promise.withResolvers<void>(), submitted = Promise.withResolvers<void>();
  let active = false, writes = 0;
  const run = async (input: any) => {
    active = true; writes++; submitted.resolve();
    await input.onTurnStarted?.({ threadId: "native", turnId: "turn" });
    acknowledged.resolve(); await done.promise; active = false;
    return { threadId: "native", turnId: "turn", text: "done", raw: "" };
  };
  const backend = { id: "app-server", executionLifetime: owner === "daemon" ? "independent" : "gateway",
    capabilities: APP_SERVER_BACKEND_CAPABILITIES, async warmUp() {}, run,
    hasInFlightWork: () => active, hasRestartBlockingWork: () => owner === "gateway" && active, close() {} };
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: backend as never,
    desktopRunner: { run, close() {}, async refreshTaskList() {} } as never });
  if (owner === "desktop") (router as any).desktopOwnedThreads.add("native");
  const source = new RestartWork();
  const pending = source.run(async () => {
    const accepted = source.capture();
    return router.run({ prompt: "synthetic", cwd: "/tmp", threadId: "native", onTurnStarted: async event => {
      await persist; accepted({ hostId: "local", ...event });
    } });
  });
  void pending.catch(() => {});
  t.after(async () => { done.resolve(); await pending.catch(() => {}); await router.close(); });
  return { router, source, done, pending, acknowledged, submitted, get writes() { return writes; } };
}

for (const owner of ["daemon", "desktop"] as const) test(`${owner}: a durable accepted turn can keep executing while Gateway restarts`, async t => {
  const f = execution(t, owner); await f.acknowledged.promise;
  const scope = { hostId: "local", threadId: "native", turnId: "turn" };
  assert.equal(f.router.hasInFlightWork(), true);
  assert.equal(f.router.hasRestartBlockingWork(), false);
  assert.equal(f.router.isIndependentObservation(scope), true);
  assert.equal(f.source.hasBlockingWork(s => f.router.isIndependentObservation(s)), false);
  for (const other of [{ ...scope, hostId: "other" }, { ...scope, turnId: "older" }, { ...scope, threadId: "foreign" }])
    assert.equal(f.router.isIndependentObservation(other), false);
  f.done.resolve(); await f.pending;
  assert.equal(f.router.isIndependentObservation(scope), false); assert.equal(f.writes, 1);
});

test("an independent native acceptance still blocks restart until its source receipt is persisted", async t => {
  const persist = Promise.withResolvers<void>(); t.after(() => persist.resolve());
  const f = execution(t, "desktop", persist.promise); await f.submitted.promise;
  assert.equal(f.router.hasRestartBlockingWork(), true);
  assert.equal(f.source.hasBlockingWork(s => f.router.isIndependentObservation(s)), true);
  persist.resolve(); await f.acknowledged.promise;
  assert.equal(f.router.hasRestartBlockingWork(), false);
});

test("a legacy private executor remains protected after the native start receipt", async t => {
  const f = execution(t, "gateway"); await f.acknowledged.promise;
  assert.equal(f.router.hasRestartBlockingWork(), true);
  assert.equal(f.source.hasBlockingWork(s => f.router.isIndependentObservation(s)), true);
});

test("another incoming message or result delivery cannot borrow an accepted observer's exemption", async t => {
  const f = execution(t, "desktop"); await f.acknowledged.promise;
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const second = f.source.run(async () => { entered.resolve(); await release.promise; });
  t.after(() => release.resolve()); await entered.promise;
  assert.equal(f.source.hasBlockingWork(s => f.router.isIndependentObservation(s)), true);
  release.resolve(); await second;
  assert.equal(f.source.hasBlockingWork(s => f.router.isIndependentObservation(s)), false);
  const settling = Promise.withResolvers<void>();
  const delivery = f.source.run(async () => {
    f.source.accepted({ hostId: "local", threadId: "native", turnId: "turn" });
    await f.pending; await settling.promise;
  });
  t.after(() => settling.resolve()); f.done.resolve(); await f.pending;
  assert.equal(f.source.hasBlockingWork(s => f.router.isIndependentObservation(s)), true);
  settling.resolve(); await delivery;
});

test("callbacks captured for an old invocation cannot release a new business operation", async () => {
  const source = new RestartWork(); let old!: ReturnType<RestartWork["capture"]>;
  await source.run(async () => { old = source.capture(); });
  const release = Promise.withResolvers<void>();
  const pending = source.run(async () => { old({ hostId: "local", threadId: "thread", turnId: "turn" }); await release.promise; });
  assert.equal(source.hasBlockingWork(() => true), true); release.resolve(); await pending;
});

for (const mode of ["daemon-proxy", "remote-daemon"] as const) test(`${mode}: read polling and accepted turns do not block; handoff and synchronous requests do`, async () => {
  const runner = new AppServerCodexRunner({ transport: { command: "synthetic", args: [], mode } }), inner = runner as any;
  inner.operationLeases = 1; inner.activeTurns.set("thread", "turn");
  assert.equal(runner.hasRestartBlockingWork(), false);
  inner.pending.set(1, { method: "thread/read" }); assert.equal(runner.hasRestartBlockingWork(), false);
  inner.pending.set(2, { method: "turn/start" }); assert.equal(runner.hasRestartBlockingWork(), true); inner.pending.delete(2);
  inner.unconfirmedStarts.add("thread"); assert.equal(runner.hasRestartBlockingWork(), true); inner.unconfirmedStarts.clear();
  inner.userInputRequests.set("request", {}); assert.equal(runner.hasRestartBlockingWork(), true); inner.userInputRequests.clear();
  inner.approvalRequests.set("request", {}); assert.equal(runner.hasRestartBlockingWork(), true); inner.approvalRequests.clear();
  inner.pending.clear(); inner.activeTurns.clear(); inner.operationLeases = 0; await runner.close();
});

test("native configured Codex uses its daemon proxy even without a standalone package", () => {
  const transport = resolveLocalAppServerTransport({ mode: "auto", codexHome: "/missing", codexBin: "/configured/codex", existsSync: () => false });
  assert.equal(transport?.mode, "daemon-proxy"); assert.equal(transport?.command, process.execPath);
  assert.equal(transport?.args.at(-1), "/missing/app-server-control/app-server-control.sock");
});

test("release gate ignores display responding counters only when the backend and business work prove safe observation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-owned-release-"));
  const manager = new AccountManager({ paths: resolveStatePaths(root), configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: false }) });
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const inner = manager as any; let critical = false;
  inner.runner = { hasRestartBlockingWork: () => critical, isIndependentObservation: () => true, close() {} };
  inner.respondingSessions.set("native-display", 1);
  inner.entries.set("account", { service: { hasInFlightWork: () => true, hasRestartBlockingWork: () => false } });
  const id = crypto.randomUUID(); manager.prepareRelease(id); assert.equal(manager.cancelRelease(id), true);
  critical = true; assert.throws(() => manager.prepareRelease(crypto.randomUUID()));
  inner.entries.clear();
});

test("the real Web submission becomes restartable only after native acceptance; release detaches observation without cancellation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-web-owner-")), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "one", userId: "actor", token: "synthetic", baseUrl: "https://example.invalid", enabled: false });
  const entered = Promise.withResolvers<void>(), accept = Promise.withResolvers<void>(), accepted = Promise.withResolvers<void>();
  const result = Promise.withResolvers<never>(); let observing = false, stops = 0, writes = 0;
  const runner = { async warmUp() {}, async listProjects() { return { backend: "app-server", projects: [] }; },
    async inspectThread(threadId: string) { return { threadId, persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
    hasRestartBlockingWork: () => !observing, isIndependentObservation: () => observing,
    detachIndependentObservations() { result.reject(new CodexCommunicationError("observation", "turn/observe", "thread", "turn")); },
    async run(input: any) { writes++; entered.resolve(); await accept.promise;
      await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" }); observing = true; accepted.resolve(); return result.promise; },
    async stop() { stops++; }, close() {} };
  const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: false, streamReplies: false }),
    runnerFactory: () => runner as never,
    adapterFactory: () => ({ client: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "sent" }; } }),
      async monitor({ signal, onStatus }: any) { onStatus?.({ state: "connected" }); await new Promise<void>(r => signal.addEventListener("abort", r, { once: true })); } }),
    bridgeFactory: () => ({ hasInFlightWork: () => false, hasRestartBlockingWork: () => false, suspendUserInputs() {} } as never),
    codexSessionMonitorFactory: () => ({ start() {}, async stop() {} } as never),
    codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} } as never) });
  let pending: Promise<unknown> | undefined;
  t.after(async () => { accept.resolve(); result.reject(Error("cleanup")); await pending?.catch(() => {}); await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = manager.createSession("one", "chat", root, "Synthetic Web task");
  (manager as any).storeFor("one").setSessionThread(session.id, "thread"); await manager.startAccount("one", false);
  pending = manager.continueSession("one", session.id, "synthetic", [], undefined, "web-restart-source"); void pending.catch(() => {});
  await entered.promise; assert.throws(() => manager.prepareRelease(crypto.randomUUID()));
  accept.resolve(); await accepted.promise;
  const id = crypto.randomUUID(); manager.prepareRelease(id); await assert.rejects(pending, CodexCommunicationError);
  const receipt = Object.values((manager as any).receiptsFor("one").snapshot())[0] as any;
  assert.equal(receipt.phase, "accepted"); assert.equal(receipt.turnId, "turn"); assert.equal(writes, 1); assert.equal(stops, 0);
  manager.cancelRelease(id);
});

test("Desktop observation detachment rejects only Gateway waiters, and the client remains reconnectable", () => {
  const runner = new DesktopCodexRunner({}), inner = runner as any; const failures: any[] = [];
  inner.waiters.set("thread\nturn", { reject: (error: any) => failures.push(error) });
  runner.detachIndependentObservations();
  assert.equal(inner.closed, false); assert.equal(inner.waiters.size, 0);
  assert.equal(failures.length, 1); assert.ok(failures[0] instanceof CodexCommunicationError);
  assert.equal(failures[0].threadId, "thread"); assert.equal(failures[0].turnId, "turn"); runner.close();
});
