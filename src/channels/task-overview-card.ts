import type { TaskboardIssue } from "../taskboard/client.js";
import { taskboardDeepLink, taskCommandAction, taskLinkAction } from "./task-card-actions.js";
import {
  formatTaskboardPriority,
  formatTaskboardStatus,
  formatTaskboardTime
} from "./task-card-status.js";
import type {
  ChannelTaskOverviewCard,
  TaskboardOverviewFilter
} from "./task-card.js";

type CreateTaskOverviewCardInput = {
  readonly projectName: string;
  readonly projectId: string;
  readonly issues: readonly TaskboardIssue[];
  readonly taskboardBaseUrl: string;
  readonly filter?: TaskboardOverviewFilter;
  readonly page?: number;
  readonly pageSize?: number;
};

export function createTaskOverviewCard(input: CreateTaskOverviewCardInput): ChannelTaskOverviewCard {
  const filter = input.filter ?? "active";
  const pageSize = input.pageSize ?? 5;
  const filtered = input.issues.filter((issue) => matchesFilter(issue, filter));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(input.page ?? 1, 1), pageCount);
  const items = filtered.slice((page - 1) * pageSize, page * pageSize).map((issue) => ({
    identifier: issue.identifier,
    title: issue.title,
    statusLabel: formatTaskboardStatus(issue.status),
    priorityLabel: formatTaskboardPriority(issue.priority),
    updatedLabel: formatTaskboardTime(issue.updatedAt),
    action: taskCommandAction({ label: "查看", arg: `detail ${issue.identifier}` })
  }));
  const listArg = (nextFilter: TaskboardOverviewFilter, nextPage = 1) => (
    `list ${new URLSearchParams({ status: nextFilter, page: String(nextPage) })}`
  );
  const counts = {
    todo: input.issues.filter((issue) => issue.status === "todo").length,
    in_progress: input.issues.filter((issue) => issue.status === "in_progress").length,
    in_review: input.issues.filter((issue) => issue.status === "in_review").length,
    blocked: input.issues.filter((issue) => issue.status === "blocked").length
  };
  const filterActions = FILTERS.map((option) => taskCommandAction({
    label: `${option.label}${option.filter === filter ? " · 当前" : ""}`,
    arg: listArg(option.filter),
    style: option.filter === filter ? "primary" : "default"
  }));
  const pageActions = [
    ...(page > 1 ? [taskCommandAction({ label: "上一页", arg: listArg(filter, page - 1) })] : []),
    ...(page < pageCount ? [taskCommandAction({ label: "下一页", arg: listArg(filter, page + 1) })] : [])
  ];
  const taskboardUrl = taskboardDeepLink(input.taskboardBaseUrl, input.projectId);
  const fallbackText = [
    `【Taskboard · ${input.projectName}】`,
    `筛选：${filterLabel(filter)} · 第 ${page}/${pageCount} 页 · ${filtered.length} 项`,
    ...(items.length
      ? items.map((item) => `${item.identifier} · ${item.statusLabel} · ${item.title}`)
      : ["当前筛选下没有任务。"]),
    `完整面板：${taskboardUrl}`
  ].join("\n");
  return {
    kind: "overview",
    title: `任务面板 · ${input.projectName}`,
    template: "blue",
    projectName: input.projectName,
    identifier: `overview:${input.projectId}`,
    filter,
    filterLabel: filterLabel(filter),
    counts,
    items,
    page,
    pageCount,
    total: filtered.length,
    filterActions,
    pageActions,
    actions: [
      taskCommandAction({ label: "新建任务", arg: "form new", style: "primary" }),
      taskCommandAction({ label: "刷新", arg: listArg(filter, page) }),
      taskLinkAction("打开完整面板", taskboardUrl)
    ],
    fallbackText,
    taskboardUrl
  };
}

function matchesFilter(issue: TaskboardIssue, filter: TaskboardOverviewFilter): boolean {
  return filter === "active" ? issue.status !== "done" && issue.status !== "canceled" : issue.status === filter;
}

function filterLabel(filter: TaskboardOverviewFilter): string {
  return filter === "active" ? "未完成" : formatTaskboardStatus(filter);
}

const FILTERS = [
  { filter: "active", label: "未完成" },
  { filter: "todo", label: "待处理" },
  { filter: "in_progress", label: "处理中" },
  { filter: "in_review", label: "待验收" },
  { filter: "blocked", label: "阻塞" }
] as const satisfies readonly { readonly filter: TaskboardOverviewFilter; readonly label: string }[];
