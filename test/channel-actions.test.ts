import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import { createChoiceCard, type ChannelActionCard } from "../src/channels/action-card.js";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

test("groups channel choices into clickable actions with a bounded command payload", () => {
  const card = createChoiceCard({
    title: "渠道工作台",
    body: "请选择下一步",
    fallbackText: "发送 /status、/project、/task 或 /sessions。",
    choices: [
      { label: "当前状态", command: "status", arg: "" },
      { label: "项目", command: "project", arg: "list" },
      { label: "任务", command: "task", arg: "list" },
      { label: "会话", command: "sessions", arg: "" }
    ]
  });

  assert.equal(card.actionGroups.length, 2);
  assert.deepEqual(card.actionGroups.flatMap((group) => group.map((action) => action.value)), [
    { version: 1, command: "status", arg: "" },
    { version: 1, command: "project", arg: "list" },
    { version: 1, command: "task", arg: "list" },
    { version: 1, command: "sessions", arg: "" }
  ]);
});

test("Feishu renders a generic action card as buttons", async () => {
  const messages: Array<Record<string, unknown>> = [];
  const adapter = new FeishuChannelAdapter({
    channel: "feishu",
    accountId: "feishu-test",
    appId: "cli_test",
    appSecret: "secret",
    savedAt: new Date().toISOString(),
    enabled: true
  }, {
    apiClient: {
      im: {
        v1: {
          image: { async create() { return { image_key: "unused" }; } },
          message: {
            async create(input: Record<string, unknown>) {
              messages.push(input);
              return { data: { message_id: "action-card-message" } };
            }
          },
          messageResource: { async get() { throw new Error("not used"); } }
        }
      }
    },
    wsClient: { async start() {}, close() {} }
  });
  const card = createChoiceCard({
    title: "选择项目",
    body: "当前项目：Bridge",
    fallbackText: "发送 /project P1 切换项目。",
    choices: [{ label: "Bridge", command: "project", arg: "P1", style: "primary" }]
  });

  const sent = await adapter.sendActionCard({ toUserId: "oc_test", card });

  assert.equal(sent.messageId, "action-card-message");
  const message = messages[0].data as { msg_type?: string; content?: string };
  assert.equal(message.msg_type, "interactive");
  const content = JSON.parse(message.content ?? "{}") as {
    elements?: Array<{ tag?: string; actions?: Array<{ value?: unknown }> }>;
  };
  assert.deepEqual(content.elements?.find((element) => element.tag === "action")?.actions?.[0]?.value, {
    version: 1,
    command: "project",
    arg: "P1"
  });
});

test("Bridge uses channel-native cards for help and fixed selections", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-actions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const firstProject = stateStore.createProject("Bridge", path.join(root, "bridge"));
  stateStore.createProject("Taskboard", path.join(root, "taskboard"));
  stateStore.createSession("oc_test", firstProject.workspace, "交互改造", firstProject.id);
  const cards: ChannelActionCard[] = [];
  const texts: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] },
    stateStore,
    listCodexModels: async () => [{
      model: "gpt-test",
      displayName: "GPT Test",
      description: "Test model",
      isDefault: true,
      defaultEffort: "medium",
      supportedEfforts: [
        { effort: "low", description: "Low" },
        { effort: "medium", description: "Medium" }
      ]
    }],
    weixin: {
      async sendText(input: { text: string }) {
        texts.push(input.text);
        return { messageId: `text-${texts.length}` };
      },
      async sendActionCard(input: { card: ChannelActionCard }) {
        cards.push(input.card);
        return { messageId: `card-${cards.length}` };
      }
    },
    runner: {
      async getRuntimeInfo() { return { model: "gpt-test", effort: "medium" }; },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id, senderId: "oc_test", text, attachments: [], raw: {}
  });

  await send("help", "/help");
  await send("projects", "/project");
  await send("sessions", "/sessions");
  await send("models", "/model");
  await send("efforts", "/effort");
  await send("stream", "/stream");
  await send("memory", "/memory");
  await send("prompt", "/prompt");

  assert.deepEqual(cards.map((card) => card.title), [
    "Codex 渠道工作台",
    "选择 Codex 项目",
    "选择会话",
    "选择模型",
    "选择推理强度",
    "过程进度",
    "个人知识库",
    "消息合并"
  ]);
  assert.deepEqual(
    cards[1].actionGroups.flatMap((group) => group.map((action) => action.value.arg)),
    ["P1", "P2"]
  );
  assert.deepEqual(
    cards[4].actionGroups.flatMap((group) => group.map((action) => action.value.arg)),
    ["1", "2", "default"]
  );
  assert.equal(texts.length, 0);
});

test("keeps project mode, plan mode, and goals on the selected project's thread", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-project-controls-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const firstProject = stateStore.createProject("First", path.join(root, "first"));
  const secondProject = stateStore.createProject("Second", path.join(root, "second"));
  const secondSession = stateStore.createSession("oc_test", secondProject.workspace, "Second session", secondProject.id);
  stateStore.setSessionThread(secondSession.id, "thread-second");
  stateStore.createSession("oc_test", firstProject.workspace, "First session", firstProject.id);
  const cards: ChannelActionCard[] = [];
  const goalThreads: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] },
    stateStore,
    weixin: {
      async sendText() { return { messageId: "text" }; },
      async sendActionCard(input: { readonly card: ChannelActionCard }) {
        cards.push(input.card);
        return { messageId: `card-${cards.length}` };
      }
    },
    runner: {
      async getGoal(threadId: string) {
        goalThreads.push(threadId);
        return {
          objective: "Ship selected project",
          status: "active" as const,
          tokensUsed: 120,
          timeUsedSeconds: 30
        };
      },
      async stop() {}
    } as never
  });
  const secondIndex = stateStore.listProjects().findIndex((project) => project.id === secondProject.id) + 1;
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "oc_test",
    text,
    attachments: [],
    raw: {}
  });

  await send("project", `/project P${secondIndex}`);
  assert.deepEqual(cards[0].actionGroups.flatMap((group) => group.map((action) => action.value)), [
    { version: 1, command: "mode", arg: "session" },
    { version: 1, command: "mode", arg: "task" },
    { version: 1, command: "mode", arg: "qa" }
  ]);

  stateStore.setSessionCollaborationMode(secondSession.id, "plan");
  await send("session-mode", "/mode session");
  assert.equal(stateStore.getActiveSession("oc_test")?.id, secondSession.id);
  assert.equal(stateStore.getActiveSession("oc_test")?.collaborationMode, undefined);
  assert.deepEqual(
    cards[1].actionGroups.flatMap((group) => group.map((action) => action.value.command)),
    ["sessions", "plan", "goal"]
  );

  await send("plan", "/plan on");
  assert.equal(stateStore.getActiveSession("oc_test")?.collaborationMode, "plan");
  assert.deepEqual(
    cards[2].actionGroups.flatMap((group) => group.map((action) => action.value)),
    [
      { version: 1, command: "plan", arg: "toggle" },
      { version: 1, command: "goal", arg: "" }
    ]
  );

  await send("plan-off", "/plan off");
  assert.equal(stateStore.getActiveSession("oc_test")?.collaborationMode, undefined);
  assert.equal(cards[3]?.title, "已回到普通对话");

  await send("goal", "/goal");
  assert.deepEqual(goalThreads, ["thread-second"]);
  assert.deepEqual(
    cards[4].actionGroups.flatMap((group) => group.map((action) => action.value.command)),
    ["goal", "goal", "goal", "goal"]
  );
});

test("natural plan and goal actions continue the original message while slash controls stay card-only", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-conversational-controls-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Bridge", root);
  const session = stateStore.createSession("oc_test", project.workspace, "对话", project.id);
  stateStore.setSessionThread(session.id, "thread-existing");
  const runs: Array<{ prompt: string; collaborationMode?: "default" | "plan" }> = [];
  const replies: string[] = [];
  const goals: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      },
      async sendActionCard() { return { messageId: "card" }; }
    } as never,
    intentResolver: {
      async resolve(input) {
        if (input.text.startsWith("先规划")) {
          return { kind: "command", command: { name: "plan", arg: "on" } };
        }
        return { kind: "command", command: { name: "goal", arg: "set 完成渠道交互" } };
      }
    },
    runner: {
      async run(input: { prompt: string; collaborationMode?: "default" | "plan" }) {
        runs.push(input);
        return { raw: "", text: `正常回复 ${runs.length}`, threadId: "thread-existing" };
      },
      async setGoal(_threadId: string, input: { objective?: string }) {
        goals.push(input.objective ?? "");
        return {
          objective: input.objective ?? "",
          status: "active" as const,
          tokensUsed: 0,
          timeUsedSeconds: 0
        };
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "oc_test",
    text,
    attachments: [],
    raw: {}
  });

  await send("slash-plan", "/plan on");
  await send("slash-plan-off", "/plan off");
  assert.equal(runs.length, 0);

  await send("natural-plan", "先规划一下渠道交互，然后给我方案");
  await send("slash-plan-off-again", "/plan off");
  await send("natural-goal", "目标是完成渠道交互，请告诉我下一步");

  assert.equal(runs.length, 2);
  assert.match(runs[0]?.prompt ?? "", /先规划一下渠道交互/);
  assert.equal(runs[0]?.collaborationMode, "plan");
  assert.match(runs[1]?.prompt ?? "", /目标是完成渠道交互/);
  assert.equal(runs[1]?.collaborationMode, undefined);
  assert.deepEqual(goals, ["完成渠道交互"]);
  assert.deepEqual(replies, ["正常回复 1", "正常回复 2"]);

  stateStore.resetSession(session.id);
  await send("natural-goal-new-thread", "目标是完成渠道交互，请直接开始");

  assert.equal(runs.length, 3);
  assert.equal(runs[2]?.collaborationMode, undefined);
  assert.equal(stateStore.getActiveSession("oc_test")?.threadId, "thread-existing");
  assert.deepEqual(goals, ["完成渠道交互", "完成渠道交互"]);
  assert.deepEqual(replies, ["正常回复 1", "正常回复 2", "正常回复 3"]);
});

test("Bridge renders approval decisions as buttons on interactive channels", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-approval-card-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Approval", root);
  stateStore.createSession("oc_test", project.workspace, "审批交互", project.id);
  const cards: ChannelActionCard[] = [];
  let resolveApproval: ((decision: "accept" | "decline") => void) | undefined;
  const approvalDecision = new Promise<"accept" | "decline">((resolve) => {
    resolveApproval = resolve;
  });
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["oc_test"] },
    stateStore,
    weixin: {
      async sendText() { return { messageId: "text" }; },
      async sendActionCard(input: { card: ChannelActionCard }) {
        cards.push(input.card);
        return { messageId: `card-${cards.length}` };
      }
    },
    runner: {
      async run(input: { onApproval?: (request: Record<string, unknown>) => Promise<"accept" | "decline"> }) {
        const decision = await input.onApproval?.({
          kind: "command",
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          command: "npm test",
          cwd: root,
          reason: "运行验证"
        });
        resolveApproval?.(decision ?? "decline");
        return { raw: "", text: "完成", threadId: "thread" };
      },
      async stop() {}
    } as never
  });

  const running = service.handleMessage({ id: "turn", senderId: "oc_test", text: "运行测试", raw: {} });
  for (let attempt = 0; attempt < 20 && cards.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(cards[0].actionGroups.flatMap((group) => group.map((action) => action.label)), ["批准", "拒绝"]);
  assert.deepEqual(cards[0].actionGroups.flatMap((group) => group.map((action) => action.value)), [
    { version: 1, command: "approve", arg: "A1" },
    { version: 1, command: "reject", arg: "A1" }
  ]);

  await service.handleMessage({ id: "approve", senderId: "oc_test", text: "/approve A1", raw: {} });
  assert.equal(await approvalDecision, "accept");
  await running;
});
