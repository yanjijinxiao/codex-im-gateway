import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodexSessionCatalog, CodexThreadListInput, CodexThreadState } from "./backend.js";
import { desktopSessionMembership } from "./desktop-session-membership.js";

type CatalogRow = {
  thread_id: string; display_title: string; cwd: string | null;
  source_updated_at: number; source_kind: string; thread_source: string | null;
};

/** Desktop's own persisted catalog (not its sidebar order and not state_*.sqlite).
 * Only documented-in-source metadata columns are read. Never create, migrate,
 * repair, archive, or resume anything here. A schema mismatch is explicit.
 */
export function readDesktopSessionCatalog(
  codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  hostId = "local",
  input: CodexThreadListInput = {}
): CodexSessionCatalog | undefined {
  const files = ["codex.db", "codex-dev.db"].map(name => path.join(codexHome, "sqlite", name)).filter(file => fs.existsSync(file));
  if (!files.length) return undefined;
  // Never combine separate Desktop installations/accounts or guess by mtime.
  if (files.length !== 1) throw new Error("检测到多个 Codex Desktop 目录数据库，无法确定当前 App 使用哪一个。");
  const db = new DatabaseSync(files[0], { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; BEGIN");
    const hostRows = db.prepare("SELECT host_id, host_kind FROM local_thread_catalog_hosts WHERE host_kind != 'chatgpt'").all() as Array<{ host_id: string; host_kind: string }>;
    const hostIds = hostRows.map(row => row.host_id);
    if (!hostIds.includes(hostId)) throw new Error(`Codex Desktop 目录尚未收录主机 ${hostId}。`);
    const sync = db.prepare("SELECT initial_build_complete FROM local_thread_catalog_sync_state WHERE host_id = ?").get(hostId) as { initial_build_complete: number } | undefined;
    const complete = sync?.initial_build_complete === 1;
    const rows = db.prepare(`SELECT thread_id, display_title, cwd, source_updated_at, source_kind, thread_source
      FROM local_thread_catalog WHERE host_id = ? AND missing_candidate = 0 AND source_kind != 'chatgpt'
      ORDER BY source_recency_at DESC, source_created_at DESC, thread_id`).all(hostId) as CatalogRow[];
    const unsupported = hostId === "local" ? Number((db.prepare("SELECT count(*) AS n FROM local_thread_catalog WHERE source_kind = 'chatgpt' AND missing_candidate = 0").get() as { n: number }).n) : 0;
    const membership = desktopSessionMembership(codexHome, hostId, true);
    // Archive/delete notifications can lag behind a catalog snapshot. For the
    // local host, cheaply recheck persistence without scanning any history.
    const localActive = hostId === "local" ? localActiveThreadIds(codexHome) : undefined;
    const threads: CodexThreadState[] = [];
    for (const row of rows) {
      if (localActive && !localActive.has(row.thread_id)) continue;
      // Defense for older catalogs. These are structural App rules, never a
      // title heuristic: an ordinary conversation named READY remains visible.
      if (row.source_kind === "exec" || row.source_kind.startsWith("subAgent")
        || row.thread_source === "ambient_suggestions" || row.thread_source === "pull_request_fix_automation") continue;
      const state = membership({
        threadId: row.thread_id, title: row.display_title, cwd: row.cwd ?? undefined,
        updatedAt: new Date(row.source_updated_at * 1000).toISOString(),
        persistence: "active", runtimeStatus: "unknown", activeFlags: []
      });
      if (input.persistence === "archived" || (input.projectId && state.projectId !== input.projectId)
        || (!input.projectId && input.cwd && state.cwd !== input.cwd) || (input.unassigned && state.projectId)) continue;
      threads.push(state);
    }
    return {
      backend: "app-server", source: "desktop-catalog", hostIds, complete,
      threads: threads.slice(0, input.limit ?? Infinity),
      warnings: [
        "来源：Codex App 会话目录；运行状态未实时获取时显示“未知”，不是“未加载”。绑定时会重新检查归档/删除状态。",
        ...(!complete ? [`${hostId} 的 App 会话目录仍在同步，本次不是完整列表，请稍后刷新。`] : []),
        ...(unsupported ? [`App 中另有 ${unsupported} 个 ChatGPT 聊天；当前后端仅支持 Codex 会话，未将这些聊天列为可绑定项。`] : [])
      ]
    };
  } finally { db.close(); }
}

function localActiveThreadIds(codexHome: string): Set<string> | undefined {
  const names = fs.readdirSync(codexHome).filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)));
  if (!names.length) return undefined;
  const db = new DatabaseSync(path.join(codexHome, names[0]), { readOnly: true });
  try {
    return new Set((db.prepare("SELECT id FROM threads WHERE archived = 0").all() as Array<{ id: string }>).map(row => row.id));
  } finally { db.close(); }
}

/** Compatibility policy when Desktop's catalog does not exist (older App or
 * standalone app-server). Keep this distinct from CLI's discovery semantics.
 */
export function isDesktopCatalogThread(thread: Record<string, unknown>): boolean {
  if (thread.ephemeral || thread.parentThreadId != null || thread.threadSource === "ambient_suggestions"
    || thread.threadSource === "pull_request_fix_automation") return false;
  const source = thread.source;
  if (source === undefined) return true; // Older protocol metadata.
  return typeof source === "string" ? source !== "exec" && !source.startsWith("subAgent")
    : Boolean(source && typeof source === "object" && "custom" in source);
}
