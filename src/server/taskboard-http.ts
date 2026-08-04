import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type { AccountManager } from "./account-manager.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

const commentSchema = z.object({
  body: z.string().trim().min(1).max(100_000)
});
const moveSchema = z.object({
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]),
  version: z.number().int().positive(),
  comment: z.string().trim().min(1).max(100_000).optional()
});

type TaskboardHttpRequest = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly accountManager: AccountManager;
};

export async function handleTaskboardHttp(input: TaskboardHttpRequest): Promise<boolean> {
  const method = input.request.method ?? "GET";
  if (method === "GET" && input.pathname === "/api/taskboard") {
    sendJson(input.response, 200, await input.accountManager.getTaskboardStatus());
    return true;
  }
  if (method === "GET" && input.pathname === "/api/taskboard/issues") {
    sendJson(input.response, 200, { issues: await input.accountManager.listTaskboardIssues() });
    return true;
  }

  const detail = matchIssuePath(input.pathname, "");
  if (method === "GET" && detail) {
    sendJson(input.response, 200, await input.accountManager.getTaskboardIssue(detail.identifier));
    return true;
  }

  const comments = matchIssuePath(input.pathname, "/comments");
  if (method === "POST" && comments) {
    const body = commentSchema.parse(await readJsonBody(input.request));
    sendJson(input.response, 201, {
      comment: await input.accountManager.commentTaskboardIssue(comments.identifier, body.body)
    });
    return true;
  }

  const move = matchIssuePath(input.pathname, "/move");
  if (method === "POST" && move) {
    const body = moveSchema.parse(await readJsonBody(input.request));
    sendJson(input.response, 200, {
      issue: await input.accountManager.moveTaskboardIssue(
        move.identifier,
        body.status,
        body.version,
        body.comment
      )
    });
    return true;
  }
  return false;
}

function matchIssuePath(pathname: string, suffix: string): { readonly identifier: string } | undefined {
  const prefix = "/api/taskboard/issues/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const encoded = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  if (!encoded || encoded.includes("/")) return undefined;
  return { identifier: decodeURIComponent(encoded) };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}
