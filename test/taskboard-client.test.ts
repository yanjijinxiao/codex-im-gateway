import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskboardClient } from "../src/taskboard/client.js";

test("resolves projects and issues by workspace and Codex thread", async () => {
  const requests: string[] = [];
  const client = new TaskboardClient({
    baseUrl: "http://127.0.0.1:47823",
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/api/projects")) {
        return Response.json({ projects: [{
          id: "project-one",
          name: "Project One",
          workspacePath: "/tmp/project-one",
          issueCount: 1,
          createdAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:00.000Z"
        }] });
      }
      return Response.json({ tasks: [{
        id: "task-one",
        identifier: "PROJECT-1",
        projectId: "project-one",
        title: "Ship integration",
        description: "",
        status: "in_progress",
        priority: "high",
        labels: ["codex"],
        threadId: "thread-one",
        version: 3,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z"
      }] });
    }
  });

  const project = await client.projectForWorkspace("/tmp/project-one/../project-one");
  const issue = await client.issueForThread("project-one", "thread-one");

  assert.equal(project?.id, "project-one");
  assert.equal(issue?.identifier, "PROJECT-1");
  assert.match(requests[1] ?? "", /projectId=project-one/);
  assert.match(requests[1] ?? "", /threadId=thread-one/);
});

test("adds attributed comments and uploads local attachments", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-client-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const attachmentPath = path.join(root, "evidence.txt");
  fs.writeFileSync(attachmentPath, "verified evidence");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new TaskboardClient({
    baseUrl: "http://127.0.0.1:47823/",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/comments")) {
        return Response.json({ comment: {
          id: "comment-one",
          taskId: "task-one",
          body: "Ready",
          threadId: "thread-one",
          createdAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:00.000Z"
        } }, { status: 201 });
      }
      return Response.json({ attachment: {
        id: "attachment-one",
        taskId: "task-one",
        filename: "evidence.txt",
        contentType: "text/plain",
        size: 17,
        createdAt: "2026-08-03T00:00:00.000Z"
      } }, { status: 201 });
    }
  });

  await client.addComment("task-one", "Ready", "thread-one");
  await client.uploadAttachment("task-one", attachmentPath);

  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { body: "Ready", threadId: "thread-one" });
  assert.equal(new Headers(calls[1]?.init?.headers).get("x-taskboard-filename"), "evidence.txt");
  assert.deepEqual(calls[1]?.init?.body, Buffer.from("verified evidence"));
});

test("moves an issue with optimistic versioning and Codex attribution", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new TaskboardClient({
    baseUrl: "http://127.0.0.1:47823",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ task: {
        id: "task-one",
        identifier: "PROJECT-1",
        projectId: "project-one",
        title: "Ship integration",
        description: "",
        status: "in_review",
        priority: "high",
        labels: ["codex"],
        threadId: "thread-one",
        version: 4,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z"
      } });
    }
  });

  const issue = await client.moveIssue("task-one", "in_review", 3, "thread-one");

  assert.equal(issue.status, "in_review");
  assert.match(calls[0]?.url ?? "", /\/api\/tasks\/task-one\/move$/);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    status: "in_review",
    version: 3,
    threadId: "thread-one"
  });
});

test("moves an issue and records evidence through one atomic request", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const task = {
    id: "task-one", identifier: "PROJECT-1", projectId: "project-one", title: "Ship integration",
    description: "", status: "blocked", priority: "high", labels: ["codex"], threadId: "thread-one",
    version: 4, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
  };
  const comment = {
    id: "comment-one", taskId: "task-one", body: "Waiting for access", threadId: "thread-one",
    createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
  };
  const client = new TaskboardClient({
    baseUrl: "http://127.0.0.1:47823",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ task, comment });
    }
  });

  const result = await client.moveIssueWithComment("task-one", "blocked", 3, "thread-one", comment.body);

  assert.equal(result.task.status, "blocked");
  assert.equal(result.comment.body, comment.body);
  assert.match(calls[0]?.url ?? "", /\/api\/tasks\/task-one\/transition$/);
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-taskboard-client"), "taskctl");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    status: "blocked",
    version: 3,
    threadId: "thread-one",
    body: "Waiting for access"
  });
});

test("creates a Taskboard todo through the bounded local API payload", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const task = {
    id: "task-two", identifier: "PROJECT-2", projectId: "project-one", title: "Document channel cards",
    description: "", status: "todo", priority: "none", labels: [], threadId: null,
    version: 1, createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z"
  };
  const client = new TaskboardClient({
    baseUrl: "http://127.0.0.1:47823",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ task }, { status: 201 });
    }
  });

  const created = await client.createIssue({ projectId: "project-one", title: task.title });

  assert.equal(created.identifier, "PROJECT-2");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    projectId: "project-one",
    title: "Document channel cards",
    description: "",
    status: "todo",
    priority: "none",
    labels: []
  });
});

test("rejects non-loopback Taskboard origins", () => {
  assert.throws(
    () => new TaskboardClient({ baseUrl: "https://taskboard.example.com" }),
    /loopback/i
  );
});
test("accepts IPv6 loopback consistently with the embedded Taskboard listener policy", () => {
  assert.equal(new TaskboardClient({ baseUrl: "http://[::1]:4876" }).baseUrl, "http://[::1]:4876");
});
for (const ending of ["\n", "\r\n"]) test(`Taskboard SSE handles split ${JSON.stringify(ending)} delimiters and cancels after a consumer failure`, async () => {
  let cancelled = false;
  const payload = `event: updated${ending}data: {"type":"updated"}${ending}${ending}`;
  const client = new TaskboardClient({ baseUrl: "http://127.0.0.1:4876", fetch: async () => new Response(new ReadableStream({
    start(stream) { for (const char of payload) stream.enqueue(new TextEncoder().encode(char)); },
    cancel() { cancelled = true; }
  })) });
  const events: string[] = [];
  await assert.rejects(client.subscribe(new AbortController().signal, event => { events.push(event.type); throw Error("consumer failed"); }), /consumer failed/);
  assert.deepEqual(events, ["updated"]); assert.equal(cancelled, true);
});
test("Taskboard SSE bounds incomplete frames and releases the connection on overflow", async () => {
  let cancelled = false;
  const client = new TaskboardClient({ baseUrl: "http://127.0.0.1:4876", fetch: async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode("data: " + "x".repeat(2 * 1024 * 1024))); stream.close(); },
    cancel() { cancelled = true; }
  })) });
  await assert.rejects(client.subscribe(new AbortController().signal, () => { throw Error("must not emit"); }), /frame.*size|帧.*大小/i);
});

test("parses Taskboard status events from the SSE stream", async () => {
  const controller = new AbortController();
  const issue = {
    id: "task-one", identifier: "PROJECT-1", projectId: "project-one", title: "Ship integration",
    description: "", status: "in_review", priority: "high", labels: ["codex"], threadId: "thread-one",
    version: 4, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
  };
  const encoder = new TextEncoder();
  const client = new TaskboardClient({
    baseUrl: "http://127.0.0.1:47823",
    fetch: async () => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(encoder.encode(`: connected\n\nevent: task.moved\ndata: ${JSON.stringify({ type: "task.moved", projectId: "project-one", taskId: "task-one", task: issue })}\n\n`));
      }
    }), { headers: { "content-type": "text/event-stream" } })
  });
  const events: object[] = [];

  await client.subscribe(controller.signal, (event) => {
    events.push(event);
    controller.abort();
  });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "task.moved",
    projectId: "project-one",
    taskId: "task-one",
    task: issue,
    at: undefined
  });
});
