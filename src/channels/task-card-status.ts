import type { TaskboardStatus } from "../taskboard/client.js";

export function formatTaskboardStatus(status: TaskboardStatus): string {
  return STATUS_LABELS[status];
}

export function taskboardStatusTemplate(status: TaskboardStatus): "blue" | "green" | "orange" | "red" | "grey" {
  return STATUS_TEMPLATES[status];
}

export function formatTaskboardPriority(priority: string): string {
  return PRIORITY_LABELS[priority] ?? priority;
}

export function formatTaskboardTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

const STATUS_TEMPLATES = {
  backlog: "grey",
  todo: "blue",
  in_progress: "blue",
  in_review: "orange",
  blocked: "red",
  done: "green",
  canceled: "grey"
} as const satisfies Readonly<Record<TaskboardStatus, "blue" | "green" | "orange" | "red" | "grey">>;

const PRIORITY_LABELS: Readonly<Record<string, string>> = {
  none: "未设置",
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急"
};
