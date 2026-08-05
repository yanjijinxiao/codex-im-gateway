import type { ManagedProject, ManagedSession, RuntimeStateStore } from "../state/runtime-state.js";
import type { TaskboardClient, TaskboardIssue, TaskboardProject } from "../taskboard/client.js";

export type TaskboardChannelContext = {
  readonly session: ManagedSession;
  readonly managedProject: ManagedProject;
  readonly taskboardProject: TaskboardProject;
};

type ContextOptions = {
  readonly stateStore: RuntimeStateStore;
  readonly replyText: (senderId: string, text: string) => Promise<void>;
};

export async function resolveTaskboardChannelContext(
  options: ContextOptions,
  client: TaskboardClient,
  senderId: string
): Promise<TaskboardChannelContext | undefined> {
  const session = options.stateStore.getActiveSession(senderId);
  const managedProject = session?.projectId
    ? options.stateStore.listProjects().find((project) => project.id === session.projectId)
    : undefined;
  if (!session || !managedProject) {
    await options.replyText(senderId, "请先在渠道工作台中选择一个 Codex 项目，再打开任务面板。");
    return undefined;
  }
  const taskboardProject = await client.projectForWorkspace(managedProject.workspace);
  if (!taskboardProject) {
    await options.replyText(senderId, `当前 Codex 项目尚未映射到 Taskboard：${managedProject.workspace}`);
    return undefined;
  }
  return { session, managedProject, taskboardProject };
}

export async function resolveTaskboardTarget(input: {
  readonly context: TaskboardChannelContext;
  readonly client: TaskboardClient;
  readonly identifier: string;
  readonly senderId: string;
  readonly replyText: ContextOptions["replyText"];
}): Promise<TaskboardIssue | undefined> {
  let issue: TaskboardIssue | undefined;
  try {
    issue = input.identifier.toLowerCase() === "current"
      ? input.context.session.threadId
        ? await input.client.issueForThread(input.context.taskboardProject.id, input.context.session.threadId)
        : undefined
      : await input.client.getIssue(input.identifier);
  } catch (error) {
    await input.replyText(
      input.senderId,
      `无法读取任务 ${input.identifier}：${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
  if (!issue) {
    await input.replyText(input.senderId, "当前会话没有对应任务，请从任务面板中选择。");
    return undefined;
  }
  if (issue.projectId !== input.context.taskboardProject.id) {
    await input.replyText(
      input.senderId,
      `${issue.identifier} 不属于当前 Taskboard 项目“${input.context.taskboardProject.name}”。`
    );
    return undefined;
  }
  return issue;
}

export function taskboardBaseUrl(client: TaskboardClient): string {
  return typeof client.baseUrl === "string" && client.baseUrl.length
    ? client.baseUrl
    : "http://127.0.0.1:47823";
}

export async function latestTaskboardComment(
  client: TaskboardClient,
  issueId: string
): Promise<string | undefined> {
  const listComments = Reflect.get(client, "listComments");
  if (typeof listComments !== "function") return undefined;
  const comments: unknown = await listComments.call(client, issueId);
  if (!Array.isArray(comments)) return undefined;
  const latest: unknown = comments.at(-1);
  if (!latest || typeof latest !== "object") return undefined;
  const body = Reflect.get(latest, "body");
  return typeof body === "string" ? body : undefined;
}
