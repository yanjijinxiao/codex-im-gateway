import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  CodexProject,
  CodexProjectCatalog,
  CodexThreadActiveFlag,
  CodexThreadPersistence,
  CodexThreadRuntimeStatus,
  CodexTurnStatus
} from "../codex/backend.js";
import { listCodexCliProjects } from "../codex/cli-projects.js";

export type CodexProjectCandidate = {
  readonly name: string;
  readonly workspace: string;
  readonly lastUsedAt: string;
  readonly sessionCount: number;
  readonly projectId?: string;
  readonly projectKind?: "local" | "remote";
  readonly hostId?: string;
  readonly available?: boolean;
};

export type CodexSessionCandidate = {
  readonly threadId: string;
  readonly workspace: string;
  readonly lastUsedAt: string;
  readonly title?: string;
  readonly lastUserMessage?: string;
  readonly persistence?: CodexThreadPersistence;
  readonly runtimeStatus?: CodexThreadRuntimeStatus;
  readonly activeFlags?: readonly CodexThreadActiveFlag[];
  readonly latestTurnStatus?: CodexTurnStatus;
  readonly desktopOwned?: boolean;
};

/**
 * Builds the complete Desktop-visible session catalog from app-server state
 * and Desktop's persisted task registry. app-server remains authoritative for
 * lifecycle/runtime state when both sources know the thread, while a
 * Desktop-owned thread omitted by a second app-server process is retained.
 */
export function mergeCodexSessionCandidates(
  appServerCandidates: readonly CodexSessionCandidate[],
  desktopCandidates: readonly CodexSessionCandidate[],
  limit = 100
): readonly CodexSessionCandidate[] {
  const merged = new Map(desktopCandidates.map((candidate) => [candidate.threadId, candidate]));
  for (const candidate of appServerCandidates) {
    const desktop = merged.get(candidate.threadId);
    merged.set(candidate.threadId, desktop ? {
      ...desktop,
      ...candidate,
      lastUsedAt: candidate.lastUsedAt > desktop.lastUsedAt
        ? candidate.lastUsedAt
        : desktop.lastUsedAt,
      ...(candidate.title ?? desktop.title ? { title: candidate.title ?? desktop.title } : {}),
      ...(candidate.lastUserMessage ?? desktop.lastUserMessage
        ? { lastUserMessage: candidate.lastUserMessage ?? desktop.lastUserMessage }
        : {})
    } : candidate);
  }
  return [...merged.values()]
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, Math.max(0, limit));
}

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
  limit = 10,
  desktopProjectId?: string
): readonly CodexSessionCandidate[] {
  const resolvedWorkspace = resolveDirectory(workspace)
    || (desktopProjectId && path.isAbsolute(workspace) ? path.normalize(workspace) : "");
  if (!resolvedWorkspace || limit <= 0) return [];
  const desktopProjectThreads = desktopProjectId
    ? readDesktopProjectThreadIds(codexHome, desktopProjectId)
    : new Set<string>();
  const files: Array<{
    readonly path: string;
    readonly modifiedAt: number;
    readonly persistence: "active" | "archived";
  }> = [
    ...listJsonlFiles(path.join(codexHome, "sessions")).map((file) => ({ ...file, persistence: "active" as const })),
    ...listJsonlFiles(path.join(codexHome, "archived_sessions")).map((file) => ({ ...file, persistence: "archived" as const }))
  ].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 2_000);
  const candidates = new Map<string, CodexSessionCandidate>();
  const titles = readDesktopSessionTitles(codexHome);

  for (const file of files) {
    const meta = readSessionMeta(file.path);
    if (meta?.payload?.thread_source === "subagent") continue;
    const candidateWorkspace = meta?.payload?.cwd ? resolveDirectory(meta.payload.cwd) : "";
    const threadId = meta?.payload?.session_id ?? meta?.payload?.id;
    if (!threadId) continue;
    const desktopAssigned = desktopProjectThreads.has(threadId);
    if (!desktopAssigned && candidateWorkspace !== resolvedWorkspace) continue;
    const activity = readSessionActivity(file.path, file.modifiedAt);
    const candidate: CodexSessionCandidate = {
      threadId,
      workspace: desktopAssigned ? resolvedWorkspace : candidateWorkspace,
      lastUsedAt: activity.lastUsedAt,
      persistence: file.persistence,
      ...(titles.get(threadId) ? { title: titles.get(threadId) } : {}),
      ...(hasDesktopWriterLock(codexHome, threadId) ? { desktopOwned: true } : {}),
      ...(activity.lastUserMessage ? { lastUserMessage: activity.lastUserMessage } : {})
    };
    const existing = candidates.get(threadId);
    if (!existing) {
      candidates.set(threadId, candidate);
    } else if (candidate.lastUsedAt > existing.lastUsedAt) {
      candidates.set(threadId, {
        ...existing,
        ...candidate,
        ...(candidate.lastUserMessage ?? existing.lastUserMessage
          ? { lastUserMessage: candidate.lastUserMessage ?? existing.lastUserMessage }
          : {})
      });
    }
  }

  if (desktopProjectId) {
    const now = Date.now();
    for (const [index, threadId] of desktopProjectThreadIds(codexHome, desktopProjectId).entries()) {
      if (candidates.has(threadId)) continue;
      candidates.set(threadId, {
        threadId,
        workspace: resolvedWorkspace,
        lastUsedAt: new Date(now - index).toISOString(),
        persistence: "unknown",
        ...(titles.get(threadId) ? { title: titles.get(threadId) } : {}),
        ...(hasDesktopWriterLock(codexHome, threadId) ? { desktopOwned: true } : {})
      });
    }
  }

  return [...candidates.values()]
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, limit);
}

function desktopProjectThreadIds(codexHome: string, projectId: string): string[] {
  const state = readDesktopGlobalState(codexHome);
  const orders = state && isRecord(state["sidebar-project-thread-orders"])
    ? state["sidebar-project-thread-orders"]
    : undefined;
  const entry = orders?.[projectId];
  if (!isRecord(entry) || !Array.isArray(entry.threadIds)) return [];
  return entry.threadIds.filter((threadId): threadId is string => typeof threadId === "string" && Boolean(threadId));
}

export function listCodexProjectCandidates(
  codexHome = path.join(os.homedir(), ".codex")
): readonly CodexProjectCandidate[] {
  const desktopProjects = readCodexDesktopProjects(codexHome);
  if (desktopProjects.length) return desktopProjects;

  return listSessionProjectCandidates(codexHome);
}

export function listCodexCliProjectCandidates(
  codexHome = path.join(os.homedir(), ".codex")
): readonly CodexProjectCandidate[] {
  return projectCandidatesFromBackendCatalog({
    backend: "exec",
    projects: listCodexCliProjects(codexHome)
  }, codexHome);
}

/**
 * Combines app-server's live project/list response with Desktop-only routing
 * metadata (notably remote projects and host ids). Session history is used
 * only when neither registry is available, so project commands represent the
 * current Codex project catalog rather than every directory ever used by a
 * task.
 */
export function mergeCodexProjectCandidates(
  appServerProjects: readonly CodexProject[],
  codexHome = path.join(os.homedir(), ".codex")
): readonly CodexProjectCandidate[] {
  const desktopProjects = readCodexDesktopProjects(codexHome);
  const merged = [...desktopProjects];
  const registeredIds = new Set(desktopProjects.flatMap((project) => project.projectId ? [project.projectId] : []));
  const registeredLocalWorkspaces = new Set(desktopProjects
    .filter((project) => project.projectKind !== "remote")
    .map((project) => project.workspace));

  for (const project of appServerProjects) {
    if (registeredIds.has(project.id)) continue;
    const workspace = project.roots.map((root) => resolveDirectory(root)).find(Boolean);
    if (!workspace || registeredLocalWorkspaces.has(workspace)) continue;
    merged.push({
      projectId: project.id,
      projectKind: "local",
      name: project.name || path.basename(workspace) || workspace,
      workspace,
      lastUsedAt: new Date(0).toISOString(),
      sessionCount: 0,
      available: true
    });
    registeredIds.add(project.id);
    registeredLocalWorkspaces.add(workspace);
  }

  return merged.length ? merged : listSessionProjectCandidates(codexHome);
}

/** Converts the selected backend's catalog without silently mixing sources. */
export function projectCandidatesFromBackendCatalog(
  catalog: CodexProjectCatalog,
  codexHome = path.join(os.homedir(), ".codex")
): readonly CodexProjectCandidate[] {
  if (catalog.backend === "app-server") {
    return mergeCodexProjectCandidates(catalog.projects, codexHome);
  }
  return catalog.projects.flatMap((project) => {
    const workspace = project.roots.map((root) => resolveDirectory(root)).find(Boolean);
    if (!workspace) return [];
    return [{
      projectId: project.id,
      projectKind: "local" as const,
      name: project.name || path.basename(workspace) || workspace,
      workspace,
      lastUsedAt: project.lastUsedAt ?? new Date(0).toISOString(),
      sessionCount: project.sessionCount ?? 0,
      available: true
    }];
  });
}

function listSessionProjectCandidates(codexHome: string): readonly CodexProjectCandidate[] {
  return listCodexCliProjects(codexHome).flatMap((project) => {
    const workspace = project.roots[0];
    if (!workspace) return [];
    return [{
      name: project.name,
      workspace,
      lastUsedAt: project.lastUsedAt ?? new Date(0).toISOString(),
      sessionCount: project.sessionCount ?? 0
    }];
  });
}

type CodexDesktopGlobalState = {
  readonly "local-projects"?: unknown;
  readonly "remote-projects"?: unknown;
  readonly "project-order"?: unknown;
  readonly "sidebar-project-thread-orders"?: unknown;
  readonly "thread-project-assignments"?: unknown;
};

/**
 * Reads the project registry maintained by Codex Desktop. This is deliberately
 * read-only and falls back to session discovery when Desktop has not created a
 * registry yet or is in the middle of replacing the state file.
 */
export function readCodexDesktopProjects(
  codexHome = path.join(os.homedir(), ".codex")
): readonly CodexProjectCandidate[] {
  const state = readDesktopGlobalState(codexHome);
  if (!state) return [];

  const sessionsByProject = isRecord(state["sidebar-project-thread-orders"])
    ? state["sidebar-project-thread-orders"]
    : {};
  const candidates = new Map<string, CodexProjectCandidate>();
  if (isRecord(state["local-projects"])) {
    for (const [fallbackId, rawProject] of Object.entries(state["local-projects"])) {
      if (!isRecord(rawProject)) continue;
      const projectId = stringValue(rawProject.id) ?? fallbackId;
      const workspace = firstString(rawProject.rootPaths);
      if (!workspace) continue;
      const resolvedWorkspace = resolveDirectory(workspace);
      if (!resolvedWorkspace) continue;
      candidates.set(projectId, {
        projectId,
        projectKind: "local",
        name: stringValue(rawProject.name) ?? (path.basename(resolvedWorkspace) || resolvedWorkspace),
        workspace: resolvedWorkspace,
        lastUsedAt: timestampFromMilliseconds(rawProject.updatedAt ?? rawProject.createdAt),
        sessionCount: desktopProjectSessionCount(sessionsByProject[projectId]),
        available: true
      });
    }
  }

  if (Array.isArray(state["remote-projects"])) {
    for (const rawProject of state["remote-projects"]) {
      if (!isRecord(rawProject)) continue;
      const projectId = stringValue(rawProject.id);
      const workspace = stringValue(rawProject.remotePath);
      if (!projectId || !workspace || !path.isAbsolute(workspace)) continue;
      candidates.set(projectId, {
        projectId,
        projectKind: "remote",
        name: stringValue(rawProject.label) ?? (path.basename(workspace) || workspace),
        workspace: path.normalize(workspace),
        lastUsedAt: new Date(0).toISOString(),
        sessionCount: desktopProjectSessionCount(sessionsByProject[projectId]),
        ...(stringValue(rawProject.hostId) ? { hostId: stringValue(rawProject.hostId) } : {}),
        available: Boolean(stringValue(rawProject.hostId))
      });
    }
  }

  const orderedIds = Array.isArray(state["project-order"])
    ? state["project-order"].filter((value): value is string => typeof value === "string")
    : [];
  return [
    ...orderedIds.flatMap((projectId) => {
      const project = candidates.get(projectId);
      if (!project) return [];
      candidates.delete(projectId);
      return [project];
    }),
    ...candidates.values()
  ];
}

function readDesktopGlobalState(codexHome: string): CodexDesktopGlobalState | undefined {
  for (const name of [".codex-global-state.json", ".codex-global-state.json.bak"]) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(codexHome, name), "utf8"));
      if (isRecord(parsed)) return parsed;
    } catch {
      // Desktop replaces this file atomically. Try the backup before falling back.
    }
  }
  return undefined;
}

function readDesktopProjectThreadIds(codexHome: string, projectId: string): Set<string> {
  const state = readDesktopGlobalState(codexHome);
  const threadIds = new Set<string>();
  if (!state) return threadIds;

  const sidebarOrders = state["sidebar-project-thread-orders"];
  if (isRecord(sidebarOrders)) {
    const order = sidebarOrders[projectId];
    if (isRecord(order) && Array.isArray(order.threadIds)) {
      for (const threadId of order.threadIds) {
        if (typeof threadId === "string") threadIds.add(threadId);
      }
    }
  }

  const assignments = state["thread-project-assignments"];
  if (isRecord(assignments)) {
    for (const [threadId, assignment] of Object.entries(assignments)) {
      if (isRecord(assignment) && assignment.projectId === projectId) threadIds.add(threadId);
    }
  }
  return threadIds;
}

function desktopProjectSessionCount(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.threadIds)) return 0;
  return value.threadIds.filter((threadId) => typeof threadId === "string").length;
}

function timestampFromMilliseconds(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : new Date(0).toISOString();
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) ? value.find((item): item is string => typeof item === "string" && Boolean(item.trim())) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    const descriptor = fs.openSync(filePath, "r");
    try {
      return readSessionActivityBackwards(descriptor, size, fallbackMs);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return { lastUsedAt: new Date(fallbackMs).toISOString() };
  }
}

function readSessionActivityBackwards(
  descriptor: number,
  size: number,
  fallbackMs: number
): { lastUsedAt: string; lastUserMessage?: string } {
  const blockSize = 1024 * 1024;
  const maximumScanBytes = 256 * 1024 * 1024;
  const minimumPosition = Math.max(0, size - maximumScanBytes);
  let position = size;
  let trailingFragment = Buffer.alloc(0);
  let discardingOversizedLine = false;
  let lastUsedAt: string | undefined;

  const inspectLine = (line: string): string | undefined => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isRecord(event)) return undefined;
    if (typeof event.timestamp === "string") {
      const timestamp = normalizeTimestamp(event.timestamp, fallbackMs);
      if (!lastUsedAt) lastUsedAt = timestamp;
    }
    const userMessage = sessionUserMessage(event);
    return userMessage && !isInternalDesktopUserMessage(userMessage)
      ? userMessage
      : undefined;
  };

  while (position > minimumPosition) {
    const bytesToRead = Math.min(blockSize, position - minimumPosition);
    const blockStart = position - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, blockStart);
    let data = buffer.subarray(0, bytesRead);
    position = blockStart;

    if (discardingOversizedLine) {
      const boundary = data.lastIndexOf(0x0a);
      if (boundary < 0) continue;
      data = data.subarray(0, boundary);
      discardingOversizedLine = false;
    } else {
      data = Buffer.concat([data, trailingFragment]);
    }

    let lineEnd = data.length;
    for (let index = data.length - 1; index >= 0; index -= 1) {
      if (data[index] !== 0x0a) continue;
      const lastUserMessage = inspectLine(data.subarray(index + 1, lineEnd).toString("utf8"));
      if (lastUserMessage) {
        return {
          lastUsedAt: lastUsedAt ?? new Date(fallbackMs).toISOString(),
          lastUserMessage
        };
      }
      lineEnd = index;
    }
    trailingFragment = Buffer.from(data.subarray(0, lineEnd));

    // Tool output records can be very large. Once a single JSONL record grows
    // beyond this bound, skip it without retaining the whole record in memory.
    if (trailingFragment.byteLength > 16 * 1024 * 1024) {
      trailingFragment = Buffer.alloc(0);
      discardingOversizedLine = true;
    }
  }

  if (position === 0 && !discardingOversizedLine && trailingFragment.byteLength > 0) {
    const lastUserMessage = inspectLine(trailingFragment.toString("utf8"));
    if (lastUserMessage) {
      return {
        lastUsedAt: lastUsedAt ?? new Date(fallbackMs).toISOString(),
        lastUserMessage
      };
    }
  }
  return {
    lastUsedAt: lastUsedAt ?? new Date(fallbackMs).toISOString()
  };
}

function sessionUserMessage(event: Record<string, unknown>): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  if (event.type === "event_msg"
    && event.payload.type === "user_message"
    && typeof event.payload.message === "string") {
    return event.payload.message;
  }
  if (event.type !== "response_item"
    || event.payload.type !== "message"
    || event.payload.role !== "user"
    || !Array.isArray(event.payload.content)) {
    return undefined;
  }
  const text = event.payload.content
    .flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : [])
    .join("");
  return text || undefined;
}

function readDesktopSessionTitles(codexHome: string): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  try {
    const text = fs.readFileSync(path.join(codexHome, "session_index.jsonl"), "utf8");
    for (const line of text.split("\n")) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      const threadId = stringValue(value.id);
      const title = cleanSessionTitle(stringValue(value.thread_name));
      if (threadId && title) titles.set(threadId, title);
    }
  } catch {
    // Desktop may not have created the optional title index yet.
  }
  return titles;
}

function hasDesktopWriterLock(codexHome: string, threadId: string): boolean {
  try {
    return fs.statSync(path.join(codexHome, "thread-writer-locks", `${threadId}.lock`)).isFile();
  } catch {
    return false;
  }
}

function isInternalDesktopUserMessage(value: string): boolean {
  const text = value.trimStart();
  if (text.startsWith("<environment_context>") && text.trimEnd().endsWith("</environment_context>")) {
    return true;
  }
  if (text.startsWith("<recommended_plugins>")
    && (text.trimEnd().endsWith("</recommended_plugins>")
      || text.trimEnd().endsWith("</environment_context>"))) {
    return true;
  }
  if (text.startsWith("<turn_aborted>") && text.trimEnd().endsWith("</turn_aborted>")) {
    return true;
  }
  if (!text.startsWith("The following is the Codex agent history")) return false;
  return text.includes("whose request action you are assessing")
    || text.includes("added since your last approval assessment")
    || (
      text.includes(">>> APPROVAL REQUEST START")
      && (
        text.includes(">>> TRANSCRIPT START")
        || text.includes(">>> TRANSCRIPT DELTA START")
      )
    );
}

function cleanSessionTitle(value?: string): string | undefined {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 120);
  return clean || undefined;
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
