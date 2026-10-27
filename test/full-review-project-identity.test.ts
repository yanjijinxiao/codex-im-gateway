import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { BridgeService } from "../src/bridge/service.js";
import { AccountManager } from "../src/server/account-manager.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { localProjectsAtWorkspace } from "../src/state/project-identity.js";

test("local legacy cwd mappings preserve directory aliases without merging distinct native identities", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-project-alias-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actual = path.join(root, "actual"), alias = path.join(root, "alias");
  fs.mkdirSync(actual); fs.symlinkSync(actual, alias, "dir");
  const selected = { workspace: alias, sourceProjectId: "selected" };
  assert.deepEqual(localProjectsAtWorkspace(actual, [selected]), [selected]);
  assert.deepEqual(localProjectsAtWorkspace(actual, [selected, { workspace: actual, sourceProjectId: "other" }]), []);
  assert.deepEqual(localProjectsAtWorkspace(actual, [{ ...selected, hostId: "remote" }]), []);
});

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-review-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root), store = new RuntimeStateStore(paths);
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["chat"] }, stateStore: store,
    weixin: { async sendText() { return { messageId: "receipt" }; } }, runner: {} as never });
  return { root, paths, store, service: service as any };
}
const candidate = (workspace: string, projectId: string, hostId = "local") => ({ name: projectId, workspace, projectId, hostId,
  lastUsedAt: "", sessionCount: 0, projectKind: hostId === "local" ? "local" as const : "remote" as const });

test("project records distinguish native IDs at the same root and reject duplicate IDs after root moves", t => {
  const f = fixture(t), first = f.store.createProject("First", f.root, { sourceProjectId: "first" });
  const second = f.store.createProject("Second", f.root, { sourceProjectId: "second" });
  assert.notEqual(second.id, first.id);
  assert.throws(() => f.store.createProject("Moved", path.join(f.root, "moved"), { sourceProjectId: "first" }), /already exists/);
  const remote = f.store.createProject("Remote", f.root, { sourceProjectId: "first", hostId: "remote" });
  assert.notEqual(remote.id, first.id);
});
test("a known project identity cannot be silently reassigned by metadata refresh", t => {
  const f = fixture(t), project = f.store.createProject("First", f.root, { sourceProjectId: "first" });
  assert.throws(() => f.store.updateProjectMetadata(project.id, { sourceProjectId: "second" }), /identity|身份/);
  assert.throws(() => f.store.updateProjectMetadata(project.id, { hostId: "remote" }), /identity|身份/);
  assert.equal(f.store.getProject(project.id)?.sourceProjectId, "first");
  assert.equal(f.store.getProject(project.id)?.hostId, undefined);
});
test("legacy membership migration cannot borrow another host or an ambiguous native project", t => {
  const f = fixture(t), first = f.store.createProject("First", "/same", { sourceProjectId: "first" });
  const session = f.store.createSession("chat", "/same", "Legacy", first.id);
  const snapshot = f.store.snapshot; delete snapshot.sessions[0].projectId; snapshot.sessions[0].hostId = "remote";
  fs.writeFileSync(f.paths.statePath, JSON.stringify(snapshot));
  const restored = new RuntimeStateStore(f.paths), migrated = restored.getSession(session.id)!;
  assert.notEqual(migrated.projectId, first.id);
  assert.equal(restored.getProject(migrated.projectId!)?.hostId, "remote");
});
test("a legacy registration cannot acquire a native identity already represented by another record", t => {
  const f = fixture(t), legacy = f.store.createProject("Legacy", f.root), known = f.store.createProject("Known", f.root, { sourceProjectId: "native" });
  f.service.synchronizeManagedProjects([candidate(f.root, "native")]);
  assert.equal(f.store.getProject(legacy.id)?.sourceProjectId, undefined);
  assert.equal(f.store.getProject(known.id)?.sourceProjectId, "native");
  assert.throws(() => f.store.updateProjectMetadata(legacy.id, { sourceProjectId: "native" }), /identity|身份/);
});
for (const id of ["selected", "missing", undefined]) test(`Bridge project refresh respects explicit identity and ambiguous legacy roots (${id})`, t => {
  const f = fixture(t), project = f.store.createProject("Project", f.root, { sourceProjectId: id });
  const rows = [candidate(f.root, "first"), { ...candidate(f.root, "selected"), rootPaths: [f.root, "/sibling"] }];
  f.service.synchronizeManagedProject(project, rows);
  assert.equal(f.store.getProject(project.id)?.sourceProjectId, id);
  if (id === "selected") assert.deepEqual(f.store.getProject(project.id)?.rootPaths, [f.root, "/sibling"]);
  assert.equal(f.service.boundProjectForCandidate(candidate(f.root, "different")), undefined);
});
test("binding an existing unfollowed thread refreshes its confirmed membership and cwd", async t => {
  const f = fixture(t), project = f.store.createProject("Old", "/old", { sourceProjectId: "old" });
  const session = f.store.createSession("chat", "/old", "Task", project.id);
  f.store.setSessionThread(session.id, "thread"); f.store.setSessionFollow(session.id, false);
  f.service.runner = { async inspectThread() { return { threadId: "thread", cwd: "/new", projectId: "new",
    projectMembership: "assigned", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; }, async getHistory() { return []; } };
  await f.service.bindCatalogSession("chat", "thread", "local");
  const bound = f.store.getBoundSession("chat")!;
  assert.equal(bound.id, session.id); assert.equal(bound.workspace, "/new");
  assert.equal(f.store.getProject(bound.projectId!)?.sourceProjectId, "new");
  assert.equal(bound.follow, false);
});

test("Web project registration uses host plus native ID and never widens global workspace permission", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-review-project-api-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); saveConfig(paths, defaultConfig(root));
  saveAccount(paths, { accountId: "one", token: "synthetic", userId: "actor", baseUrl: "https://example.invalid", enabled: false });
  const manager = new AccountManager({ paths }); t.after(() => manager.stopAll());
  const workspace = "/shared/same-root", rows = [candidate(workspace, "first"), candidate(workspace, "second"), candidate(workspace, "first", "remote")];
  const server = await startLocalHttpServer({ paths, port: 0, accountManager: manager, codexProjectsProvider: () => rows }); t.after(() => server.close());
  const before = fs.readFileSync(paths.configPath, "utf8");
  const create = (extra: object, accountId = "one") => fetch(`${server.url}/api/projects`, { method: "POST",
    headers: { Origin: server.url, "Content-Type": "application/json", "X-Codex-Im-Gateway-Token": server.requestToken },
    body: JSON.stringify({ accountId, name: "Project", workspace, source: "codex-history", ...extra }) });
  assert.equal((await create({})).status, 400, "an old root-only picker must refresh an ambiguous choice");
  for (const row of rows) {
    const response = await create({ hostId: row.hostId, sourceProjectId: row.projectId });
    assert.equal(response.status, 201, await response.clone().text());
    const { project } = await response.json(); assert.equal(project.hostId ?? "local", row.hostId); assert.equal(project.sourceProjectId, row.projectId);
    const session = manager.createSession("one", `chat-${row.hostId}-${row.projectId}`, undefined, "Task", project.id);
    assert.equal(session.binding.hostId, row.hostId);
  }
  assert.equal((await create({ hostId: "missing", sourceProjectId: "first" })).status, 400);
  assert.equal((await create({ hostId: "local", sourceProjectId: "first" }, "missing-account")).status, 404);
  assert.equal(fs.readFileSync(paths.configPath, "utf8"), before);
  assert.deepEqual(loadConfig(paths).allowedWorkspaces, [root]);
});

test("Web picker carries the selected host and project ID even when roots coincide", async () => {
  const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderCodexProjectOptions()"), end = source.indexOf("function openRenameProjectDialog", start);
  const saveStart = source.indexOf("async function saveProject(event)"), saveEnd = source.indexOf("function openRenameSessionDialog", saveStart);
  const fields = new Map<string, any>(); const field = (id: string) => { if (!fields.has(id)) fields.set(id, { value: "", disabled: false, textContent: "", innerHTML: "" }); return fields.get(id); };
  field("#projectAccountInput").value = "one";
  const rows = [candidate("/same", "first"), candidate("/same", "first", "remote")], requests: any[] = [];
  const context = vm.createContext({ state: { projects: [{ ...rows[0], accountId: "one", sourceProjectId: "first" }], codexProjects: rows },
    document: { querySelector: field }, escapeAttr: (s: string) => s, escapeHtml: (s: string) => s,
    api: async (_url: string, input: any) => requests.push(input), els: { projectDialog: { close() {} } }, refreshData: async () => {}, toast(message: string) { assert.fail(message); } });
  vm.runInContext(source.slice(start, end) + source.slice(saveStart, saveEnd), context);
  context.renderCodexProjectOptions();
  assert.equal(field("#projectWorkspaceInput").disabled, false);
  await context.saveProject({ preventDefault() {}, submitter: {} });
  assert.equal(requests[0].body.workspace, "/same"); assert.equal(requests[0].body.hostId, "remote"); assert.equal(requests[0].body.sourceProjectId, "first");
});
