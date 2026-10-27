import assert from "node:assert/strict";
import test from "node:test";
import { TaskboardWorkbench } from "../src/taskboard/workbench.js";
import { TaskboardSubmissionDeduplicator } from "../src/bridge/taskboard-channel-dedup.js";

for (const conflict of [false, true]) test(`Taskboard Web status and evidence use one optimistic transaction (conflict=${conflict})`, async () => {
  const issue = { id: "issue", identifier: "P-1", projectId: "p", status: "in_progress", version: 3, threadId: "thread" };
  const mutations: any[] = [];
  const client = {
    async getIssue() { return issue; },
    async listProjects() { return [{ id: "p", workspacePath: "/project", name: "Project" }]; },
    async addComment() { mutations.push("separate comment"); return {}; },
    async moveIssue() { mutations.push("separate move"); if (conflict) throw Error("version conflict"); return { ...issue, status: "blocked" }; },
    async moveIssueWithComment(...args: any[]) {
      mutations.push(args); if (conflict) throw Error("version conflict");
      return { task: { ...issue, status: "blocked" }, comment: {} };
    }
  };
  const workbench = new TaskboardWorkbench({ client: () => client as never,
    projects: () => [{ accountId: "a", projectId: "managed", projectName: "Project", workspace: "/project" }] });
  const result = workbench.moveIssue("P-1", "blocked", 3, "  Waiting for permission  ");
  if (conflict) await assert.rejects(result, /version conflict/); else assert.equal((await result).status, "blocked");
  assert.deepEqual(mutations, [["issue", "blocked", 3, "thread", "Waiting for permission"]]);
});

for (const changed of [{ body: "different evidence" }, { version: 4 }]) test(`Taskboard idempotency compares full payload (${Object.keys(changed)[0]})`, () => {
  const dedup = new TaskboardSubmissionDeduplicator();
  const submission = { operation: "comment" as const, identifier: "P-1", version: 3, body: "evidence", request_id: "request" };
  const first = dedup.reserve("request", "project", submission); assert.equal(first.kind, "owner");
  if (first.kind === "owner") first.finish(true);
  assert.equal(dedup.reserve("request", "project", { ...submission, ...changed }).kind, "mismatch");
  assert.equal(dedup.reserve("request", "project", { ...submission }).kind, "duplicate");
});
