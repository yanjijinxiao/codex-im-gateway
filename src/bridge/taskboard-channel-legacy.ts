import { createTaskFormCard, type ChannelTaskFormCard } from "../channels/task-card.js";
import type { TaskboardIssue } from "../taskboard/client.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { TaskboardChannelContext } from "./taskboard-channel-context.js";
import type { TaskboardChannelControllerOptions } from "./taskboard-channel-types.js";

type HandleLegacyTaskboardCommandInput = {
  readonly message: NormalizedWeixinMessage;
  readonly input: string;
  readonly context: TaskboardChannelContext;
  readonly options: TaskboardChannelControllerOptions;
  readonly showIssue: (issue: TaskboardIssue, note?: string) => Promise<void>;
  readonly showOverview: () => Promise<void>;
  readonly resolveTarget: (identifier: string) => Promise<TaskboardIssue | undefined>;
};

export async function handleLegacyTaskboardCommand(input: HandleLegacyTaskboardCommandInput): Promise<void> {
  const [rawAction = "", rawIdentifier, ...rest] = input.input.split(/\s+/);
  const action = rawAction.toLowerCase();
  if (action === "new" || action === "todo") {
    await createLegacyIssue(input, action, [rawIdentifier, ...rest].filter(Boolean).join(" ").trim());
    return;
  }
  if (LEGACY_ACTIONS.has(action)) {
    if (!rawIdentifier) {
      await input.showOverview();
      return;
    }
    const issue = await input.resolveTarget(rawIdentifier);
    if (!issue) return;
    if (action === "detail") {
      await input.showIssue(issue);
      return;
    }
    if (issue.threadId) input.options.stateStore.setSessionThread(input.context.session.id, issue.threadId);
    if (action === "comment" || action === "attach") {
      await updateLegacyEvidence(input, action, issue, rest.join(" ").trim());
      return;
    }
    const detail = rest.join(" ").trim();
    if ((action === "block" || action === "review" || action === "return") && !detail) {
      await input.options.sendCard(input.message, formForLegacyAction(input, action, issue));
      return;
    }
    const instruction = workflowInstruction(action, issue, detail);
    if (!instruction) {
      await input.options.replyText(input.message.senderId, `不支持的 Taskboard 操作：${action}`);
      return;
    }
    if (!issue.threadId && action === "start") {
      input.options.stateStore.createSession(
        input.message.senderId,
        input.context.managedProject.workspace,
        issue.title,
        input.context.managedProject.id
      );
    }
    await input.options.runWorkflow(input.message, instruction);
    const refreshed = await input.options.client?.getIssue(issue.identifier);
    if (refreshed) await input.showIssue(refreshed, "已按最新任务状态刷新。");
    return;
  }
  const issue = await input.resolveTarget(rawAction);
  if (!issue) return;
  if (issue.threadId) {
    input.options.stateStore.setSessionThread(input.context.session.id, issue.threadId);
    await input.options.replyText(
      input.message.senderId,
      `已绑定 ${issue.identifier} · ${issue.title}\n下一条消息会在对应 Codex 任务中继续。`
    );
    return;
  }
  await input.showIssue(issue, "该任务尚未开始；可直接点击“开始处理”。");
}

async function createLegacyIssue(
  input: HandleLegacyTaskboardCommandInput,
  action: "new" | "todo",
  title: string
): Promise<void> {
  const client = input.options.client;
  if (!client) return;
  if (!title) {
    await input.options.sendCard(input.message, formForNewIssue(input, action));
    return;
  }
  const issue = await client.createIssue({
    projectId: input.context.taskboardProject.id,
    title,
    status: "todo",
    priority: "none",
    labels: []
  });
  if (action === "todo") {
    await input.showIssue(issue, "已记入待办，尚未开始处理。");
    return;
  }
  input.options.stateStore.createSession(
    input.message.senderId,
    input.context.managedProject.workspace,
    title,
    input.context.managedProject.id
  );
  await input.options.runWorkflow(
    input.message,
    `领取并开始处理刚创建的 ${issue.identifier}；将当前 Codex thread 绑定到该 Issue。`
  );
  const refreshed = await client.getIssue(issue.identifier);
  await input.showIssue(refreshed, "已按最新任务状态刷新。");
}

async function updateLegacyEvidence(
  input: HandleLegacyTaskboardCommandInput,
  action: "comment" | "attach",
  issue: TaskboardIssue,
  body: string
): Promise<void> {
  const client = input.options.client;
  if (!client) return;
  const threadId = issue.threadId ?? input.options.stateStore.getActiveSession(input.message.senderId)?.threadId;
  if (!threadId) {
    await input.showIssue(issue, "请先开始处理，再添加进展或附件。");
    return;
  }
  if (action === "comment" && body) await client.addComment(issue.id, body, threadId);
  const paths = await input.options.attachmentPaths(input.message);
  if (!paths) return;
  for (const localPath of paths) await client.uploadAttachment(issue.id, localPath);
  if (!body && !paths.length) {
    await input.options.sendCard(input.message, formForLegacyAction(input, "comment", issue));
    return;
  }
  await input.showIssue(issue, `已更新${body ? "进展" : ""}${paths.length ? `并上传 ${paths.length} 个附件` : ""}。`);
}

function formForNewIssue(
  input: HandleLegacyTaskboardCommandInput,
  action: "new" | "todo"
): ChannelTaskFormCard {
  return createTaskFormCard({
    form: action,
    projectName: input.context.managedProject.name,
    projectId: input.context.taskboardProject.id,
    taskboardBaseUrl: input.options.client?.baseUrl ?? "http://127.0.0.1"
  });
}

function formForLegacyAction(
  input: HandleLegacyTaskboardCommandInput,
  action: "comment" | "block" | "review" | "return",
  issue: TaskboardIssue
): ChannelTaskFormCard {
  return createTaskFormCard({
    form: action,
    issue,
    projectName: input.context.managedProject.name,
    projectId: input.context.taskboardProject.id,
    taskboardBaseUrl: input.options.client?.baseUrl ?? "http://127.0.0.1"
  });
}

function workflowInstruction(action: string, issue: TaskboardIssue, detail: string): string | undefined {
  switch (action) {
    case "start": return `领取并开始处理 ${issue.identifier}。`;
    case "block": return `将 ${issue.identifier} 标记为阻塞，并记录阻塞原因：${detail}。`;
    case "review": return `完成 ${issue.identifier} 的检查与证据记录，然后提交验收。${detail ? ` 补充：${detail}` : ""}`;
    case "accept": return `用户已明确确认验收 ${issue.identifier}；只有完成门禁满足时才标记完成，否则明确记录未通过原因。${detail ? ` 补充：${detail}` : ""}`;
    case "return": return `将待验收的 ${issue.identifier} 退回处理中，并记录退回原因：${detail}。`;
    default: return undefined;
  }
}

const LEGACY_ACTIONS = new Set(["start", "block", "review", "accept", "return", "comment", "attach", "detail"]);
