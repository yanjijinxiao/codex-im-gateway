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
  let available = false;
  let current = false;
  for(const filename of [".codex-global-state.json", ".codex-global-state.json.bak"]) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(codexHome, filename), "utf8"));
      if(!record(parsed))
        continue;
      state = parsed;
      available = record(parsed["thread-project-assignments"]) || record(parsed["sidebar-project-thread-orders"])
        || Array.isArray(parsed["projectless-thread-ids"]);
      current = filename === ".codex-global-state.json";
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
  // App project IDs migrate independently from thread assignments. Resolve
  // aliases only in this exact host/home namespace, never by project name/cwd.
  const namespaces = state["app-server-project-id-by-legacy-project-id-by-host"];
  const aliases = record(namespaces) ? namespaces[`${hostId}:${codexHome}`] ?? namespaces[hostId] : undefined;
  const canonical = new Map<string, string>();
  if (record(aliases)) for (const [legacy, native] of Object.entries(aliases)) {
    if (typeof native === "string" && projectHosts.get(legacy) === hostId) {
      canonical.set(native, legacy); projectHosts.set(native, hostId);
    }
  }
  const canonicalId = (id: string) => canonical.get(id) ?? id;
  const membership = new Map<string, string | undefined>();
  const orders = state["sidebar-project-thread-orders"];
  if(record(orders)) {
    for(const [projectId, order] of Object.entries(orders)) {
      if(projectHosts.get(projectId) !== hostId || !record(order) || !Array.isArray(order.threadIds))
        continue;
      for(const id of order.threadIds)
        if(typeof id === "string")
          membership.set(id, canonicalId(projectId));
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
        membership.set(id, canonicalId(assignment.projectId));
      }
      else if(assignment.projectId === null && (assignment.hostId ?? "local") === hostId) {
        membership.set(id, undefined);
      }
    }
  }
  const atoms = record(state["electron-persisted-atom-state"]) ? state["electron-persisted-atom-state"] : {};
  // New App pin order supersedes the legacy set, which can retain unpinned IDs.
  // Unqualified local IDs never pin a same-ID remote conversation.
  const pinOrder = atoms["app-server-pinned-thread-order-v1"] ?? state["pinned-thread-ids"];
  const pins = new Map<string, number>();
  const threadHosts = record(state["thread-project-membership-host-ids"]) ? state["thread-project-membership-host-ids"] : {};
  if (Array.isArray(pinOrder)) pinOrder.forEach((id, index) => {
    if (typeof id === "string" && (threadHosts[id] ?? "local") === hostId && !pins.has(id)) pins.set(id, index);
  });
  const preferences = atoms["flat-project-sidebar-preferences-v1"];
  const manual = record(preferences) && preferences.chatSortMode === "manual";
  const manualIndexes = new Map<string, number>();
  if (manual && record(orders)) for (const [projectId, order] of Object.entries(orders)) {
    if (projectHosts.get(projectId) === hostId && record(order) && Array.isArray(order.threadIds))
      order.threadIds.forEach((id, index) => { if (typeof id === "string") manualIndexes.set(JSON.stringify([canonicalId(projectId), id]), index); });
  }
  const hints = record(state["thread-workspace-root-hints"]) ? state["thread-workspace-root-hints"] : {};
  const resolveMembership = (thread: CodexThreadState): CodexThreadState => {
    // A populated native catalog membership is newer than legacy sidebar state.
    if (thread.projectId && thread.projectMembership === "assigned")
      return { ...thread, projectId: canonicalId(thread.projectId) };
    if (membership.has(thread.threadId)) return { ...thread, projectId: membership.get(thread.threadId),
      projectMembership: current ? membership.get(thread.threadId) ? "assigned" : "none" : "unknown" };
    if (thread.projectId) return { ...thread, projectId: canonicalId(thread.projectId), projectMembership: thread.projectMembership ?? "assigned" };
    const unassigned = { ...thread, projectMembership: available && current ? "none" as const : "unknown" as const };
    if (!legacyWorkspaceFallback) return unassigned;
    const hint = hints[thread.threadId];
    const cwd = typeof hint === "string" ? hint : thread.cwd;
    if (!cwd) return unassigned;
    // Same boundary-aware root matching used by Desktop's project groups.
    // Ambiguous roots do not invent a membership; the longest unique root wins.
    const matches = roots.filter(({ root }) => cwd === root || cwd.startsWith(`${root.replace(/[\\/]+$/, "")}/`))
      .sort((a, b) => b.root.length - a.root.length);
    const longest = matches[0];
    const ids = new Set(matches.filter(m => m.root.length === longest?.root.length).map(m => m.projectId));
    // Legacy grouping is useful in a catalog but is never access authority.
    return ids.size === 1 ? { ...thread, projectId: longest.projectId, projectMembership: "unknown" } : unassigned;
  };
  return (thread) => {
    const resolved = resolveMembership(thread);
    const pinnedIndex = pins.get(thread.threadId), manualIndex = manualIndexes.get(JSON.stringify([resolved.projectId, thread.threadId]));
    return pinnedIndex === undefined && manualIndex === undefined ? resolved : { ...resolved,
      catalogOrder: { ...resolved.catalogOrder, ...(pinnedIndex !== undefined ? { pinnedIndex } : {}), ...(manualIndex !== undefined ? { manualIndex } : {}) } };
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
