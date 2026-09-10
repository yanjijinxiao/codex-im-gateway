import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexThreadState } from "./backend.js";
/** Desktop's sidebar membership is distinct from app-server's native project IDs.
 * Read it once per catalog snapshot and prefer explicit host + thread membership.
 * Desktop's legacy catalog can additionally group unassigned records by workspace.
 * This adapter is used only by the App backend; CLI has no Desktop registry.
 */
export function desktopSessionMembership(codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), hostId = "local", legacyWorkspaceFallback = false): (state: CodexThreadState) => CodexThreadState {
  let state: Record<string, unknown> = {};
  for(const filename of [".codex-global-state.json", ".codex-global-state.json.bak"]) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(codexHome, filename), "utf8"));
      if(!record(parsed))
        continue;
      state = parsed;
      break;
    }
    catch { /* Atomic replacement or Desktop not installed; native data remains authoritative. */ }
  }
  const projectHosts = new Map<string, string>();
  const roots: Array<{ projectId: string; root: string }> = [];
  if(record(state["local-projects"])) {
    for(const [id, project] of Object.entries(state["local-projects"])) {
      if(record(project)) {
        projectHosts.set(typeof project.id === "string" ? project.id : id, "local");
        if (hostId === "local" && Array.isArray(project.rootPaths)) for (const root of project.rootPaths)
          if (typeof root === "string") roots.push({ projectId: typeof project.id === "string" ? project.id : id, root });
      }
    }
  }
  if(Array.isArray(state["remote-projects"])) {
    for(const project of state["remote-projects"]) {
      if(record(project) && typeof project.id === "string" && typeof project.hostId === "string") {
        projectHosts.set(project.id, project.hostId);
        if (project.hostId === hostId && typeof project.remotePath === "string") roots.push({ projectId: project.id, root: project.remotePath });
      }
    }
  }
  const membership = new Map<string, string | undefined>();
  const orders = state["sidebar-project-thread-orders"];
  if(record(orders)) {
    for(const [projectId, order] of Object.entries(orders)) {
      if(projectHosts.get(projectId) !== hostId || !record(order) || !Array.isArray(order.threadIds))
        continue;
      for(const id of order.threadIds)
        if(typeof id === "string")
          membership.set(id, projectId);
    }
  }
  // A deliberately independent task must never be moved into a cwd-matching
  // project. An explicit project assignment below takes precedence after a move.
  if (Array.isArray(state["projectless-thread-ids"])) for (const id of state["projectless-thread-ids"])
    if (typeof id === "string") membership.set(id, undefined);
  // Explicit assignments override sidebar ordering, which can lag after a move.
  const assignments = state["thread-project-assignments"];
  if(record(assignments)) {
    for(const [id, assignment] of Object.entries(assignments)) {
      if(!record(assignment))
        continue;
      if(typeof assignment.projectId === "string" && projectHosts.get(assignment.projectId) === hostId) {
        membership.set(id, assignment.projectId);
      }
      else if(assignment.projectId === null && (assignment.hostId ?? "local") === hostId) {
        membership.set(id, undefined);
      }
    }
  }
  const hints = record(state["thread-workspace-root-hints"]) ? state["thread-workspace-root-hints"] : {};
  return (thread) => {
    if (membership.has(thread.threadId)) return { ...thread, projectId: membership.get(thread.threadId) };
    if (!legacyWorkspaceFallback || thread.projectId) return thread;
    const hint = hints[thread.threadId];
    const cwd = typeof hint === "string" ? hint : thread.cwd;
    if (!cwd) return thread;
    // Same boundary-aware root matching used by Desktop's project groups.
    // Ambiguous roots do not invent a membership; the longest unique root wins.
    const matches = roots.filter(({ root }) => cwd === root || cwd.startsWith(`${root.replace(/[\\/]+$/, "")}/`))
      .sort((a, b) => b.root.length - a.root.length);
    const longest = matches[0];
    const ids = new Set(matches.filter(m => m.root.length === longest?.root.length).map(m => m.projectId));
    return ids.size === 1 ? { ...thread, projectId: longest.projectId } : thread;
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
