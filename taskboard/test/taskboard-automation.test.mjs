import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTaskboardAutomationName,
  buildTaskboardAutomationPrompt,
  buildTaskboardAutomationSpec,
  pauseLegacyTaskboardAutomations,
  parseStoredTaskboardAutomationPolicy,
  parseTaskboardAutomationHostRequest,
  reconcileTaskboardAutomation,
} from "../shared/taskboard-automation.mjs";
import {
  AUTOMATION_MODELS,
  isSupportedModelEffort,
  withAutomationModel,
} from "../shared/taskboard-automation-options.mjs";

const baseRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "iframe-request-1",
  operation: "apply-policy",
  taskboardProjectId: "ppt-skill",
  codexProjectId: "codex-project-123",
  projectName: "PPT Skill",
  workspacePath: "/Users/example/Documents/ppt-skill",
  skillPath: "/Users/example/taskboard/skills/manage-taskboard/SKILL.md",
  enabledByUser: true,
  quotaAware: false,
  model: "gpt-5.5",
  reasoningEffort: "high",
};

test("the automation model catalog matches Codex and normalizes unsupported efforts", () => {
  assert.equal(AUTOMATION_MODELS[0].slug, "gpt-5.6-sol");
  assert.equal(AUTOMATION_MODELS.at(-1).slug, "gpt-5.4-mini");
  const current = {
    status: "ACTIVE",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  };
  assert.deepEqual(withAutomationModel(current, "gpt-5.6-luna"), {
    ...current,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  });
  assert.equal(isSupportedModelEffort("gpt-5.6-luna", "max"), true);
  assert.equal(isSupportedModelEffort("gpt-5.6-luna", "ultra"), false);
});

test("the host request accepts event policies and migrates legacy interval fields", () => {
  assert.deepEqual(parseTaskboardAutomationHostRequest(baseRequest), baseRequest);
  assert.deepEqual(
    parseStoredTaskboardAutomationPolicy({
      ...baseRequest,
      id: undefined,
      action: undefined,
      requestId: undefined,
      operation: undefined,
      automationId: "legacy-cron",
      intervalMinutes: 10,
    })?.intervalMinutes,
    10,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, intervalMinutes: 7 }),
    null,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, workspacePath: "relative/path" }),
    null,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, prompt: "arbitrary" }),
    null,
  );
});

test("the generated prompt drains todo issues and exits without scheduling", () => {
  assert.equal(buildTaskboardAutomationName(baseRequest), "Taskboard 自动认领 · ppt-skill");
  const prompt = buildTaskboardAutomationPrompt(baseRequest);
  assert.match(prompt, /新建议题事件启动/);
  assert.match(prompt, /不要创建、恢复或等待任何定时任务/);
  assert.match(prompt, /循环处理 todo 队列/);
  assert.match(prompt, /issue list/);
  assert.match(prompt, /issue get/);
  assert.match(prompt, /comment list/);
  assert.match(prompt, /in_progress/);
  assert.match(prompt, /in_review/);
  assert.match(prompt, /todo 队列为空时才结束/);
  assert.doesNotMatch(prompt, /每 \d+ 分钟/);
});

test("legacy reconciliation can only pause an existing Cron and never creates one", async () => {
  const legacy = {
    id: "legacy-cron",
    status: "ACTIVE",
    ...buildTaskboardAutomationSpec({ ...baseRequest, intervalMinutes: 10 }),
  };
  const calls = [];
  const result = await reconcileTaskboardAutomation(
    { ...baseRequest, automationId: legacy.id, intervalMinutes: 10 },
    async (method, params) => {
      calls.push({ method, params });
      if (method === "list-automations") return { items: [legacy] };
      return { item: params };
    },
  );
  assert.deepEqual(calls.map((call) => call.method), ["list-automations", "automation-update"]);
  assert.equal(calls[1].params.status, "PAUSED");
  assert.equal(result.item.status, "PAUSED");

  const missingCalls = [];
  const missing = await reconcileTaskboardAutomation(baseRequest, async (method) => {
    missingCalls.push(method);
    return { items: [] };
  });
  assert.deepEqual(missingCalls, ["list-automations"]);
  assert.deepEqual(missing, { error: "not-found" });
});

test("an already paused legacy Cron stays paused and list output is sanitized", async () => {
  const legacy = {
    id: "legacy-cron",
    status: "PAUSED",
    ...buildTaskboardAutomationSpec(baseRequest),
    untrusted: "not returned by list",
  };
  const paused = await reconcileTaskboardAutomation(baseRequest, async () => ({ items: [legacy] }));
  assert.equal(paused.item, legacy);

  const listed = await reconcileTaskboardAutomation(
    { ...baseRequest, operation: "list" },
    async () => ({ items: [legacy] }),
  );
  assert.deepEqual(listed, {
    items: [{
      id: "legacy-cron",
      status: "PAUSED",
      model: "gpt-5.5",
      reasoningEffort: "high",
      rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
    }],
  });
});

test("injector startup pauses every active legacy Taskboard Cron without a policy record", async () => {
  const legacy = {
    id: "orphaned-cron",
    status: "ACTIVE",
    ...buildTaskboardAutomationSpec(baseRequest),
  };
  const calls = [];
  const result = await pauseLegacyTaskboardAutomations(async (method, params) => {
    calls.push({ method, params });
    if (method === "list-automations") return { items: [legacy] };
    return { item: params };
  });
  assert.deepEqual(calls.map((call) => call.method), ["list-automations", "automation-update"]);
  assert.equal(calls[1].params.status, "PAUSED");
  assert.equal(result.items[0].status, "PAUSED");
});
