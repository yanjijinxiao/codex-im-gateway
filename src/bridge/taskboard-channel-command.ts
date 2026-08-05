import { z } from "zod";

import type { TaskboardOverviewFilter } from "../channels/task-card.js";

const overviewFilterSchema = z.enum([
  "active", "backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"
]);

const createSubmissionFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1_000).default(""),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).default("none"),
  labels: z.string().trim().max(500).default(""),
  request_id: z.string().uuid().optional()
} as const;

const evidenceSubmissionFields = {
  identifier: z.string().trim().min(1).max(100),
  version: z.coerce.number().int().nonnegative(),
  body: z.string().trim().min(1).max(1_000),
  request_id: z.string().uuid().optional()
} as const;

const transitionSubmissionFields = {
  identifier: z.string().trim().min(1).max(100),
  version: z.coerce.number().int().nonnegative(),
  request_id: z.string().uuid().optional()
} as const;

const taskboardSubmissionSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create_todo"), ...createSubmissionFields }).strict(),
  z.object({ operation: z.literal("create_start"), ...createSubmissionFields }).strict(),
  z.object({ operation: z.literal("comment"), ...evidenceSubmissionFields }).strict(),
  z.object({ operation: z.literal("block"), ...evidenceSubmissionFields }).strict(),
  z.object({ operation: z.literal("review"), ...evidenceSubmissionFields }).strict(),
  z.object({ operation: z.literal("return"), ...evidenceSubmissionFields }).strict(),
  z.object({ operation: z.literal("start"), ...transitionSubmissionFields }).strict(),
  z.object({ operation: z.literal("accept"), ...transitionSubmissionFields }).strict()
]);

export type TaskboardSubmission = z.infer<typeof taskboardSubmissionSchema>;

export type TaskboardChannelCommand =
  | { readonly kind: "list"; readonly filter: TaskboardOverviewFilter; readonly page: number }
  | {
    readonly kind: "form";
    readonly form: "new" | "todo" | "comment" | "block" | "review" | "return";
    readonly identifier?: string;
    readonly prefill?: string;
  }
  | { readonly kind: "submit"; readonly submission: TaskboardSubmission }
  | { readonly kind: "legacy"; readonly input: string }
  | { readonly kind: "invalid"; readonly message: string };

export function parseTaskboardChannelCommand(raw: string): TaskboardChannelCommand {
  const input = raw.trim();
  if (!input) return { kind: "list", filter: "active", page: 1 };
  const [rawAction, ...parts] = input.split(/\s+/);
  const action = rawAction.toLowerCase();
  if (action === "list") return parseList(parts.join(" "));
  if (action === "form") return parseForm(parts);
  if (action === "submit") return parseSubmission(parts.join(" "));
  return { kind: "legacy", input };
}

function parseList(rawQuery: string): TaskboardChannelCommand {
  if (!rawQuery) return { kind: "list", filter: "active", page: 1 };
  const query = new URLSearchParams(rawQuery);
  const parsed = z.object({
    status: overviewFilterSchema.default("active"),
    page: z.coerce.number().int().positive().default(1)
  }).strict().safeParse(Object.fromEntries(query));
  return parsed.success
    ? { kind: "list", filter: parsed.data.status, page: parsed.data.page }
    : { kind: "invalid", message: "任务筛选参数无效，请刷新任务面板。" };
}

function parseForm(parts: readonly string[]): TaskboardChannelCommand {
  const [rawForm, rawIdentifier, ...rest] = parts;
  const form = z.enum(["new", "todo", "comment", "block", "review", "return"]).safeParse(rawForm);
  if (!form.success) return { kind: "invalid", message: "不支持的任务表单。" };
  if (form.data === "new" || form.data === "todo") {
    const prefill = [rawIdentifier, ...rest].filter(Boolean).join(" ").trim();
    return { kind: "form", form: form.data, ...(prefill ? { prefill } : {}) };
  }
  if (!rawIdentifier) return { kind: "invalid", message: "请先选择要操作的任务。" };
  const prefill = rest.join(" ").trim();
  return {
    kind: "form",
    form: form.data,
    identifier: rawIdentifier,
    ...(prefill ? { prefill } : {})
  };
}

function parseSubmission(rawQuery: string): TaskboardChannelCommand {
  const parsed = taskboardSubmissionSchema.safeParse(Object.fromEntries(new URLSearchParams(rawQuery)));
  return parsed.success
    ? { kind: "submit", submission: parsed.data }
    : { kind: "invalid", message: "任务表单内容无效或已过期，请刷新后重试。" };
}
