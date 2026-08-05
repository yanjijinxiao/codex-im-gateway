import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import { feishuTaskCard } from "../src/channels/feishu-task-card.js";
import { createTaskCard, createTaskFormCard, formatChannelActionCommand } from "../src/channels/task-card.js";
import type { NormalizedWeixinMessage } from "../src/weixin/messages.js";

const interactionSchema = z.object({
  kind: z.literal("card"),
  messageId: z.string()
});

function account() {
  return {
    channel: "feishu" as const,
    accountId: "feishu-test",
    appId: "cli_test",
    appSecret: "secret",
    savedAt: "2026-08-05T00:00:00.000Z",
    enabled: true
  };
}

function taskCard() {
  return createTaskCard("Project One", {
    id: "task-one",
    identifier: "PROJECT-1",
    projectId: "project-one",
    title: "完善飞书任务卡",
    description: "使用原生交互",
    status: "in_progress",
    priority: "high",
    labels: ["feishu"],
    threadId: "thread-one",
    version: 3,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T01:00:00.000Z"
  });
}

test("turns a Feishu form callback into one canonical Taskboard command", async () => {
  let dispatcher: { handles: Map<string, (event: unknown) => unknown> } | undefined;
  const inbound: NormalizedWeixinMessage[] = [];
  const adapter = new FeishuChannelAdapter(account(), {
    apiClient: {
      im: { v1: {
        image: { async create() { return { image_key: "unused" }; } },
        message: { async create() { return { data: { message_id: "unused" } }; } },
        messageResource: { async get() { throw new Error("not used"); } }
      } }
    },
    wsClient: {
      async start(input) { dispatcher = input.eventDispatcher; },
      close() {}
    }
  });
  const controller = new AbortController();
  const monitor = adapter.monitor({
    signal: controller.signal,
    async onMessage(message) { inbound.push(message); }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(dispatcher);

  await dispatcher.handles.get("card.action.trigger")?.({
    token: "form-token",
    context: { open_message_id: "om_task_card", open_chat_id: "oc_test" },
    operator: { open_id: "ou_operator" },
    action: {
      tag: "button",
      name: "submit_block",
      value: {
        version: 2,
        command: "task",
        arg: "submit",
        parameters: {
          operation: "block",
          identifier: "PROJECT-1",
          version: "3",
          request_id: "00000000-0000-4000-8000-000000000001"
        },
        fields: [{ name: "reason", parameter: "body", required: true, maximumLength: 1_000 }]
      },
      form_value: { reason: "等待接口权限" }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await monitor;

  assert.equal(inbound.length, 1);
  const [prefix, command, encoded] = inbound[0].text.split(" ");
  assert.equal(`${prefix} ${command}`, "/task submit");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(encoded)), {
    operation: "block",
    identifier: "PROJECT-1",
    version: "3",
    request_id: "00000000-0000-4000-8000-000000000001",
    body: "等待接口权限"
  });
  assert.deepEqual(interactionSchema.parse("interaction" in inbound[0] ? inbound[0].interaction : undefined), {
    kind: "card",
    messageId: "om_task_card"
  });
});

test("patches an existing Feishu task card instead of creating another message", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const messageApi = {
    async create() { return { data: { message_id: "unused" } }; },
    async patch(input: Record<string, unknown>) { patches.push(input); return { data: {} }; }
  };
  const adapter = new FeishuChannelAdapter(account(), {
    apiClient: {
      im: { v1: {
        image: { async create() { return { image_key: "unused" }; } },
        message: messageApi,
        messageResource: { async get() { throw new Error("not used"); } }
      } }
    },
    wsClient: { async start() {}, close() {} }
  });
  const updateTaskCard = Reflect.get(adapter, "updateTaskCard");

  assert.equal(typeof updateTaskCard, "function");
  if (typeof updateTaskCard !== "function") return;
  await updateTaskCard.call(adapter, { messageId: "om_task_card", card: taskCard() });

  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0]?.path, { message_id: "om_task_card" });
  const data = z.object({ content: z.string() }).parse(patches[0]?.data);
  assert.equal(JSON.parse(data.content).header.title.content, "PROJECT-1 · 处理中");
});

test("renders required Taskboard inputs as a native Feishu form", () => {
  const detail = taskCard();
  const issue = {
    id: "task-one",
    identifier: detail.identifier,
    projectId: "project-one",
    title: detail.summary,
    description: detail.description ?? "",
    status: "in_progress" as const,
    priority: "high",
    labels: ["feishu"],
    threadId: "thread-one",
    version: 3,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T01:00:00.000Z"
  };
  const card = createTaskFormCard({
    form: "block",
    issue,
    projectName: "Project One",
    projectId: "project-one",
    taskboardBaseUrl: "http://127.0.0.1:47823"
  });
  const payload = feishuTaskCard(card);
  const form = payload.elements.find((element) => element.tag === "form");

  assert.equal(form?.tag, "form");
  if (!form || form.tag !== "form") return;
  assert.equal(form.elements[0]?.tag, "input");
  assert.equal(form.elements[1]?.tag, "button");
  assert.equal(form.elements[1]?.action_type, "form_submit");
  assert.equal(formatChannelActionCommand(card.submitActions[0].value, {}), undefined);
  assert.match(formatChannelActionCommand(card.submitActions[0].value, { body: "等待权限" }) ?? "", /^\/task submit /);
});
