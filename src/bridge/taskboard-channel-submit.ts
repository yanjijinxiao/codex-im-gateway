import type { TaskboardClient, TaskboardIssue, TaskboardStatus } from "../taskboard/client.js";
import { isTaskboardTransitionAllowed } from "../taskboard/workflow.js";
import type { TaskboardSubmission } from "./taskboard-channel-command.js";

type ExecuteTaskboardSubmissionInput = {
  readonly client: TaskboardClient;
  readonly projectId: string;
  readonly submission: TaskboardSubmission;
};

type CreateSubmission = Extract<TaskboardSubmission, { readonly operation: "create_todo" | "create_start" }>;
type UpdateSubmission = Exclude<TaskboardSubmission, CreateSubmission>;

export type TaskboardSubmissionResult =
  | { readonly kind: "issue"; readonly issue: TaskboardIssue; readonly latestComment?: string; readonly note?: string }
  | { readonly kind: "workflow"; readonly issue: TaskboardIssue; readonly instruction: string }
  | { readonly kind: "conflict"; readonly issue: TaskboardIssue }
  | { readonly kind: "invalid"; readonly issue?: TaskboardIssue; readonly message: string };

export async function executeTaskboardSubmission(
  input: ExecuteTaskboardSubmissionInput
): Promise<TaskboardSubmissionResult> {
  const submission = input.submission;
  switch (submission.operation) {
    case "create_todo":
    case "create_start":
      return createIssue({ ...input, submission });
    case "comment":
    case "block":
    case "review":
    case "return":
    case "start":
    case "accept":
      return updateIssue({ ...input, submission });
    default:
      return assertNever(submission);
  }
}

async function createIssue(
  input: Omit<ExecuteTaskboardSubmissionInput, "submission"> & { readonly submission: CreateSubmission }
): Promise<TaskboardSubmissionResult> {
  const submission = input.submission;
  const issue = await input.client.createIssue({
    projectId: input.projectId,
    title: submission.title,
    description: submission.description,
    status: "todo",
    priority: submission.priority,
    labels: submission.labels.split(/[,，]/).map((label) => label.trim()).filter(Boolean)
  });
  return submission.operation === "create_todo"
    ? { kind: "issue", issue, note: "已记入待办，尚未开始处理。" }
    : {
      kind: "workflow",
      issue,
      instruction: `领取并开始处理刚创建的 ${issue.identifier}；将当前 Codex thread 绑定到该 Issue。`
    };
}

async function updateIssue(
  input: Omit<ExecuteTaskboardSubmissionInput, "submission"> & { readonly submission: UpdateSubmission }
): Promise<TaskboardSubmissionResult> {
  const submission = input.submission;
  const issue = await input.client.getIssue(submission.identifier);
  if (issue.projectId !== input.projectId) {
    return { kind: "invalid", message: `${issue.identifier} 不属于当前 Taskboard 项目。` };
  }
  if (issue.version !== submission.version) return { kind: "conflict", issue };
  if (submission.operation === "comment") {
    if (!issue.threadId) return { kind: "invalid", issue, message: "任务尚未开始，不能添加进展。" };
    await input.client.addComment(issue.id, submission.body, issue.threadId);
    return { kind: "issue", issue, latestComment: submission.body, note: "进展已记录。" };
  }
  const status = targetStatus(submission.operation);
  if (!isTaskboardTransitionAllowed(issue.status, status)) {
    return {
      kind: "invalid",
      issue,
      message: `当前状态“${issue.status}”不能执行该操作，已刷新为最新任务状态。`
    };
  }
  if (!issue.threadId) {
    if (submission.operation === "start") {
      return { kind: "workflow", issue, instruction: `领取并开始处理 ${issue.identifier}。` };
    }
    return { kind: "invalid", issue, message: "任务尚未关联 Codex 会话，请先开始处理。" };
  }
  if (submission.operation === "block" || submission.operation === "review" || submission.operation === "return") {
    await input.client.addComment(issue.id, submission.body, issue.threadId);
  }
  try {
    const moved = await input.client.moveIssue(issue.id, status, issue.version, issue.threadId);
    return {
      kind: "issue",
      issue: moved,
      ...("body" in submission ? { latestComment: submission.body } : {}),
      note: successNote(submission.operation)
    };
  } catch (error) {
    const latest = await input.client.getIssue(issue.identifier);
    if (latest.version !== issue.version) return { kind: "conflict", issue: latest };
    throw error;
  }
}

function targetStatus(operation: "block" | "review" | "return" | "start" | "accept"): TaskboardStatus {
  return TARGET_STATUS[operation];
}

const TARGET_STATUS = {
  block: "blocked",
  review: "in_review",
  return: "in_progress",
  start: "in_progress",
  accept: "done"
} as const satisfies Readonly<Record<"block" | "review" | "return" | "start" | "accept", TaskboardStatus>>;

function successNote(operation: "block" | "review" | "return" | "start" | "accept"): string {
  return {
    block: "已标记阻塞。",
    review: "已提交验收。",
    return: "已退回处理中。",
    start: "已开始处理。",
    accept: "已明确验收通过。"
  }[operation];
}

function assertNever(value: never): never {
  throw new UnexpectedTaskboardSubmissionError(value);
}

class UnexpectedTaskboardSubmissionError extends Error {
  readonly name = "UnexpectedTaskboardSubmissionError";
  constructor(readonly value: never) {
    super("Taskboard submission was not handled exhaustively");
  }
}
