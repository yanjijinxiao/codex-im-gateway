import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const taskboardStatusSchema = z.enum([
  "backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"
]);
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspacePath: z.string().nullable(),
  issueCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string()
});
const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  status: taskboardStatusSchema,
  priority: z.string(),
  labels: z.array(z.string()),
  threadId: z.string().nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string()
});
const commentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  body: z.string(),
  threadId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
const attachmentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string()
});

export type TaskboardStatus = z.infer<typeof taskboardStatusSchema>;
export type TaskboardProject = z.infer<typeof projectSchema>;
export type TaskboardIssue = z.infer<typeof issueSchema>;
export type TaskboardComment = z.infer<typeof commentSchema>;
export type TaskboardAttachment = z.infer<typeof attachmentSchema>;
export type TaskboardFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type TaskboardEvent = {
  type: string;
  projectId?: string;
  taskId?: string;
  task?: TaskboardIssue;
  at?: string;
};

export class TaskboardClient {
  readonly baseUrl: string;
  private readonly fetch: TaskboardFetch;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl: string; fetch?: TaskboardFetch; timeoutMs?: number }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      throw new Error("Taskboard URL must use an HTTP loopback origin");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async health(): Promise<{ available: true }> {
    await this.listProjects();
    return { available: true };
  }

  async listProjects(): Promise<TaskboardProject[]> {
    const value = await this.request("/api/projects");
    return z.object({ projects: z.array(projectSchema) }).parse(value).projects;
  }

  async projectForWorkspace(workspace: string): Promise<TaskboardProject | undefined> {
    const target = path.resolve(workspace);
    return (await this.listProjects()).find((project) =>
      project.workspacePath !== null && path.resolve(project.workspacePath) === target
    );
  }

  async ensureProjectForWorkspace(project: { readonly id: string; readonly name: string; readonly workspace: string }): Promise<TaskboardProject> {
    const existing = await this.projectForWorkspace(project.workspace);
    if (existing) return existing;
    const value = await this.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: project.id, name: project.name, workspacePath: path.resolve(project.workspace) })
    });
    return z.object({ project: projectSchema }).parse(value).project;
  }

  async listIssues(filters: {
    projectId?: string;
    status?: TaskboardStatus;
    threadId?: string;
  } = {}): Promise<TaskboardIssue[]> {
    const query = new URLSearchParams();
    if (filters.projectId) query.set("projectId", filters.projectId);
    if (filters.status) query.set("status", filters.status);
    if (filters.threadId) query.set("threadId", filters.threadId);
    const suffix = query.size ? `?${query}` : "";
    const value = await this.request(`/api/tasks${suffix}`);
    return z.object({ tasks: z.array(issueSchema) }).parse(value).tasks;
  }

  async getIssue(identifier: string): Promise<TaskboardIssue> {
    const value = await this.request(`/api/tasks/${encodeURIComponent(identifier)}`);
    return z.object({ task: issueSchema }).parse(value).task;
  }

  async createIssue(input: {
    readonly projectId: string;
    readonly title: string;
    readonly description?: string;
    readonly status?: "backlog" | "todo";
    readonly priority?: string;
    readonly labels?: readonly string[];
  }): Promise<TaskboardIssue> {
    const value = await this.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: input.projectId,
        title: input.title,
        description: input.description ?? "",
        status: input.status ?? "todo",
        priority: input.priority ?? "none",
        labels: input.labels ?? []
      })
    });
    return z.object({ task: issueSchema }).parse(value).task;
  }

  async issueForThread(projectId: string, threadId: string): Promise<TaskboardIssue | undefined> {
    return (await this.listIssues({ projectId, threadId }))[0];
  }

  async listComments(taskId: string): Promise<TaskboardComment[]> {
    const value = await this.request(`/api/tasks/${encodeURIComponent(taskId)}/comments`);
    return z.object({ comments: z.array(commentSchema) }).parse(value).comments;
  }

  async addComment(taskId: string, body: string, threadId: string): Promise<TaskboardComment> {
    const value = await this.request(`/api/tasks/${encodeURIComponent(taskId)}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, threadId })
    });
    return z.object({ comment: commentSchema }).parse(value).comment;
  }

  async moveIssue(
    taskId: string,
    status: TaskboardStatus,
    version: number,
    threadId: string
  ): Promise<TaskboardIssue> {
    const value = await this.request(`/api/tasks/${encodeURIComponent(taskId)}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, version, threadId })
    });
    return z.object({ task: issueSchema }).parse(value).task;
  }

  async moveIssueWithComment(
    taskId: string,
    status: TaskboardStatus,
    version: number,
    threadId: string,
    body: string
  ): Promise<{ task: TaskboardIssue; comment: TaskboardComment }> {
    const value = await this.request(`/api/tasks/${encodeURIComponent(taskId)}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-taskboard-client": "taskctl" },
      body: JSON.stringify({ status, version, threadId, body })
    });
    const parsed = z.object({ task: issueSchema, comment: commentSchema }).parse(value);
    return parsed;
  }

  async uploadAttachment(taskId: string, localPath: string): Promise<TaskboardAttachment> {
    const body = await fs.readFile(localPath);
    const filename = path.basename(localPath);
    const value = await this.request(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
      method: "POST",
      headers: {
        "content-type": contentTypeFor(filename),
        "x-taskboard-filename": filename
      },
      body
    });
    return z.object({ attachment: attachmentSchema }).parse(value).attachment;
  }

  async subscribe(signal: AbortSignal, onEvent: (event: TaskboardEvent) => Promise<void> | void): Promise<void> {
    const response = await this.fetch(new URL("/api/events", `${this.baseUrl}/`), {
      headers: { accept: "text/event-stream" },
      signal
    });
    if (!response.ok || !response.body) throw await taskboardHttpError(response);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary).replace(/\r/g, "");
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim()).join("\n");
        if (data) {
          const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(data));
          const event: TaskboardEvent = {
            type: z.string().parse(raw.type),
            projectId: z.string().optional().parse(raw.projectId),
            taskId: z.string().optional().parse(raw.taskId),
            task: raw.task === undefined ? undefined : issueSchema.parse(raw.task),
            at: z.string().optional().parse(raw.at)
          };
          await onEvent(event);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetch(new URL(pathname, `${this.baseUrl}/`), {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw await taskboardHttpError(response);
    return response.json();
  }
}

async function taskboardHttpError(response: Response): Promise<Error> {
  const text = (await response.text()).slice(0, 1_000);
  return new Error(`Taskboard request failed (${response.status}): ${text || response.statusText}`);
}

function contentTypeFor(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webp": "image/webp"
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
