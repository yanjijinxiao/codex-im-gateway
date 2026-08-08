import assert from "node:assert/strict";
import test from "node:test";

import { AiChannelIntentResolver } from "../src/bridge/ai-channel-intent.js";
import {
  AI_CHANNEL_INTENT_OUTPUT_SCHEMA,
  commandsFromAiChannelIntentOutput
} from "../src/bridge/ai-channel-intent-decision.js";

const action = (intent: string, overrides: Record<string, unknown> = {}) => ({
  intent,
  confidence: 0.97,
  target: null,
  detail: null,
  ...overrides
});

test("maps up to four actions in declared order", () => {
  const commands = commandsFromAiChannelIntentOutput(JSON.stringify({
    schemaVersion: 2,
    kind: "actions",
    actions: [
      action("project_switch", { target: "知识库项目" }),
      action("mode_task"),
      action("task_list"),
      action("goal_show")
    ]
  }));

  assert.deepEqual(commands, [
    { name: "project", arg: "switch 知识库项目" },
    { name: "mode", arg: "task" },
    { name: "task", arg: "list" },
    { name: "goal", arg: "" }
  ]);
});

test("rejects mixed low-confidence and oversized decisions without a partial prefix", () => {
  const validAction = action("status");
  const invalidOutputs = [
    { schemaVersion: 2, kind: "actions", actions: [validAction, action("ordinary_chat")] },
    { schemaVersion: 2, kind: "actions", actions: [validAction, action("task_list", { confidence: 0.79 })] },
    { schemaVersion: 2, kind: "actions", actions: Array.from({ length: 5 }, () => validAction) },
    { schemaVersion: 2, kind: "actions", actions: [] },
    { schemaVersion: 1, kind: "actions", actions: [validAction] },
    { schemaVersion: 2, kind: "actions", actions: [validAction], unexpected: true },
    { schemaVersion: 2, kind: "actions", actions: [action("project_switch", { target: "bad\nname" })] },
    { schemaVersion: 2, kind: "actions", actions: [action("task_new", { detail: "" })] },
    { schemaVersion: 2, kind: "actions", actions: [action("task_new", { detail: "x".repeat(2_001) })] }
  ];

  for (const output of invalidOutputs) {
    assert.equal(commandsFromAiChannelIntentOutput(JSON.stringify(output)), undefined);
  }
});

test("maps ordinary chat and malformed output to no commands", () => {
  assert.equal(commandsFromAiChannelIntentOutput(JSON.stringify({
    schemaVersion: 2,
    kind: "ordinary_chat",
    actions: []
  })), undefined);
  assert.equal(commandsFromAiChannelIntentOutput("not-json"), undefined);
});

test("uses a response-format-compatible schema without unsupported oneOf", () => {
  const serializedSchema = JSON.stringify(AI_CHANNEL_INTENT_OUTPUT_SCHEMA);
  assert.doesNotMatch(serializedSchema, /"oneOf"/);
});

test("includes actor and conversation identity in classifier context", async () => {
  const contexts: unknown[] = [];
  const resolver = new AiChannelIntentResolver(async (prompt) => {
    contexts.push(parseClassifierContext(prompt));
    return JSON.stringify({ schemaVersion: 2, kind: "ordinary_chat", actions: [] });
  });

  await resolver.resolve({
    text: "我当前有哪些任务",
    actorId: "alice",
    conversationId: "alice",
    conversationKind: "direct",
    projectNames: ["Bridge"]
  });
  await resolver.resolve({
    text: "我先切到 Bridge，再看任务",
    actorId: "alice",
    conversationId: "chat-team",
    conversationKind: "shared",
    projectNames: ["Bridge"]
  });

  assert.deepEqual(contexts, [
    {
      message: "我当前有哪些任务",
      actor: { actorId: "alice", conversationId: "alice", conversationKind: "direct" },
      currentProject: null,
      currentMode: null,
      knowledgeBase: null,
      availableProjects: ["Bridge"]
    },
    {
      message: "我先切到 Bridge，再看任务",
      actor: { actorId: "alice", conversationId: "chat-team", conversationKind: "shared" },
      currentProject: null,
      currentMode: null,
      knowledgeBase: null,
      availableProjects: ["Bridge"]
    }
  ]);
});

test("instructs the AI to keep mode and goal product discussions in ordinary chat", async () => {
  let classifierPrompt = "";
  const resolver = new AiChannelIntentResolver(async (prompt) => {
    classifierPrompt = prompt;
    return JSON.stringify({ schemaVersion: 2, kind: "ordinary_chat", actions: [] });
  });

  await resolver.resolve({
    text: "为什么会话模式默认进入目标，目标和计划也应该正常回复对话内容",
    actorId: "alice",
    conversationId: "alice",
    conversationKind: "direct",
    currentProjectName: "Bridge",
    projectNames: ["Bridge"]
  });

  assert.match(classifierPrompt, /讨论或质疑.*模式.*目标.*计划.*ordinary_chat/);
});

test("instructs the AI to create a task for concrete work assigned in task mode", async () => {
  let classifierPrompt = "";
  const resolver = new AiChannelIntentResolver(async (prompt) => {
    classifierPrompt = prompt;
    return JSON.stringify({ schemaVersion: 2, kind: "ordinary_chat", actions: [] });
  });

  await resolver.resolve({
    text: "相关开发文档和技术调研都移动到项目目录里",
    actorId: "ou_actor",
    conversationId: "oc_team",
    conversationKind: "shared",
    currentProjectName: "wx-claw",
    currentMode: "task",
    projectNames: ["wx-claw"]
  });

  assert.match(classifierPrompt, /当前模式为 task.*具体工作.*task_new/);
});

test("resolves one action compatibly and multiple actions as an ordered sequence", async () => {
  const outputs = [
    {
      schemaVersion: 2,
      kind: "actions",
      actions: [action("status")]
    },
    {
      schemaVersion: 2,
      kind: "actions",
      actions: [action("project_switch", { target: "Bridge" }), action("task_list")]
    }
  ];
  let outputIndex = 0;
  const resolver = new AiChannelIntentResolver(async () => JSON.stringify(outputs[outputIndex++]));
  const input = {
    text: "渠道操作",
    actorId: "alice",
    conversationId: "alice",
    conversationKind: "direct" as const,
    projectNames: ["Bridge"]
  };

  assert.deepEqual(await resolver.resolve(input), {
    kind: "command",
    command: { name: "status", arg: "" }
  });
  assert.deepEqual(await resolver.resolve(input), {
    kind: "command_sequence",
    commands: [
      { name: "project", arg: "switch Bridge" },
      { name: "task", arg: "list" }
    ]
  });
});

function parseClassifierContext(prompt: string): unknown {
  const lines = prompt.split("\n");
  const serializedContext = lines[lines.length - 1];
  assert.ok(serializedContext);
  const context: unknown = JSON.parse(serializedContext);
  return context;
}
