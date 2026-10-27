import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { TaskboardWorkbench } from "../src/taskboard/workbench.js";
import { resolveTaskboardChannelContext } from "../src/bridge/taskboard-channel-context.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-external-project-")), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "one", token: "synthetic", baseUrl: "https://example.test", enabled: false });
  const manager = new AccountManager({ paths }) as any;
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = manager.storeFor("one"), delivered: string[] = [];
  manager.sendProjectCompletion = async (project: { id: string }) => { delivered.push(project.id); };
  manager.finalizeExternalActivityStreams = async () => {};
  const completion = { sessionId: "same-thread", turnId: "turn", workspace: root, taskTitle: "Task", success: true, text: "Done" };
  return { root, manager, store, delivered, completion };
}

test("local completion cannot be redirected by a same-ID remote session", async t => {
  const f = fixture(t), local = f.store.createProject("Local", f.root), remote = f.store.createProject("Remote", f.root, { hostId: "remote" });
  const session = f.store.createSession("remote-chat", f.root, "Remote", remote.id);
  f.store.setSessionThread(session.id, "same-thread");
  await f.manager.notifyExternalCodexCompletion(f.completion);
  assert.deepEqual(f.delivered, [local.id]);
});

test("unbound external completion cannot pick among native projects sharing a root", async t => {
  const f = fixture(t);
  f.store.createProject("One", f.root, { sourceProjectId: "one" }); f.store.createProject("Two", f.root, { sourceProjectId: "two" });
  await f.manager.notifyExternalCodexCompletion(f.completion);
  assert.deepEqual(f.delivered, []);
  assert.equal(f.manager.projectForExternalThread("unbound", f.root), undefined);
});

test("local running tasks cannot be projected into a remote project", t => {
  const f = fixture(t), project = f.store.createProject("Remote", f.root, { hostId: "remote" });
  f.manager.externalCodexTasks.set("task", { sessionId: "same-thread", turnId: "turn", workspace: f.root, title: "Local task", startedAt: "", updatedAt: "" });
  assert.equal(f.manager.projectSummary("one", project, f.store).activeTaskCount, 0);
});

test("a remote same-ID binding cannot hide a local running task", t => {
  const f = fixture(t), local = f.store.createProject("Local", f.root), remote = f.store.createProject("Remote", f.root, { hostId: "remote" });
  const session = f.store.createSession("remote", f.root, "Remote", remote.id); f.store.setSessionThread(session.id, "same-thread");
  f.manager.externalCodexTasks.set("task", { sessionId: "same-thread", turnId: "turn", workspace: f.root, title: "Local task", startedAt: "", updatedAt: "" });
  assert.equal(f.manager.projectSummary("one", local, f.store).activeTaskCount, 1);
});

test("legacy Taskboard workspace mapping cannot merge different hosts or native IDs", async () => {
  const base = { accountId: "one", projectName: "Project", workspace: "/same", projectId: "managed" };
  const client = { async listProjects() { return [{ id: "tb", workspacePath: "/same", name: "Project" }]; }, async listIssues() { return [{ id: "issue", projectId: "tb" }]; } };
  const remote = new TaskboardWorkbench({ client: () => client as never, projects: () => [{ ...base, hostId: "remote" }] });
  assert.deepEqual(await remote.listIssues(), []);
  const ambiguous = new TaskboardWorkbench({ client: () => client as never, projects: () => [{ ...base, sourceProjectId: "one" }, { ...base, projectId: "other", sourceProjectId: "two" }] });
  assert.deepEqual(await ambiguous.listIssues(), []);
});

test("remote IM Taskboard cannot create or select a local workspace mapping", async t => {
  const f = fixture(t), project = f.store.createProject("Remote", f.root, { hostId: "remote" });
  f.store.createSession("chat", f.root, "Remote", project.id); let calls = 0;
  const result = await resolveTaskboardChannelContext({ stateStore: f.store, async replyText() {} },
    { async ensureProjectForWorkspace() { calls++; return {} as never; } }, "chat");
  assert.equal(result, undefined); assert.equal(calls, 0);
});
