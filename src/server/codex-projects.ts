import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexProjectCandidate = {
  readonly name: string;
  readonly workspace: string;
  readonly lastUsedAt: string;
  readonly sessionCount: number;
};

export type CodexSessionCandidate = {
  readonly threadId: string;
  readonly workspace: string;
  readonly lastUsedAt: string;
  readonly lastUserMessage?: string;
};

type SessionMetaLine = {
  readonly type?: string;
  readonly timestamp?: string;
  readonly payload?: {
    readonly id?: string;
    readonly session_id?: string;
    readonly cwd?: string;
    readonly timestamp?: string;
    readonly thread_source?: string;
  };
};

export function listCodexSessionCandidates(
  workspace: string,
  codexHome = path.join(os.homedir(), ".codex"),
  limit = 10
): readonly CodexSessionCandidate[] {
  const resolvedWorkspace = resolveDirectory(workspace);
  if (!resolvedWorkspace || limit <= 0) return [];
  const files = [
    ...listJsonlFiles(path.join(codexHome, "sessions")),
    ...listJsonlFiles(path.join(codexHome, "archived_sessions"))
  ].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 2_000);
  const candidates = new Map<string, CodexSessionCandidate>();

  for (const file of files) {
    const meta = readSessionMeta(file.path);
    if (meta?.payload?.thread_source === "subagent") continue;
    const candidateWorkspace = meta?.payload?.cwd ? resolveDirectory(meta.payload.cwd) : "";
    const threadId = meta?.payload?.session_id ?? meta?.payload?.id;
    if (!threadId || candidateWorkspace !== resolvedWorkspace) continue;
    const activity = readSessionActivity(file.path, file.modifiedAt);
    const candidate: CodexSessionCandidate = {
      threadId,
      workspace: candidateWorkspace,
      lastUsedAt: activity.lastUsedAt,
      ...(activity.lastUserMessage ? { lastUserMessage: activity.lastUserMessage } : {})
    };
    const existing = candidates.get(threadId);
    if (!existing || candidate.lastUsedAt > existing.lastUsedAt) candidates.set(threadId, candidate);
  }

  return [...candidates.values()]
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, limit);
}

export function listCodexProjectCandidates(
  codexHome = path.join(os.homedir(), ".codex")
): readonly CodexProjectCandidate[] {
  const files = [
    ...listJsonlFiles(path.join(codexHome, "sessions")),
    ...listJsonlFiles(path.join(codexHome, "archived_sessions"))
  ].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 2_000);
  const projects = new Map<string, CodexProjectCandidate>();

  for (const file of files) {
    const meta = readSessionMeta(file.path);
    if (meta?.payload?.thread_source === "subagent") continue;
    const workspace = meta?.payload?.cwd ? resolveDirectory(meta.payload.cwd) : "";
    if (!workspace) continue;
    const lastUsedAt = normalizeTimestamp(meta?.payload?.timestamp ?? meta?.timestamp, file.modifiedAt);
    const existing = projects.get(workspace);
    projects.set(workspace, {
      name: path.basename(workspace) || workspace,
      workspace,
      lastUsedAt: existing && existing.lastUsedAt > lastUsedAt ? existing.lastUsedAt : lastUsedAt,
      sessionCount: (existing?.sessionCount ?? 0) + 1
    });
  }

  return [...projects.values()].sort((a, b) =>
    b.lastUsedAt.localeCompare(a.lastUsedAt) || a.workspace.localeCompare(b.workspace, "zh-CN")
  );
}

function listJsonlFiles(root: string): Array<{ readonly path: string; readonly modifiedAt: number }> {
  if (!isDirectory(root)) return [];
  const result: Array<{ path: string; modifiedAt: number }> = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          result.push({ path: entryPath, modifiedAt: fs.statSync(entryPath).mtimeMs });
        } catch {
          // Ignore files removed or made unreadable during discovery.
        }
      }
    }
  }
  return result;
}

function readSessionMeta(filePath: string): SessionMetaLine | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(128 * 1024);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const parsed: unknown = JSON.parse(firstLine);
    if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
      return undefined;
    }
    if (typeof parsed.payload.cwd !== "string") {
      return undefined;
    }
    return {
      type: "session_meta",
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      payload: {
        id: typeof parsed.payload.id === "string" ? parsed.payload.id : undefined,
        session_id: typeof parsed.payload.session_id === "string" ? parsed.payload.session_id : undefined,
        cwd: parsed.payload.cwd,
        timestamp: typeof parsed.payload.timestamp === "string"
          ? parsed.payload.timestamp
          : undefined,
        thread_source: typeof parsed.payload.thread_source === "string"
          ? parsed.payload.thread_source
          : undefined
      }
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readSessionActivity(
  filePath: string,
  fallbackMs: number
): { lastUsedAt: string; lastUserMessage?: string } {
  try {
    const size = fs.statSync(filePath).size;
    const offset = Math.max(0, size - 8 * 1024 * 1024);
    const descriptor = fs.openSync(filePath, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(size - offset);
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    let lastUsedAt: string | undefined;
    let lastUserMessage: string | undefined;
    for (const line of text.split("\n")) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;
      if (typeof event.timestamp === "string") {
        const timestamp = normalizeTimestamp(event.timestamp, fallbackMs);
        if (!lastUsedAt || timestamp > lastUsedAt) lastUsedAt = timestamp;
      }
      if (event.type !== "event_msg" || !isRecord(event.payload)) continue;
      if (event.payload.type === "user_message" && typeof event.payload.message === "string") {
        lastUserMessage = event.payload.message;
      }
    }
    return {
      lastUsedAt: lastUsedAt ?? new Date(fallbackMs).toISOString(),
      ...(lastUserMessage ? { lastUserMessage } : {})
    };
  } catch {
    return { lastUsedAt: new Date(fallbackMs).toISOString() };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTimestamp(value: string | undefined, fallbackMs: number): string {
  const timestamp = value ? new Date(value) : new Date(fallbackMs);
  return Number.isNaN(timestamp.getTime()) ? new Date(fallbackMs).toISOString() : timestamp.toISOString();
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolveDirectory(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!isDirectory(resolved)) return "";
  try {
    return fs.realpathSync(resolved);
  } catch {
    return "";
  }
}
