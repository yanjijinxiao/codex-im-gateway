import path from "node:path";

import type {
  TaskboardClient,
  TaskboardComment,
  TaskboardIssue,
  TaskboardProject,
  TaskboardStatus
} from "./client.js";

export type TaskboardManagedProject = {
  readonly accountId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly workspace: string;
};

export type TaskboardIssueSummary = TaskboardIssue & {
  readonly taskboardProjectName: string;
  readonly managedProjects: readonly TaskboardManagedProject[];
};

export type TaskboardIssueDetail = {
  readonly issue: TaskboardIssueSummary;
  readonly comments: readonly TaskboardComment[];
};

type TaskboardProjectMapping = {
  readonly taskboardProject: TaskboardProject;
  readonly managedProjects: readonly TaskboardManagedProject[];
};

type TaskboardWorkbenchOptions = {
  readonly client: () => TaskboardClient | undefined;
  readonly projects: () => readonly TaskboardManagedProject[];
};

const ALLOWED_TRANSITIONS: Readonly<Record<TaskboardStatus, readonly TaskboardStatus[]>> = {
  backlog: [],
  todo: ["in_progress"],
  in_progress: ["blocked", "in_review"],
  in_review: ["in_progress", "done"],
  blocked: ["in_progress"],
  done: [],
  canceled: []
};

export class TaskboardWorkbenchError extends Error {
  readonly name = "TaskboardWorkbenchError";

  constructor(readonly code: "DISABLED" | "NOT_MAPPED" | "THREAD_REQUIRED" | "INVALID_TRANSITION", message: string) {
    super(message);
  }
}

export class TaskboardWorkbench {
  constructor(private readonly options: TaskboardWorkbenchOptions) {}

  async listIssues(): Promise<TaskboardIssueSummary[]> {
    const client = this.requireClient();
    const mappings = await this.projectMappings(client);
    const issues = await Promise.all(mappings.map(async (mapping) => (
      (await client.listIssues({ projectId: mapping.taskboardProject.id }))
        .map((issue) => summarizeIssue(issue, mapping))
    )));
    return issues.flat().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getIssue(identifier: string): Promise<TaskboardIssueDetail> {
    const { client, issue, mapping } = await this.mappedIssue(identifier);
    return {
      issue: summarizeIssue(issue, mapping),
      comments: await client.listComments(issue.id)
    };
  }

  async commentIssue(identifier: string, body: string): Promise<TaskboardComment> {
    const { client, issue } = await this.mappedIssue(identifier);
    return client.addComment(issue.id, body, requireThread(issue));
  }

  async moveIssue(
    identifier: string,
    status: TaskboardStatus,
    version: number,
    comment?: string
  ): Promise<TaskboardIssue> {
    const { client, issue } = await this.mappedIssue(identifier);
    const threadId = requireThread(issue);
    if (issue.version !== version) {
      throw new TaskboardWorkbenchError(
        "INVALID_TRANSITION",
        `Taskboard issue version changed: expected ${version}, current ${issue.version}`
      );
    }
    if (!ALLOWED_TRANSITIONS[issue.status].includes(status)) {
      throw new TaskboardWorkbenchError(
        "INVALID_TRANSITION",
        `Invalid Taskboard transition: ${issue.status} -> ${status}`
      );
    }
    const note = comment?.trim();
    if (["blocked", "in_review"].includes(status) && !note) {
      throw new TaskboardWorkbenchError(
        "INVALID_TRANSITION",
        `Taskboard transition to ${status} requires a comment`
      );
    }
    if (note) await client.addComment(issue.id, note, threadId);
    return client.moveIssue(issue.id, status, version, threadId);
  }

  private requireClient(): TaskboardClient {
    const client = this.options.client();
    if (!client) throw new TaskboardWorkbenchError("DISABLED", "Taskboard integration is disabled");
    return client;
  }

  private async projectMappings(client: TaskboardClient): Promise<TaskboardProjectMapping[]> {
    const managedProjects = this.options.projects();
    return (await client.listProjects()).flatMap((taskboardProject) => {
      if (!taskboardProject.workspacePath) return [];
      const workspace = path.resolve(taskboardProject.workspacePath);
      const matches = managedProjects.filter((project) => path.resolve(project.workspace) === workspace);
      return matches.length ? [{ taskboardProject, managedProjects: matches }] : [];
    });
  }

  private async mappedIssue(identifier: string): Promise<{
    readonly client: TaskboardClient;
    readonly issue: TaskboardIssue;
    readonly mapping: TaskboardProjectMapping;
  }> {
    const client = this.requireClient();
    const issue = await client.getIssue(identifier);
    const mapping = (await this.projectMappings(client))
      .find((candidate) => candidate.taskboardProject.id === issue.projectId);
    if (!mapping) {
      throw new TaskboardWorkbenchError(
        "NOT_MAPPED",
        `Taskboard issue not found in a managed workspace: ${identifier}`
      );
    }
    return { client, issue, mapping };
  }
}

function summarizeIssue(issue: TaskboardIssue, mapping: TaskboardProjectMapping): TaskboardIssueSummary {
  return {
    ...issue,
    taskboardProjectName: mapping.taskboardProject.name,
    managedProjects: mapping.managedProjects
  };
}

function requireThread(issue: TaskboardIssue): string {
  if (!issue.threadId) {
    throw new TaskboardWorkbenchError(
      "THREAD_REQUIRED",
      `Taskboard issue ${issue.identifier} has no Codex thread`
    );
  }
  return issue.threadId;
}
