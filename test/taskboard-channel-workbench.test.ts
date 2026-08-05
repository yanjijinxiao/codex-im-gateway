import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import type { ChannelTaskCard } from "../src/channels/task-card.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { TaskboardClient, type TaskboardIssue } from "../src/taskboard/client.js";

type TaskboardFixture = {
  readonly client: TaskboardClient;
  readonly comments: string[];
  readonly moves: Array<{ readonly status: string; readonly version: number }>;
  readonly created: Array<{
    readonly title: string;
    readonly description: string;
    readonly priority: string;
    readonly labels: readonly string[];
  }>;
};

function createTaskboardFixture(
  workspace: string,
  initialIssues: readonly TaskboardIssue[],
  options: { readonly conflictOnTransition?: boolean } = {}
): TaskboardFixture {
  const issues = [...initialIssues];
  const comments: string[] = [];
  const moves: Array<{ status: string; version: number }> = [];
  const created: TaskboardFixture["created"] = [];
  const client = new TaskboardClient({
    baseUrl: "http://127.0.0.1:47823",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/projects") {
        return Response.json({ projects: [{
          id: "project-one",
          name: "Project One",
          workspacePath: workspace,
          issueCount: issues.length,
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z"
        }] });
      }
      if (url.pathname === "/api/tasks" && (init?.method ?? "GET") === "GET") {
        return Response.json({ tasks: issues });
      }
      if (url.pathname === "/api/tasks" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const issue: TaskboardIssue = {
          id: `task-${issues.length + 1}`,
          identifier: `PROJECT-${issues.length + 1}`,
          projectId: "project-one",
          title: String(body.title),
          description: String(body.description),
          status: "todo",
          priority: String(body.priority),
          labels: Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === "string") : [],
          threadId: null,
          version: 1,
          createdAt: "2026-08-05T02:00:00.000Z",
          updatedAt: "2026-08-05T02:00:00.000Z"
        };
        created.push({
          title: issue.title,
          description: issue.description,
          priority: issue.priority,
          labels: issue.labels
        });
        issues.push(issue);
        return Response.json({ task: issue }, { status: 201 });
      }
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (taskMatch) {
        const identifier = decodeURIComponent(taskMatch[1]);
        const issue = issues.find((candidate) => candidate.id === identifier || candidate.identifier === identifier);
        return issue ? Response.json({ task: issue }) : Response.json({ error: "not found" }, { status: 404 });
      }
      const commentMatch = /^\/api\/tasks\/([^/]+)\/comments$/.exec(url.pathname);
      if (commentMatch && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        comments.push(String(body.body));
        return Response.json({ comment: {
          id: `comment-${comments.length}`,
          taskId: decodeURIComponent(commentMatch[1]),
          body: String(body.body),
          threadId: String(body.threadId),
          createdAt: "2026-08-05T03:00:00.000Z",
          updatedAt: "2026-08-05T03:00:00.000Z"
        } }, { status: 201 });
      }
      if (commentMatch) return Response.json({ comments: [] });
      const moveMatch = /^\/api\/tasks\/([^/]+)\/move$/.exec(url.pathname);
      if (moveMatch && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const index = issues.findIndex((candidate) => candidate.id === decodeURIComponent(moveMatch[1]));
        const current = issues[index];
        if (!current || current.version !== body.version) {
          return Response.json({ error: "version conflict" }, { status: 409 });
        }
        const next = { ...current, status: body.status, version: current.version + 1, updatedAt: "2026-08-05T04:00:00.000Z" };
        issues[index] = next;
        moves.push({ status: String(body.status), version: Number(body.version) });
        return Response.json({ task: next });
      }
      const transitionMatch = /^\/api\/tasks\/([^/]+)\/transition$/.exec(url.pathname);
      if (transitionMatch && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const index = issues.findIndex((candidate) => candidate.id === decodeURIComponent(transitionMatch[1]));
        const current = issues[index];
        if (options.conflictOnTransition && current) {
          issues[index] = { ...current, version: current.version + 1 };
          return Response.json({ error: "version conflict" }, { status: 409 });
        }
        if (!current || current.version !== body.version) {
          return Response.json({ error: "version conflict" }, { status: 409 });
        }
        const next = { ...current, status: body.status, version: current.version + 1, updatedAt: "2026-08-05T04:00:00.000Z" };
        const comment = {
          id: `comment-${comments.length + 1}`,
          taskId: current.id,
          body: String(body.body),
          threadId: String(body.threadId),
          createdAt: "2026-08-05T03:00:00.000Z",
          updatedAt: "2026-08-05T03:00:00.000Z"
        };
        issues[index] = next;
        comments.push(comment.body);
        moves.push({ status: String(body.status), version: Number(body.version) });
        return Response.json({ task: next, comment });
      }
      return Response.json({ error: `Unhandled ${init?.method ?? "GET"} ${url.pathname}` }, { status: 500 });
    }
  });
  return { client, comments, moves, created };
}

function issue(identifier: string, status: TaskboardIssue["status"], version: number): TaskboardIssue {
  return {
    id: identifier.toLowerCase(), identifier, projectId: "project-one", title: `${identifier} title`,
    description: `${identifier} description`, status, priority: "high", labels: ["channel"],
    threadId: "thread-one", version, createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: `2026-08-05T0${version}:00:00.000Z`
  };
}

test("renders one paged overview card and updates the originating card in place", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-channel-overview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Project One", root);
  stateStore.createSession("oc_test", root, "Channel task", project.id);
  const fixture = createTaskboardFixture(root, [issue("PROJECT-1", "todo", 1), issue("PROJECT-2", "in_review", 2)]);
  const sent: ChannelTaskCard[] = [];
  const updated: Array<{ readonly messageId: string; readonly card: ChannelTaskCard }> = [];
  const channel = {
    async sendText() { return { messageId: "text" }; },
    async sendTaskCard(input: { readonly card: ChannelTaskCard }) { sent.push(input.card); return { messageId: "overview-card" }; },
    async updateTaskCard(input: { readonly messageId: string; readonly card: ChannelTaskCard }) { updated.push(input); }
  };
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] }, stateStore, taskboard: fixture.client, weixin: channel
  });

  await service.handleMessage({ id: "list", senderId: "oc_test", text: "/task list", attachments: [], raw: {} });
  assert.equal(sent.length, 1);
  assert.equal("kind" in sent[0] ? sent[0].kind : undefined, "overview");

  const detailClick = {
    id: "detail", senderId: "oc_test", text: "/task detail PROJECT-2", attachments: [], raw: {},
    interaction: { kind: "card" as const, messageId: "overview-card" }
  };
  await service.handleMessage(detailClick);
  assert.equal(sent.length, 1);
  assert.equal(updated[0]?.messageId, "overview-card");
  assert.equal("kind" in updated[0].card ? updated[0].card.kind : undefined, "detail");
});

test("sends a fresh native card when the originating card can no longer be patched", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-channel-patch-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Project One", root);
  stateStore.createSession("oc_test", root, "Channel task", project.id);
  const fixture = createTaskboardFixture(root, [issue("PROJECT-1", "todo", 1)]);
  const sent: ChannelTaskCard[] = [];
  let patchAttempts = 0;
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] }, stateStore, taskboard: fixture.client,
    weixin: {
      async sendText() { return { messageId: "text" }; },
      async sendTaskCard(input) { sent.push(input.card); return { messageId: "replacement" }; },
      async updateTaskCard() { patchAttempts += 1; throw new Error("card expired"); }
    }
  });

  await service.handleMessage({
    id: "detail",
    senderId: "oc_test",
    text: "/task detail PROJECT-1",
    attachments: [],
    raw: {},
    interaction: { kind: "card", messageId: "expired-card" }
  });

  assert.equal(patchAttempts, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].identifier, "PROJECT-1");
});

test("rejects a Feishu card click from an unauthorized operator", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-channel-operator-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const fixture = createTaskboardFixture(root, []);
  const replies: Array<{ readonly toUserId: string; readonly text: string }> = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["ou_owner"] },
    stateStore,
    taskboard: fixture.client,
    weixin: {
      async sendText(input) { replies.push(input); return { messageId: "text" }; },
      async sendTaskCard() { throw new Error("unauthorized actions must not render a Taskboard card"); }
    }
  });

  await service.handleMessage({
    id: "unauthorized-click",
    senderId: "ou_intruder",
    replyTargetId: "oc_untrusted",
    text: "/task list",
    attachments: [],
    raw: {}
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].toUserId, "oc_untrusted");
  assert.match(replies[0].text, /Access denied/);
});

test("uses native forms for task creation and executes their canonical submit command", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-channel-create-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Project One", root);
  stateStore.createSession("oc_test", root, "Channel task", project.id);
  const fixture = createTaskboardFixture(root, []);
  const cards: ChannelTaskCard[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] }, stateStore, taskboard: fixture.client,
    weixin: {
      async sendText() { return { messageId: "text" }; },
      async sendTaskCard(input) { cards.push(input.card); return { messageId: "card" }; }
    }
  });

  await service.handleMessage({ id: "form", senderId: "oc_test", text: "/task form new", attachments: [], raw: {} });
  assert.equal("kind" in cards[0] ? cards[0].kind : undefined, "form");

  const query = new URLSearchParams({
    operation: "create_todo", title: "完善飞书任务卡", description: "使用原生表单", priority: "high", labels: "feishu,channel"
  });
  await service.handleMessage({ id: "submit", senderId: "oc_test", text: `/task submit ${query}`, attachments: [], raw: {} });
  assert.deepEqual(fixture.created, [{
    title: "完善飞书任务卡", description: "使用原生表单", priority: "high", labels: ["feishu", "channel"]
  }]);
  assert.equal("kind" in cards.at(-1) ? cards.at(-1)?.kind : undefined, "detail");
});

test("routes a native start action without a thread through the Taskboard skill", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-channel-native-start-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Project One", root);
  stateStore.createSession("oc_test", root, "Channel task", project.id);
  const unstarted = { ...issue("PROJECT-1", "todo", 1), threadId: null };
  const fixture = createTaskboardFixture(root, [unstarted]);
  const prompts: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] },
    stateStore,
    taskboard: fixture.client,
    weixin: {
      async sendText() { return { messageId: "text" }; },
      async sendTaskCard() { return { messageId: "card" }; }
    },
    runner: {
      async run(input: { readonly prompt: string }) {
        prompts.push(input.prompt);
        return { raw: "", text: "已开始", threadId: "thread-new" };
      },
      async stop() {}
    } as never
  });
  const query = new URLSearchParams({
    operation: "start",
    identifier: "PROJECT-1",
    version: "1",
    request_id: "00000000-0000-4000-8000-000000000010"
  });

  await service.handleMessage({ id: "start", senderId: "oc_test", text: `/task submit ${query}`, attachments: [], raw: {} });

  assert.match(prompts[0] ?? "", /manage-taskboard Skill/);
  assert.match(prompts[0] ?? "", /PROJECT-1/);
});

test("rejects a stale native mutation before writing evidence or moving the issue", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-channel-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Project One", root);
  stateStore.createSession("oc_test", root, "Channel task", project.id);
  const fixture = createTaskboardFixture(root, [issue("PROJECT-1", "in_review", 5)]);
  const cards: ChannelTaskCard[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] }, stateStore, taskboard: fixture.client,
    weixin: {
      async sendText() { return { messageId: "text" }; },
      async sendTaskCard(input) { cards.push(input.card); return { messageId: "card" }; }
    }
  });
  const query = new URLSearchParams({ operation: "return", identifier: "PROJECT-1", version: "4", body: "缺少真机验证" });

  await service.handleMessage({ id: "stale", senderId: "oc_test", text: `/task submit ${query}`, attachments: [], raw: {} });

  assert.deepEqual(fixture.comments, []);
  assert.deepEqual(fixture.moves, []);
  assert.match(cards.at(-1)?.fallbackText ?? "", /任务已更新|版本/);
});

test("keeps evidence and status unchanged when an atomic transition loses a version race", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-channel-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Project One", root);
  stateStore.createSession("oc_test", root, "Channel task", project.id);
  const fixture = createTaskboardFixture(root, [issue("PROJECT-1", "in_review", 4)], { conflictOnTransition: true });
  const cards: ChannelTaskCard[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] }, stateStore, taskboard: fixture.client,
    weixin: {
      async sendText() { return { messageId: "text" }; },
      async sendTaskCard(input) { cards.push(input.card); return { messageId: "card" }; }
    }
  });
  const query = new URLSearchParams({ operation: "return", identifier: "PROJECT-1", version: "4", body: "缺少真机验证" });

  await service.handleMessage({ id: "race", senderId: "oc_test", text: `/task submit ${query}`, attachments: [], raw: {} });

  assert.deepEqual(fixture.comments, []);
  assert.deepEqual(fixture.moves, []);
  assert.match(cards.at(-1)?.fallbackText ?? "", /任务已更新|版本/);
});

test("never renders a foreign-project task when an invalid request ID is replayed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-channel-project-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Project One", root);
  stateStore.createSession("oc_test", root, "Channel task", project.id);
  const foreign = { ...issue("FOREIGN-1", "in_progress", 1), projectId: "project-two" };
  const fixture = createTaskboardFixture(root, [foreign]);
  const cards: ChannelTaskCard[] = [];
  const replies: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] }, stateStore, taskboard: fixture.client,
    weixin: {
      async sendText(input) { replies.push(input.text); return { messageId: "text" }; },
      async sendTaskCard(input) { cards.push(input.card); return { messageId: "card" }; }
    }
  });
  const query = new URLSearchParams({
    operation: "comment",
    identifier: foreign.identifier,
    version: "1",
    body: "探测内容",
    request_id: "00000000-0000-4000-8000-000000000099"
  });

  await service.handleMessage({ id: "foreign-1", senderId: "oc_test", text: `/task submit ${query}`, attachments: [], raw: {} });
  await service.handleMessage({ id: "foreign-2", senderId: "oc_test", text: `/task submit ${query}`, attachments: [], raw: {} });

  assert.equal(cards.length, 0);
  assert.equal(replies.length, 2);
  assert.ok(replies.every((reply) => reply.includes("不属于当前 Taskboard 项目")));
});

test("executes the native workflow and deduplicates repeated form submissions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-channel-workflow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Project One", root);
  stateStore.createSession("oc_test", root, "Channel task", project.id);
  const fixture = createTaskboardFixture(root, [issue("PROJECT-1", "in_progress", 1)]);
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] }, stateStore, taskboard: fixture.client,
    weixin: {
      async sendText() { return { messageId: "text" }; },
      async sendTaskCard() { return { messageId: "card" }; }
    }
  });
  const submit = async (input: {
    readonly id: string;
    readonly operation: string;
    readonly version: number;
    readonly body?: string;
  }) => {
    const query = new URLSearchParams({
      operation: input.operation,
      identifier: "PROJECT-1",
      version: String(input.version),
      request_id: input.id,
      ...(input.body ? { body: input.body } : {})
    });
    await service.handleMessage({
      id: input.id,
      senderId: "oc_test",
      text: `/task submit ${query}`,
      attachments: [],
      raw: {}
    });
  };
  const progressId = "00000000-0000-4000-8000-000000000001";

  await submit({ id: progressId, operation: "comment", version: 1, body: "完成回归检查" });
  await submit({ id: progressId, operation: "comment", version: 1, body: "完成回归检查" });
  await submit({ id: "00000000-0000-4000-8000-000000000002", operation: "block", version: 1, body: "等待权限" });
  await submit({ id: "00000000-0000-4000-8000-000000000003", operation: "start", version: 2 });
  await submit({ id: "00000000-0000-4000-8000-000000000004", operation: "review", version: 3, body: "测试通过" });
  await submit({ id: "00000000-0000-4000-8000-000000000005", operation: "return", version: 4, body: "补充渠道验证" });
  await submit({ id: "00000000-0000-4000-8000-000000000006", operation: "review", version: 5, body: "渠道验证通过" });
  await submit({ id: "00000000-0000-4000-8000-000000000007", operation: "accept", version: 6 });

  assert.deepEqual(fixture.comments, ["完成回归检查", "等待权限", "测试通过", "补充渠道验证", "渠道验证通过"]);
  assert.deepEqual(fixture.moves.map((move) => move.status), [
    "blocked", "in_progress", "in_review", "in_progress", "in_review", "done"
  ]);
});
