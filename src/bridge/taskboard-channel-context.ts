import type { ManagedProject, ManagedSession, RuntimeStateStore } from "../state/runtime-state.js";
import type { TaskboardClient, TaskboardIssue, TaskboardProject } from "../taskboard/client.js";

export type TaskboardChannelContext = {
  readonly session?: ManagedSession;
  readonly managedProject: ManagedProject;
  readonly taskboardProject: TaskboardProject;
};

type ContextOptions = {
  readonly stateStore: RuntimeStateStore;
  readonly replyText: (senderId: string, text: string) => Promise<void>;
};

type TaskboardProjectContextClient = Pick<TaskboardClient, "ensureProjectForWorkspace">;

export async function resolveTaskboardChannelContext(
  options: ContextOptions,
  client: TaskboardProjectContextClient,
  senderId: string
): Promise<TaskboardChannelContext | undefined> {
  const managedProject = options.stateStore.getActiveProject(senderId);
  const activeSession = options.stateStore.getActiveSession(senderId);
  const session = activeSession?.projectId === managedProject?.id ? activeSession : undefined;
  if (!managedProject) {
    await options.replyText(senderId, "请先在渠道工作台中选择一个 Codex 项目，再打开任务面板。");
    return undefined;
  }
  const taskboardProject = await client.ensureProjectForWorkspace({
    id: managedProject.id,
    name: managedProject.name,
    workspace: managedProject.workspace
  });
  return { ...(session ? { session } : {}), managedProject, taskboardProject };
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
      ? input.context.session?.threadId
        ? await input.client.issueForThread(input.context.taskboardProject.id, input.context.session.threadId)
        : undefined
      : await input.client.getIssue(input.identifier);
  } catch (error) {
    console.warn(
      `[codex-im-gateway] Taskboard target lookup failed for ${input.identifier}: ${error instanceof Error ? error.message : String(error)}`
    );
    await input.replyText(
      input.senderId,
      `无法读取任务 ${input.identifier}，请刷新任务面板后重试。`
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
