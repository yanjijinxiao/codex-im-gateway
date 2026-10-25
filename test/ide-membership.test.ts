import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceIDEManager, type IDEWorkspace } from "../src/ide/manager.js";
import { withIDEEntry } from "../src/ide/completion.js";
import { AccountManager } from "../src/server/account-manager.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths, accountStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import type { CodexThreadState } from "../src/codex/backend.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";

test("a project/worktree entry survives alias removal and restart without retargeting or widening authorization", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-entry-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targets: Record<string, IDEWorkspace> = Object.fromEntries(["private", "group"].map(sessionId => [sessionId,
    { owner: "owner", sessionId, nativeThreadId: sessionId, hostId: "local", projectId: "p", projectName: "project", workspace: "/project" }]));
  targets.worktree = { ...targets.private, sessionId: "worktree", workspace: "/worktree" };
  let manager = new WorkspaceIDEManager({ root, resolve: (_account, session) => targets[session] });
  manager.configStore.save({ ...manager.config(), enabled: true, publicOrigin: "http://127.0.0.1:8790",
    hosts: [{ hostId: "local", enabled: true, binary: "code-server" }] });
  const a = manager.entry("account", "private")!, b = manager.entry("account", "group")!;
  assert.equal(a.url, b.url);
  assert.notEqual(a.id, manager.entry("account", "worktree")!.id);
  assert.notEqual(a.id, manager.entry("another-account", "private")!.id);
  const scope = manager.authorizationScope(a.id);
  delete targets.private;
  assert.equal(manager.authorizationScope(a.id), scope, "authorization scope must not contain the representative IM/native thread");
  manager = new WorkspaceIDEManager({ root, resolve: (_account, session) => targets[session] });
  assert.equal(manager.entry("account", "group")!.id, a.id);
  targets.group = { ...targets.group, rootPaths: ["/project", "/sibling"] };
  assert.equal(manager.entry("account", "group")!.id, a.id);
  assert.notEqual(manager.authorizationScope(a.id), scope, "expanded roots require new authorization, not a new link");
  targets.group = { ...targets.group, projectId: "other-project" };
  assert.throws(() => manager.resolve(a.id), /失效/, "an old project link must not follow a session into another project");
});

test("legacy session entries remain compatible while new replies use the canonical project entry", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-entry-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldId = crypto.createHash("sha256").update(JSON.stringify(["account", "session"])).digest("hex").slice(0, 32);
  fs.mkdirSync(path.join(root, "ide"));
  fs.writeFileSync(path.join(root, "ide/workspaces.json"), JSON.stringify({ [oldId]: { accountId: "account", sessionId: "session" } }));
  let target: IDEWorkspace = { owner: "owner", sessionId: "session", hostId: "local", projectId: "project", projectName: "project", workspace: "/project" };
  const manager = new WorkspaceIDEManager({ root, resolve: () => target });
  manager.configStore.save({ ...manager.config(), enabled: true, hosts: [{ hostId: "local", enabled: true, binary: "code-server" }] });
  assert.equal(manager.resolve(oldId).workspace, "/project");
  assert.notEqual(manager.entry("account", "session")!.id, oldId);
  target = { ...target, projectId: "moved" };
  assert.throws(() => manager.resolve(oldId), /失效/, "a validated legacy URL must not follow future project moves");
});

test("fresh native membership reconciles every IM edge, preserves unknown, and never revives cwd-based project membership", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-member-sync-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveAccount(paths, { accountId: "account", token: "fixture", baseUrl: "http://localhost" });
  const store = new RuntimeStateStore(accountStatePaths(paths, "account"));
  const p = store.createProject("project", "/project", { sourceProjectId: "native-project", hostId: "remote:test", projectKind: "remote" });
  const p2 = store.createProject("other project", "/other", { sourceProjectId: "native-other", hostId: "remote:test", projectKind: "remote" });
  const ids = ["private", "group"].map(chat => { const s = store.createSession(chat, "/project", chat, p.id); store.setSessionThread(s.id, "thread"); return s.id; });
  const foreign = store.createSession("foreign", "/project", "foreign", undefined, "session", undefined, { standalone: true, hostId: "remote:other" });
  store.setSessionThread(foreign.id, "thread");
  let native: CodexThreadState = { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [],
    cwd: "/project", projectId: "native-project", projectMembership: "assigned" };
  let inspections = 0;
  const manager = new AccountManager({ paths, runnerFactory: () => ({ async warmUp() {}, async inspectThread() { inspections++; return native; } }) as never });
  manager.ide.configStore.save({ ...manager.ide.config(), enabled: true,
    hosts: [{ hostId: "local", enabled: true, binary: "code-server" }, { hostId: "remote:test", enabled: true, binary: "code-server" }] });
  const entries = await Promise.all(ids.map(id => manager.ide.freshEntry("account", id)));
  const entry = entries[0]!;
  assert.equal(entry.id, entries[1]!.id); assert.equal(inspections, 1, "concurrent IM/HTTP projections share one native read, not stale persisted observations");
  native = { ...native, projectId: undefined, projectMembership: "unknown" };
  assert.equal(await manager.ide.freshEntry("account", ids[0]), undefined);
  assert.ok(manager.listSessions().filter(s => ids.includes(s.id)).every(s => s.projectId === p.id && s.binding.bound));
  native = { ...native, projectMembership: "none" };
  assert.equal(await manager.ide.freshEntry("account", ids[1]), undefined);
  const current = new RuntimeStateStore(accountStatePaths(paths, "account"));
  for (const id of ids) {
    assert.equal(current.getSession(id)!.projectId, undefined);
    assert.equal(current.getSession(id)!.projectBinding, "none");
    assert.equal(current.getBoundSession(current.getSession(id)!.senderId)!.id, id);
  }
  assert.equal(current.getSession(foreign.id)!.projectBinding, "none");
  assert.throws(() => manager.ide.resolve(entry.id), /失效/);
  native = { ...native, cwd: "/other", projectId: "native-other", projectMembership: "assigned" };
  const moved = (await manager.ide.freshEntry("account", ids[0]))!;
  assert.notEqual(moved.id, entry.id);
  assert.ok(manager.listSessions().filter(s => ids.includes(s.id)).every(s => s.projectId === p2.id && s.binding.bound && s.workspace === "/other"));
  assert.throws(() => manager.ide.resolve(entry.id), /失效/);
});

test("async IDE enrichment cannot deliver an old result after its IM binding is detached", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-final-membership-race-"));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  const delivered: string[] = [];
  let bound = true;
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", managed: true,
    client: { async sendText(input) { delivered.push(input.text); return { messageId: "result" }; } } };
  const hub = new ThreadEventHub({ filePath: path.join(root, "hub.json"), subscriptions: () => bound ? [sub] : [], backend: () => ({} as never),
    async decorateFinal() { entered.resolve(); return release.promise; } });
  t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.managedTurnStarted(sub, "turn");
  const completing = hub.managedCompletion(sub, "turn", "old result");
  await entered.promise; bound = false; release.resolve("old result plus an IDE link"); await completing;
  assert.deepEqual(delivered, []);
});

test("Gateway owns one semantic IDE footer; projectless results remove stale footers but retain examples and explicit links", () => {
  const old = "[打开项目 Web IDE](https://ide.example/workspace/old)", url = "https://ide.example/workspace/new";
  const result = withIDEEntry(`完成\n\n${old}\n\n${old}`, url);
  assert.equal(result, `完成\n\n[打开项目 Web IDE](${url})`);
  assert.equal(withIDEEntry(result), "完成");
  const explicit = "[目标项目](https://ide.example/workspace/target)";
  assert.equal(withIDEEntry(explicit), explicit);
  const example = `\`\`\`md\n${old}\n\`\`\``;
  assert.equal(withIDEEntry(example), example, "model-authored examples are not Gateway footers");
});

test("IDE resolution re-reads disk-backed membership when its account is stopped", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-stopped-membership-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveAccount(paths, { accountId: "account", token: "fixture", baseUrl: "http://localhost" });
  const accountPaths = accountStatePaths(paths, "account"), store = new RuntimeStateStore(accountPaths);
  const project = store.createProject("project", "/project", { sourceProjectId: "native-project", hostId: "local" });
  const session = store.createSession("chat", "/project", "task", project.id); store.setSessionThread(session.id, "native-thread");
  const manager = new AccountManager({ paths });
  // Isolate the lifecycle regression from the developer's Desktop registry.
  const observer = manager as unknown as { observeThreadMembership(): boolean };
  observer.observeThreadMembership = () => { new RuntimeStateStore(accountPaths).reconcileThreadProject("native-thread", "local", undefined); return true; };
  assert.equal(manager.ideWorkspace("account", session.id), undefined);
  assert.equal(new RuntimeStateStore(accountPaths).getSession(session.id)!.projectBinding, "none");
});
