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
  assert.deepEqual(card.actions.map((action) => action.label), ["查看详情", "通过", "退回"]);
  assert.equal(formatChannelActionCommand(card.actions[1].value), "/task accept BRIDGE-1");
  assert.deepEqual(parseChannelActionValue(card.actions[2].value), {
    version: 1,
    command: "task",
    arg: "return BRIDGE-1"
  });
  assert.equal(parseChannelActionValue({ command: "stop", arg: "" }), undefined);
  assert.equal(parseChannelActionValue({ version: 1, command: "task", arg: "x".repeat(2_001) }), undefined);
});
