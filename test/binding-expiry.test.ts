import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeStateStore, SessionBindingConflictError } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { DAY_MS } from "../src/state/binding-expiry.js";
import { BindingExpiryCoordinator, type ExpiringBinding } from "../src/server/binding-expiry.js";

function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "binding-expiry-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(paths);
  const session = store.createSession("room", root, "original", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(session.id, "thread"); store.prepareBindingExpiry(15);
  const expected = () => ({ ...store.sessionBindingTarget(store.getSession(session.id)!), generation: store.getBindingExpiry("room", 15)!.generation });
  return { root, paths, store, session, expected };
}

test("binding idle clock counts authorized human messages, not sync/metadata or bot output", t => {
  const f = fixture(t), initial = f.store.getBindingExpiry("room", 15)!;
  t.mock.timers.tick(14 * DAY_MS);
  f.store.renameSession(f.session.id, "new title"); f.store.setSessionFollow(f.session.id, true);
  f.store.rememberContextToken("room", "fake"); f.store.setSessionPromptPreview(f.session.id, "bot metadata");
  f.store.setSessionThread(f.session.id, "thread");
  assert.equal(f.store.getBindingExpiry("room", 15)!.expiresAt, initial.expiresAt);
  f.store.recordBindingHumanActivity("other-room"); assert.equal(f.store.getBindingExpiry("other-room", 15), undefined);
  f.store.recordBindingHumanActivity("room");
  const renewed = f.store.getBindingExpiry("room", 15)!;
  assert.equal(Date.parse(renewed.expiresAt!), Date.now() + 15 * DAY_MS);
  assert.notEqual(renewed.generation, initial.generation);
  const restarted = new RuntimeStateStore(f.paths);
  assert.deepEqual(restarted.getBindingExpiry("room", 15), renewed);
});

test("idle expiry detaches only this conversation, persists, preserves native history and never implicitly rebinds", t => {
  const f = fixture(t), other = f.store.createSession("other", f.root, "other", undefined, "session", undefined, { standalone: true });
  f.store.setSessionThread(other.id, "thread");
  const expected = f.expected(); t.mock.timers.tick(15 * DAY_MS - 1);
  assert.equal(f.store.expireBinding(f.session.id, expected, 15), false);
  t.mock.timers.tick(1); assert.equal(f.store.expireBinding(f.session.id, expected, 15), true);
  assert.equal(f.store.getBoundSession("room"), undefined);
  assert.equal(f.store.getBoundSession("other")?.id, other.id);
  assert.equal(f.store.getSession(f.session.id)?.threadId, "thread");
  assert.equal(f.store.getBindingExpiry("room", 15)?.endedReason, "idle");
  assert.equal(new RuntimeStateStore(f.paths).getBoundSession("room"), undefined);
  assert.equal(f.store.expireBinding(f.session.id, expected, 15), false);
});

test("fresh human input, policy changes and same-target rebind defeat stale cleanup (including ABA)", t => {
  const f = fixture(t), stale = f.expected(); t.mock.timers.tick(16 * DAY_MS);
  f.store.recordBindingHumanActivity("room");
  assert.equal(f.store.expireBinding(f.session.id, stale, 15), false);
  assert.throws(() => f.store.setBindingIdleDays(f.session.id, stale, 1, 15), SessionBindingConflictError);
  const before = f.expected();
  f.store.leaveSession("room"); f.store.activateSession(f.session.id);
  assert.equal(f.store.expireBinding(f.session.id, before, 15), false);
  assert.notEqual(f.expected().generation, before.generation);
});

test("global policy, per-conversation disable/override, inherit and re-enable each receive a full grace period", t => {
  const f = fixture(t); t.mock.timers.tick(30 * DAY_MS);
  f.store.prepareBindingExpiry(0); assert.equal(f.store.getBindingExpiry("room", 0)?.status, "disabled");
  f.store.prepareBindingExpiry(7);
  assert.equal(Date.parse(f.store.getBindingExpiry("room", 7)!.expiresAt!), Date.now() + 7 * DAY_MS);
  f.store.setBindingIdleDays(f.session.id, f.expected(), 0, 7);
  assert.equal(f.store.getBindingExpiry("room", 30)?.status, "disabled");
  f.store.setBindingIdleDays(f.session.id, f.expected(), 30, 7);
  f.store.prepareBindingExpiry(1);
  assert.equal(f.store.getBindingExpiry("room", 1)?.effectiveDays, 30);
  f.store.setBindingIdleDays(f.session.id, f.expected(), null, 1);
  assert.equal(f.store.getBindingExpiry("room", 1)?.inherited, true);
  assert.equal(Date.parse(f.store.getBindingExpiry("room", 1)!.expiresAt!), Date.now() + DAY_MS);
  for (const invalid of [-1, 1.5, 3651, NaN]) assert.throws(() => f.store.setBindingIdleDays(f.session.id, f.expected(), invalid, 15));
});

test("upgrade starts a grace period for legacy active bindings; restart does not refresh it", t => {
  const f = fixture(t), state = f.store.snapshot;
  delete (state as Partial<typeof state>).bindingActivity;
  state.sessions[0].createdAt = "2000-01-01T00:00:00Z";
  state.sessions[0].updatedAt = "2000-01-01T00:00:00Z";
  fs.writeFileSync(f.paths.statePath, JSON.stringify(state));
  const upgraded = new RuntimeStateStore(f.paths); upgraded.prepareBindingExpiry(15);
  const expiry = upgraded.getBindingExpiry("room", 15)!;
  assert.equal(Date.parse(expiry.expiresAt!), Date.now() + 15 * DAY_MS);
  t.mock.timers.tick(DAY_MS);
  const restarted = new RuntimeStateStore(f.paths); restarted.prepareBindingExpiry(15);
  assert.equal(restarted.getBindingExpiry("room", 15)?.expiresAt, expiry.expiresAt);
});

const candidate: ExpiringBinding = { accountId: "one", sessionId: "managed", expected: {
  conversationId: "room", hostId: "local", threadId: "thread", generation: "lease" }, related: [] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("expiry scheduler coalesces checks and revalidates provenance after asynchronous reads", async () => {
  const probe = Promise.withResolvers<boolean>(); let reads = 0, expired = 0, current = true;
  const coordinator = new BindingExpiryCoordinator({ candidates: () => [candidate], current: () => current,
    idle: async () => { reads++; return probe.promise; }, expire: async () => { expired++; } });
  const first = coordinator.runOnce(); assert.equal(coordinator.runOnce(), first);
  current = false; probe.resolve(true); await first;
  assert.equal(reads, 1); assert.equal(expired, 0); coordinator.stop();
});

test("timeouts, read failures and late successful probes do not unbind or trigger native retries", async () => {
  const late = Promise.withResolvers<boolean>(); let expired = 0;
  const coordinator = new BindingExpiryCoordinator({ candidates: () => [candidate], current: () => true,
    idle: () => late.promise, expire: async () => { expired++; }, probeTimeoutMs: 5 });
  const checking = coordinator.runOnce(); await new Promise(resolve => setTimeout(resolve, 15)); await checking;
  late.resolve(true); await tick(); assert.equal(expired, 0); coordinator.stop();
  const failed = new BindingExpiryCoordinator({ candidates: () => [candidate], current: () => true,
    idle: async () => { throw new Error("unreachable"); }, expire: async () => { expired++; } });
  await failed.runOnce(); assert.equal(expired, 0); failed.stop();
});

test("stop/restart invalidates in-flight checks, while a fresh confirmed-idle check expires once", async () => {
  const probe = Promise.withResolvers<boolean>(); let expired = 0, probes = 0;
  const coordinator = new BindingExpiryCoordinator({ candidates: () => [candidate], current: () => expired === 0,
    idle: async () => ++probes === 1 ? probe.promise : true, expire: async () => { expired++; } });
  const checking = coordinator.runOnce(); coordinator.stop(); coordinator.start(); probe.resolve(true); await checking;
  assert.equal(expired, 0); await coordinator.runOnce(); await coordinator.runOnce();
  assert.equal(expired, 1); coordinator.stop();
});
