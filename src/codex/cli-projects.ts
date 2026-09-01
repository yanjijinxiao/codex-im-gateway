import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CodexProject } from "./backend.js";

type SessionMetaLine = {
  readonly type?: string;
  readonly timestamp?: string;
  readonly payload?: {
    readonly cwd?: string;
    readonly timestamp?: string;
    readonly thread_source?: string;
  };
};

/**
 * CLI implementation of project listing.
 *
 * `codex exec` has no project/list RPC. Its project model is the set of local
 * working directories in the CLI session store, so this adapter derives a
 * deterministic catalog from session metadata without consulting Desktop's
 * project registry or app-server.
 */
export function listCodexCliProjects(
  codexHome = path.join(os.homedir(), ".codex")
): CodexProject[] {
  const files = [
    ...listJsonlFiles(path.join(codexHome, "sessions")),
    ...listJsonlFiles(path.join(codexHome, "archived_sessions"))
  ].sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, 2_000);
  const projects = new Map<string, CodexProject>();

  for (const file of files) {
    const meta = readSessionMeta(file.path);
    if (meta?.payload?.thread_source === "subagent") continue;
    const workspace = typeof meta?.payload?.cwd === "string"
      ? resolveDirectory(meta.payload.cwd)
      : undefined;
    if (!workspace) continue;
    const lastUsedAt = normalizeTimestamp(meta?.payload?.timestamp ?? meta?.timestamp, file.modifiedAt);
    const existing = projects.get(workspace);
    projects.set(workspace, {
      id: existing?.id ?? cliProjectId(workspace),
      name: path.basename(workspace) || workspace,
      roots: [workspace],
      lastUsedAt: existing && existing.lastUsedAt && existing.lastUsedAt > lastUsedAt
        ? existing.lastUsedAt
        : lastUsedAt,
      sessionCount: (existing?.sessionCount ?? 0) + 1
    });
  }

  return [...projects.values()].sort((left, right) =>
    (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "")
      || left.roots[0]!.localeCompare(right.roots[0]!, "zh-CN")
  );
}

function cliProjectId(workspace: string): string {
  return `cli-${crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 32)}`;
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
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          result.push({ path: target, modifiedAt: fs.statSync(target).mtimeMs });
        } catch {
          // The CLI may rotate a session while the catalog is being read.
        }
      }
    }
  }
  return result;
}

function readSessionMeta(file: string): SessionMetaLine | undefined {
  let content: string;
  try {
    const descriptor = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(128 * 1024);
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, length).toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as SessionMetaLine;
      if (parsed.type === "session_meta") return parsed;
    } catch {
      // Ignore a partially written trailing line.
    }
  }
  return undefined;
}

function resolveDirectory(candidate: string): string | undefined {
  if (!path.isAbsolute(candidate)) return undefined;
  try {
    return fs.statSync(candidate).isDirectory() ? fs.realpathSync(candidate) : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function normalizeTimestamp(value: string | undefined, fallbackMs: number): string {
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}
