import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveTaskboardChannelContext } from "../src/bridge/taskboard-channel-context.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { TaskboardClient, type TaskboardProject } from "../src/taskboard/client.js";

const timestamp = "2026-08-07T00:00:00.000Z";

test("syncs the Feishu conversation's bound project before opening its task context", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-project-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const workspace = path.join(root, "wx-claw");
  const project = stateStore.createProject("wx-claw", workspace);
  const session = stateStore.createSession("oc_test", workspace, "飞书任务", project.id);
  stateStore.setInteractionMode("oc_test", "task");
  const taskboardProject: TaskboardProject = {
    id: project.id,
    name: project.name,
    workspacePath: workspace,
    issueCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const ensured: Array<{ readonly id: string; readonly name: string; readonly workspace: string }> = [];
  const replies: string[] = [];
  const client: Pick<TaskboardClient, "ensureProjectForWorkspace"> = {
    async ensureProjectForWorkspace(input) {
      ensured.push(input);
      return taskboardProject;
    }
  };

  const context = await resolveTaskboardChannelContext({
    stateStore,
    replyText: async (_senderId, text) => { replies.push(text); }
  }, client, "oc_test");

  assert.equal(context?.managedProject.id, project.id);
  assert.equal(context?.session?.id, session.id);
  assert.equal(context?.taskboardProject.id, project.id);
  assert.deepEqual(ensured, [{ id: project.id, name: "wx-claw", workspace }]);
  assert.deepEqual(replies, []);
});

test("creates a Taskboard project when its workspace has not been mapped", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const workspace = "/tmp/wx-claw";
  const project = {
    id: "managed-project-id",
    name: "wx-claw",
    workspacePath: workspace,
    issueCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const client = new TaskboardClient({
    baseUrl: "http://127.0.0.1:47823",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return init?.method === "POST"
        ? Response.json({ project }, { status: 201 })
        : Response.json({ projects: [] });
    }
  });

  const result = await client.ensureProjectForWorkspace({
    id: project.id,
    name: project.name,
    workspace
  });

  assert.equal(result.id, project.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    id: project.id,
    name: project.name,
    workspacePath: workspace
  });
});
