import assert from "node:assert/strict";
import test from "node:test";

import { AiChannelIntentResolver } from "../src/bridge/ai-channel-intent.js";
import {
  createTaskCard,
  formatChannelActionCommand,
  parseChannelActionValue
} from "../src/channels/task-card.js";

test("maps the spoken panel question from an AI decision to the Taskboard task list", async () => {
  const resolver = new AiChannelIntentResolver(async () => JSON.stringify({
    schemaVersion: 1,
    intent: "task_list",
    confidence: 0.97,
    target: null,
    detail: null
  }));

  const intent = await resolver.resolve({
    text: "前面板有哪些",
    currentProjectName: "Codex Channel Bridge",
    projectNames: ["Codex Channel Bridge"]
  });

  assert.deepEqual(intent, {
    kind: "command",
    command: { name: "task", arg: "list" }
  });
});

test("maps an AI command-list decision to built-in help", async () => {
  const resolver = new AiChannelIntentResolver(async () => JSON.stringify({
    schemaVersion: 1,
    intent: "help",
    confidence: 0.98,
    target: null,
    detail: null
  }));

  const intent = await resolver.resolve({ text: "当前有哪些命令", projectNames: [] });

  assert.deepEqual(intent, {
    kind: "command",
    command: { name: "help", arg: "" }
  });
});

test("falls back to ordinary chat when the AI decision is not trusted", async () => {
  const resolver = new AiChannelIntentResolver(async () => JSON.stringify({
    schemaVersion: 1,
    intent: "task_accept",
    confidence: 0.4,
    target: "BRIDGE-12",
    detail: null
  }));

  const intent = await resolver.resolve({ text: "帮我看看这段代码", projectNames: [] });

  assert.equal(intent, undefined);
});

test("maps semantic Q&A, planning, and goal decisions to native channel controls", async () => {
  const decisions = [
    { intent: "mode_qa", target: null, detail: null },
    { intent: "plan_on", target: null, detail: null },
    { intent: "goal_set", target: null, detail: "完成知识库渠道集成" }
  ] as const;
  const intents = [];
  for (const decision of decisions) {
    const resolver = new AiChannelIntentResolver(async () => JSON.stringify({
      schemaVersion: 1,
      confidence: 0.98,
      ...decision
    }));
    intents.push(await resolver.resolve({
      text: "自然语言工作模式操作",
      currentProjectName: "Bridge",
      currentMode: "session",
      knowledgeBaseName: "产品 Wiki",
      projectNames: ["Bridge"]
    }));
  }

  assert.deepEqual(intents, [
    { kind: "command", command: { name: "mode", arg: "qa" } },
    { kind: "command", command: { name: "plan", arg: "on" } },
    { kind: "command", command: { name: "goal", arg: "set 完成知识库渠道集成" } }
  ]);
});

test("formats native goal form input as a goal command", () => {
  const value = {
    version: 3 as const,
    command: "goal" as const,
    arg: "set" as const,
    field: { name: "objective" as const, required: true as const, maximumLength: 2_000 }
  };
  assert.equal(formatChannelActionCommand(value, {}), undefined);
  assert.equal(formatChannelActionCommand(value, { objective: "  完成知识库渠道集成  " }), "/goal 完成知识库渠道集成");
});

test("maps natural-language task mutations to native forms and explicit confirmation cards", async () => {
  const decisions = [
    { intent: "task_todo", target: null, detail: "补充交互文档" },
    { intent: "task_block", target: null, detail: "等待接口权限" },
    { intent: "task_accept", target: "BRIDGE-12", detail: null },
    { intent: "task_start", target: null, detail: null }
  ] as const;
  const intents = [];
  for (const decision of decisions) {
    const resolver = new AiChannelIntentResolver(async () => JSON.stringify({
      schemaVersion: 1,
      confidence: 0.98,
      ...decision
    }));
    intents.push(await resolver.resolve({ text: "自然语言任务操作", projectNames: ["Bridge"] }));
  }

  assert.deepEqual(intents, [
    { kind: "command", command: { name: "task", arg: "form todo 补充交互文档" } },
    { kind: "command", command: { name: "task", arg: "form block current 等待接口权限" } },
    { kind: "command", command: { name: "task", arg: "detail BRIDGE-12" } },
    { kind: "command", command: { name: "task", arg: "list" } }
  ]);
});

test("builds status-aware task card actions and only accepts the bounded callback schema", () => {
  const card = createTaskCard("Bridge", {
    id: "task-one",
    identifier: "BRIDGE-1",
    projectId: "bridge",
    title: "完成渠道二期",
    description: "让自然语言、命令和卡片共用任务工作流",
    status: "in_review",
    priority: "high",
    labels: ["channel"],
    threadId: "thread-one",
    version: 4,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T01:00:00.000Z"
  }, { latestComment: "测试和构建均已通过" });

  assert.equal(card.projectName, "Bridge");
  assert.equal(card.identifier, "BRIDGE-1");
  assert.deepEqual(card.actions.map((action) => action.label), ["添加进展", "通过", "退回", "返回任务"]);
  const acceptCommand = formatChannelActionCommand(card.actions[1].value);
  assert.ok(acceptCommand?.startsWith("/task submit "));
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(acceptCommand?.slice("/task submit ".length))),
    {
      operation: "accept",
      identifier: "BRIDGE-1",
      version: "4",
      request_id: card.actions[1].value.version === 2 ? card.actions[1].value.parameters.request_id : ""
    }
  );
  assert.deepEqual(parseChannelActionValue(card.actions[2].value), {
    version: 1,
    command: "task",
    arg: "form return BRIDGE-1"
  });
  assert.equal(parseChannelActionValue({ command: "stop", arg: "" }), undefined);
  assert.equal(parseChannelActionValue({ version: 1, command: "task", arg: "x".repeat(2_001) }), undefined);
  assert.equal(parseChannelActionValue({
    version: 2,
    command: "task",
    arg: "submit",
    parameters: {
      operation: "accept",
      identifier: "BRIDGE-1",
      version: "4",
      request_id: "00000000-0000-4000-8000-000000000001",
      body: "伪造验收证据"
    },
    fields: []
  }), undefined);
  assert.equal(parseChannelActionValue({
    version: 2,
    command: "task",
    arg: "submit",
    parameters: {
      operation: "block",
      identifier: "BRIDGE-1",
      version: "4",
      request_id: "00000000-0000-4000-8000-000000000001"
    },
    fields: [{ name: "reason", parameter: "operation", required: true, maximumLength: 1_000 }]
  }), undefined);
});
