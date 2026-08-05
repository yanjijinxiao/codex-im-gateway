import type { TaskboardIssue } from "../taskboard/client.js";
import {
  cleanTaskCardText,
  taskboardDeepLink,
  taskCommandAction,
  taskFormAction,
  taskLinkAction
} from "./task-card-actions.js";
import {
  formatTaskboardPriority,
  formatTaskboardStatus,
  formatTaskboardTime,
  taskboardStatusTemplate
} from "./task-card-status.js";
import type { ChannelTaskAction, ChannelTaskDetailCard } from "./task-card.js";

type CreateTaskCardOptions = {
  readonly latestComment?: string;
  readonly title?: string;
  readonly note?: string;
  readonly template?: ChannelTaskDetailCard["template"];
  readonly taskboardBaseUrl?: string;
  readonly backArg?: string;
};

export function createTaskCard(
  projectName: string,
  issue: TaskboardIssue,
  options: CreateTaskCardOptions = {}
): ChannelTaskDetailCard {
  const statusLabel = formatTaskboardStatus(issue.status);
  const latestComment = cleanTaskCardText(options.latestComment, 500);
  const description = cleanTaskCardText(issue.description, 500);
  const note = cleanTaskCardText(options.note, 300);
  const actions = taskActions(issue, options.taskboardBaseUrl, options.backArg);
  const fallbackText = [
    `【${options.title ?? `Taskboard · ${statusLabel}`}】`,
    `项目：${projectName}`,
    `Issue：${issue.identifier} · ${issue.title}`,
    ...(description ? [`说明：${description}`] : []),
    ...(latestComment ? [`最新记录：${latestComment}`] : []),
    ...(note ? [note] : []),
    ...(actions.length ? [`可用操作：${actions.map((action) => action.label).join("、")}`] : [])
  ].join("\n");
  return {
    kind: "detail",
    title: options.title ?? `${issue.identifier} · ${statusLabel}`,
    template: options.template ?? taskboardStatusTemplate(issue.status),
    projectName,
    identifier: issue.identifier,
    statusLabel,
    summary: issue.title,
    priorityLabel: formatTaskboardPriority(issue.priority),
    labels: issue.labels,
    updatedLabel: formatTaskboardTime(issue.updatedAt),
    ...(description ? { description } : {}),
    ...(latestComment ? { latestComment } : {}),
    ...(note ? { note } : {}),
    actions,
    fallbackText,
    ...(options.taskboardBaseUrl ? {
      taskboardUrl: taskboardDeepLink(options.taskboardBaseUrl, issue.projectId, issue.identifier)
    } : {})
  };
}

function taskActions(
  issue: TaskboardIssue,
  taskboardBaseUrl?: string,
  backArg = "list"
): readonly ChannelTaskAction[] {
  const back = taskCommandAction({ label: "返回任务", arg: backArg });
  const progress = taskCommandAction({ label: "添加进展", arg: `form comment ${issue.identifier}` });
  const open = taskboardBaseUrl
    ? taskLinkAction("打开完整面板", taskboardDeepLink(taskboardBaseUrl, issue.projectId, issue.identifier))
    : undefined;
  const transition = (input: {
    readonly operation: "start" | "accept";
    readonly label: string;
    readonly style?: "default" | "primary";
    readonly confirm?: string;
  }) => (
    taskFormAction({
      label: input.label,
      style: input.style,
      parameters: { operation: input.operation, identifier: issue.identifier, version: String(issue.version) },
      ...(input.confirm ? { confirm: input.confirm } : {})
    })
  );
  let contextual: readonly ChannelTaskAction[];
  switch (issue.status) {
    case "todo":
      contextual = [transition({ operation: "start", label: "开始处理", style: "primary" })];
      break;
    case "in_progress":
      contextual = [
        progress,
        taskCommandAction({ label: "标记阻塞", arg: `form block ${issue.identifier}`, style: "danger" }),
        taskCommandAction({ label: "提交验收", arg: `form review ${issue.identifier}`, style: "primary" })
      ];
      break;
    case "blocked":
      contextual = [progress, transition({ operation: "start", label: "继续处理", style: "primary" })];
      break;
    case "in_review":
      contextual = [
        progress,
        transition({
          operation: "accept",
          label: "通过",
          style: "primary",
          confirm: "确认该 Issue 已满足验收门禁？"
        }),
        taskCommandAction({ label: "退回", arg: `form return ${issue.identifier}`, style: "danger" })
      ];
      break;
    case "backlog":
    case "done":
    case "canceled":
      contextual = [];
      break;
    default:
      contextual = assertNever(issue.status);
  }
  return [...contextual, back, ...(open ? [open] : [])];
}

function assertNever(value: never): never {
  throw new UnexpectedTaskStatusError(value);
}

class UnexpectedTaskStatusError extends Error {
  readonly name = "UnexpectedTaskStatusError";
  constructor(readonly value: never) {
    super("Task status was not handled exhaustively");
  }
}
