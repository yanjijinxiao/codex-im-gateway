import type { CodexThreadState } from "../codex/backend.js";
import type { CodexProjectCandidate } from "../server/codex-projects.js";
import type { ManagedProject } from "../state/runtime-state.js";
import { compactTableCell } from "../channels/table.js";

export type SessionCatalogRow = {
  state: CodexThreadState;
  hostId: string;
  group?: { id: string; hostId: string; name: string; label: string; current: boolean };
};

const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function sessionHostLabel(hostId: string): string {
  return hostId === "local" ? "本机" : hostId.replace(/^remote-ssh-discovered:/, "");
}

/** Pure presentation snapshot. Never infer App membership from cwd, register a project or bind a session. */
export function orderSessionCatalog(
  rows: readonly SessionCatalogRow[],
  catalog: readonly CodexProjectCandidate[],
  managed: readonly ManagedProject[],
  active?: ManagedProject
): SessionCatalogRow[] {
  const groups = new Map<string, NonNullable<SessionCatalogRow["group"]>>();
  const result = rows.map(row => {
    const projectId = row.state.projectId || row.state.workspaceProjectId;
    if (!projectId) return { state: row.state, hostId: row.hostId };
    const id = JSON.stringify([row.hostId, projectId]);
    let group = groups.get(id);
    if (!group) {
      const sameHost = (hostId?: string) => (hostId ?? "local") === row.hostId;
      const candidate = catalog.find(p => sameHost(p.hostId) && p.projectId === projectId);
      const bound = managed.find(p => sameHost(p.hostId) && p.sourceProjectId === projectId)
        ?? managed.find(p => sameHost(p.hostId) && !p.sourceProjectId && p.workspace === (candidate?.workspace ?? row.state.cwd));
      const name = candidate?.name || bound?.name || `项目 ${projectId}`;
      const current = Boolean(active && sameHost(active.hostId) && (active.sourceProjectId
        ? active.sourceProjectId === projectId : active.id === bound?.id));
      group = { id, hostId: row.hostId, name, label: compactTableCell(name, row.hostId === "local" ? 18 : 12), current };
      groups.set(id, group);
    }
    return { state: row.state, hostId: row.hostId, group };
  });
  // Disambiguate equal names (including truncation collisions) without putting long paths in every row.
  const orderedGroups = [...groups.values()].sort((a,b) => compareId(a.id, b.id));
  const labels = new Map<string, typeof orderedGroups>();
  for (const group of orderedGroups) labels.set(group.label, [...(labels.get(group.label) ?? []), group]);
  for (const group of orderedGroups) {
    const siblings = labels.get(group.label)!;
    const hostId = group.hostId;
    const suffix = siblings.length > 1 ? ` #${siblings.indexOf(group) + 1}` : "";
    group.label = hostId === "local"
      ? compactTableCell(group.name, 18) + suffix
      : `${compactTableCell(group.name, 12)}${suffix} · ${compactTableCell(sessionHostLabel(hostId), 15)}`;
  }
  const catalogOrder = new Map(catalog.map((p, i) => [JSON.stringify([p.hostId ?? "local", p.projectId]), i]));
  return result.sort((a,b) => {
    const pinA = a.state.catalogOrder?.pinnedIndex, pinB = b.state.catalogOrder?.pinnedIndex;
    if (pinA !== undefined || pinB !== undefined) return (pinA ?? Number.MAX_SAFE_INTEGER) - (pinB ?? Number.MAX_SAFE_INTEGER)
      || compareId(a.hostId, b.hostId) || compareId(a.state.threadId, b.state.threadId);
    const rank = (row: SessionCatalogRow) => row.group ? 0 : 1;
    const priority = rank(a) - rank(b);
    if (priority) return priority;
    if (a.group && b.group && a.group.id !== b.group.id) {
      return (catalogOrder.get(a.group.id) ?? Number.MAX_SAFE_INTEGER) - (catalogOrder.get(b.group.id) ?? Number.MAX_SAFE_INTEGER)
        || compareId(a.group.id, b.group.id);
    }
    const indexA = a.state.catalogOrder?.manualIndex, indexB = b.state.catalogOrder?.manualIndex;
    if (indexA !== undefined || indexB !== undefined) {
      const manual = (indexA ?? Number.MAX_SAFE_INTEGER) - (indexB ?? Number.MAX_SAFE_INTEGER);
      if (manual) return manual;
    }
    const recency = (row: SessionCatalogRow) => row.state.catalogOrder?.recency
      ?? (Date.parse(row.state.updatedAt ?? "") / 1000 || 0);
    return recency(b) - recency(a) || compareId(b.state.updatedAt ?? "", a.state.updatedAt ?? "")
      || compareId(a.hostId, b.hostId) || compareId(a.state.threadId, b.state.threadId);
  });
}
