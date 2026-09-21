import assert from "node:assert/strict";
import test from "node:test";

import { AiChannelIntentResolver } from "../src/bridge/ai-channel-intent.js";
import {
  AI_CHANNEL_INTENT_OUTPUT_SCHEMA,
  commandsFromAiChannelIntentOutput
} from "../src/bridge/ai-channel-intent-decision.js";
import type { ChannelCommandCapability } from "../src/bridge/channel-capability.js";

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

test("keeps capability questions and help discussions in chat even after a confident help misclassification", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "info", (message: string) => logs.push(message));
  const resolver = new AiChannelIntentResolver(async () => JSON.stringify({
    schemaVersion: 2, kind: "actions", actions: [action("help", { confidence: 1 })]
  }));
  const questions = [
    "那你可以在群里面加机器人吗？",
    "dws cli是否可以创建一个群？",
    "可以创建到一个特定的分组里面吗？",
    "DWS CLI 支持哪些命令？",
    "你能做什么？",
    "你能不能帮我看一下？",
    "Gateway 可以发送文件吗？",
    "help me add a bot to this group",
    "Can you show me how to add a bot?",
    "不要显示帮助菜单",
    "为什么又显示帮助菜单？",
    "为什么我发你好，你回复 /help？",
    "代码里有 show me help，解释一下",
    "“查看帮助”是什么意思？",
    "修复工作台帮助菜单",
    "显示帮助菜单\n其实不要显示，回答上一个问题"
  ];
  for (const text of questions) {
    assert.equal(await resolver.resolve({
      text, actorId: "private-actor", conversationId: "private-chat",
      conversationKind: "shared", projectNames: []
    }), undefined, text);
  }
  assert.equal(logs.length, questions.length);
  assert.ok(logs.every((line) => line.includes("Ignoring inferred /help")));
  assert.ok(logs.every((line) => !line.includes("private-") && !questions.some((text) => line.includes(text))));
});

test("allows explicit natural-language help requests", async () => {
  const resolver = new AiChannelIntentResolver(async () => JSON.stringify({
    schemaVersion: 2, kind: "actions", actions: [action("help")]
  }));
  for (const text of [
    "帮助", "查看帮助", "请显示帮助菜单！", "请给我查看一下工作台的命令列表。", "打开工作台",
    "工作台支持哪些命令？", "Codex IM Gateway 支持哪些命令?", "gateway 的帮助菜单",
    "HELP", "Show me help", "Please list gateway commands.", "What commands does the gateway support?"
  ]) {
    assert.deepEqual(await resolver.resolve({
      text, actorId: "alice", conversationId: "alice", conversationKind: "direct", projectNames: []
    }), { kind: "command", command: { name: "help", arg: "" } }, text);
  }
});

test("rejects the entire inferred action sequence if it includes an unsolicited help menu", async (t) => {
  t.mock.method(console, "info", () => {});
  for (const actions of [
    [action("project_switch", { target: "Other" }), action("help")],
    [action("help"), action("mode_task")]
  ]) {
    const resolver = new AiChannelIntentResolver(async () => JSON.stringify({ schemaVersion: 2, kind: "actions", actions }));
    assert.equal(await resolver.resolve({
      text: "可以帮我看看别的项目怎么建群吗？", actorId: "alice", conversationId: "alice",
      conversationKind: "direct", projectNames: ["Other"]
    }), undefined);
  }
});

test("instructs the classifier not to substitute help for capability questions or ambiguous follow-ups", async () => {
  let prompt = "";
  const resolver = new AiChannelIntentResolver(async (input) => {
    prompt = input;
    return JSON.stringify({ schemaVersion: 2, kind: "ordinary_chat", actions: [] });
  });
  await resolver.resolve({
    text: "那你可以在群里面加机器人吗？", actorId: "alice", conversationId: "alice",
    conversationKind: "direct", projectNames: []
  });
  assert.match(prompt, /具体能力.*ordinary_chat/);
  assert.match(prompt, /help 不是无法分类时的默认值/);
  assert.match(prompt, /没有之前的对话历史.*ordinary_chat/);
});

test("ignores classifier arguments for extension actions that declare no argument", () => {
  const capability: ChannelCommandCapability = {
    id: "example",
    commandName: "example",
    aliases: {},
    helpLine: "/example - 示例",
    aiActions: [{
      intent: "example_status",
      operation: "status",
      guidance: "查看示例状态。",
      argument: "none"
    }],
    resolve: () => ({ kind: "reply", text: "unused" })
  };
  const commands = commandsFromAiChannelIntentOutput(JSON.stringify({
    schemaVersion: 2,
    kind: "actions",
    actions: [action("example_status", { target: "ignored", detail: "ignored" })]
  }), [capability]);

  assert.deepEqual(commands, [{ name: "example", arg: "status" }]);
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
