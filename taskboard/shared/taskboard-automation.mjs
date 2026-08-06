import path from "node:path";
import { isSupportedModelEffort } from "./taskboard-automation-options.mjs";

const AUTOMATION_OPERATIONS = new Set(["ensure-active", "pause", "list", "apply-policy"]);
const INTERVAL_MINUTES = new Set([5, 10, 15, 30, 60]);
const HOST_REQUEST_FIELDS = new Set([
  "id",
  "action",
  "requestId",
  "operation",
  "taskboardProjectId",
  "codexProjectId",
  "projectName",
  "workspacePath",
  "skillPath",
  "automationId",
  "enabledByUser",
  "quotaAware",
  "intervalMinutes",
  "model",
  "reasoningEffort",
]);

export function parseTaskboardAutomationHostRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => !HOST_REQUEST_FIELDS.has(field))) return null;
  if (value.action !== "automation") return null;
  if (!validIdentifier(value.id, 80) || !validIdentifier(value.requestId, 100)) return null;
  if (!AUTOMATION_OPERATIONS.has(value.operation)) return null;
  if (!validProjectId(value.taskboardProjectId)) return null;
  if (!validText(value.codexProjectId, 256) || !validText(value.projectName, 200)) return null;
  if (!validAbsolutePath(value.workspacePath) || !validAbsolutePath(value.skillPath)) return null;
  if (value.intervalMinutes !== undefined && !INTERVAL_MINUTES.has(value.intervalMinutes)) return null;
  if (!isSupportedModelEffort(value.model, value.reasoningEffort)) return null;
  if (value.automationId !== undefined && !validText(value.automationId, 256)) return null;
  if (typeof value.enabledByUser !== "boolean" || typeof value.quotaAware !== "boolean") return null;

  return {
    id: value.id,
    action: "automation",
    requestId: value.requestId,
    operation: value.operation,
    taskboardProjectId: value.taskboardProjectId,
    codexProjectId: value.codexProjectId,
    projectName: value.projectName,
    workspacePath: value.workspacePath,
    skillPath: value.skillPath,
    ...(value.automationId === undefined ? {} : { automationId: value.automationId }),
    enabledByUser: value.enabledByUser,
    quotaAware: value.quotaAware,
    ...(value.intervalMinutes === undefined ? {} : { intervalMinutes: value.intervalMinutes }),
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  };
}

export function parseStoredTaskboardAutomationPolicy(value) {
  return parseTaskboardAutomationHostRequest({
    ...value,
    id: "stored-policy",
    action: "automation",
    requestId: "stored-policy",
    operation: "apply-policy",
  });
}

export function buildTaskboardAutomationName(request) {
  return `Taskboard 自动认领 · ${request.taskboardProjectId}`;
}

export function buildTaskboardAutomationPrompt(request) {
  return [
    `[$manage-taskboard](${request.skillPath}) e-taskboard 处理任务面板中的「${request.projectName}」项目（项目 ID：${request.taskboardProjectId}，项目目录：${request.workspacePath}）。`,
    "这是由新建议题事件启动的一次队列执行，不要创建、恢复或等待任何定时任务。",
    "循环处理 todo 队列，直到没有 todo 后立即退出：每次先用 issue list 获取一个 todo，再用 issue get 读取最新议题内容，并用 comment list 读取全部评论，确认是否包含已完成后被打回的返工要求。",
    "认领时使用最新 version 将议题移动到 in_progress；若发生版本冲突或最新状态已变化，跳过该议题并继续检查下一个，避免多个 Agent 抢同一任务。",
    "若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。",
    "执行完成并验证后，先用 comment add 记录关键改动、验证结果、执行结果和剩余风险，再使用最新 version 将议题移动到 in_review；不要直接标记为 done。",
    "完成一个议题后继续领取下一个 todo；只有 todo 队列为空时才结束本次执行。",
  ].join("\n");
}

// Kept only to provide the complete payload required when pausing a legacy Cron.
export function buildTaskboardAutomationSpec(request) {
  return {
    kind: "cron",
    name: buildTaskboardAutomationName(request),
    prompt: buildTaskboardAutomationPrompt(request),
    projectId: request.codexProjectId,
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${request.intervalMinutes ?? 5}`,
  };
}

export async function reconcileTaskboardAutomation(request, rpc) {
  const listed = await rpc("list-automations", {});
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const name = buildTaskboardAutomationName(request);
  const matchingItems = items.filter((item) => item?.name === name);

  if (request.operation === "list") {
    return { items: matchingItems.map(sanitizeAutomation).filter(Boolean) };
  }

  const existing = (
    request.automationId
      ? matchingItems.find((item) => item?.id === request.automationId)
      : null
  ) ?? matchingItems[0];
  if (!existing) return { error: "not-found" };
  if (existing.status === "PAUSED") return { item: existing };

  return rpc("automation-update", {
    ...buildTaskboardAutomationSpec(request),
    id: existing.id,
    status: "PAUSED",
  });
}

export async function pauseLegacyTaskboardAutomations(rpc) {
  const listed = await rpc("list-automations", {});
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const results = [];
  for (const item of items) {
    const spec = legacyAutomationSpec(item);
    if (!spec) continue;
    if (item.status === "PAUSED") {
      results.push(item);
      continue;
    }
    const updated = await rpc("automation-update", {
      ...spec,
      id: item.id,
      status: "PAUSED",
    });
    if (updated?.item) results.push(updated.item);
  }
  return { items: results.map(sanitizeAutomation).filter(Boolean) };
}

function legacyAutomationSpec(item) {
  const projectId = item?.projectId ?? item?.target?.projectId;
  if (
    !validText(item?.id, 256)
    || item.kind !== "cron"
    || typeof item.name !== "string"
    || !item.name.startsWith("Taskboard 自动认领 · ")
    || typeof item.prompt !== "string"
    || item.prompt.length === 0
    || item.prompt.length > 100_000
    || !validText(projectId, 256)
    || item.executionEnvironment !== "local"
    || (item.localEnvironmentConfigPath !== null && item.localEnvironmentConfigPath !== undefined)
    || !isSupportedModelEffort(item.model, item.reasoningEffort)
    || !validRrule(item.rrule)
    || (item.status !== "ACTIVE" && item.status !== "PAUSED")
  ) return null;
  return {
    kind: "cron",
    name: item.name,
    prompt: item.prompt,
    projectId,
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    rrule: item.rrule,
  };
}

function sanitizeAutomation(item) {
  if (
    !validText(item?.id, 256)
    || (item.status !== "ACTIVE" && item.status !== "PAUSED")
    || !isSupportedModelEffort(item.model, item.reasoningEffort)
    || !validRrule(item.rrule)
  ) return null;
  return {
    id: item.id,
    status: item.status,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    rrule: item.rrule,
  };
}

function validRrule(value) {
  return typeof value === "string"
    && /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.test(value);
}

function validIdentifier(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[a-z0-9-]+$/i.test(value);
}

function validProjectId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-z0-9._-]+$/i.test(value);
}

function validText(value, maxLength) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validAbsolutePath(value) {
  return validText(value, 2_048) && path.isAbsolute(value);
}
