import type { TaskboardIssue, TaskboardStatus } from "../taskboard/client.js";
import {
  formatChannelActionCommand,
  parseChannelActionValue,
  type ChannelCardAction,
  type ChannelCardTemplate
} from "./action-card.js";

export { formatChannelActionCommand, parseChannelActionValue } from "./action-card.js";
export type { ChannelActionValue, ChannelCardAction } from "./action-card.js";

export type ChannelTaskCard = {
  readonly title: string;
  readonly template: ChannelCardTemplate;
  readonly projectName: string;
  readonly identifier: string;
  readonly statusLabel: string;
  readonly summary: string;
  readonly description?: string;
  readonly latestComment?: string;
  readonly note?: string;
  readonly actions: readonly ChannelCardAction[];
  readonly fallbackText: string;
};

type CreateTaskCardOptions = {
  readonly latestComment?: string;
  readonly title?: string;
  readonly note?: string;
  readonly template?: ChannelTaskCard["template"];
};

export function createTaskCard(
  projectName: string,
  issue: TaskboardIssue,
  options: CreateTaskCardOptions = {}
): ChannelTaskCard {
  const statusLabel = formatTaskboardStatus(issue.status);
  const latestComment = clean(options.latestComment, 500);
  const description = clean(issue.description, 500);
  const note = clean(options.note, 300);
  const actions = taskActions(issue);
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
    title: options.title ?? `${issue.identifier} · ${statusLabel}`,
    template: options.template ?? templateForStatus(issue.status),
    projectName,
    identifier: issue.identifier,
    statusLabel,
    summary: issue.title,
    ...(description ? { description } : {}),
    ...(latestComment ? { latestComment } : {}),
    ...(note ? { note } : {}),
    actions,
    fallbackText
  };
}

export function formatTaskboardStatus(status: TaskboardStatus): string {
  return STATUS_LABELS[status];
}

function taskActions(issue: TaskboardIssue): readonly ChannelCardAction[] {
  const detail = action("查看详情", "detail", issue.identifier);
  switch (issue.status) {
    case "todo":
      return [detail, action("开始处理", "start", issue.identifier, "primary")];
    case "in_progress":
      return [detail, action("提交验收", "review", issue.identifier, "primary")];
    case "blocked":
      return [detail, action("继续处理", "start", issue.identifier, "primary")];
    case "in_review":
      return [
        detail,
        action("通过", "accept", issue.identifier, "primary", "确认该 Issue 已满足验收门禁？"),
        action("退回", "return", issue.identifier, "danger")
      ];
    case "backlog":
    case "done":
    case "canceled":
      return [detail];
    default:
      return assertNever(issue.status);
  }
}

function action(
  label: string,
  taskAction: string,
  identifier: string,
  style: ChannelCardAction["style"] = "default",
  confirm?: string
): ChannelCardAction {
  return {
    label,
    style,
    value: { version: 1, command: "task", arg: `${taskAction} ${identifier}` },
    ...(confirm ? { confirm } : {})
  };
}

function templateForStatus(status: TaskboardStatus): ChannelTaskCard["template"] {
  return ({
    backlog: "grey",
    todo: "blue",
    in_progress: "blue",
    in_review: "orange",
    blocked: "red",
    done: "green",
    canceled: "grey"
  } as const)[status];
}

function clean(value: string | undefined, maximumLength: number): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Taskboard status: ${String(value)}`);
}

const STATUS_LABELS = {
  backlog: "待规划",
  todo: "待处理",
  in_progress: "处理中",
  in_review: "待验收",
  blocked: "阻塞",
  done: "已完成",
  canceled: "已取消"
} as const satisfies Readonly<Record<TaskboardStatus, string>>;
