import path from "node:path";
import fs from "node:fs";

type NativeProject = { workspace: string; hostId?: string; projectId?: string };
type ManagedProjectIdentity = { workspace: string; hostId?: string; sourceProjectId?: string };

/** Paths describe locations, not native identities. Root-only legacy records
 * may acquire an ID only from a unique same-host catalog observation. */
export function nativeProjectForManaged<T extends NativeProject>(project: ManagedProjectIdentity, candidates: readonly T[], managed: readonly ManagedProjectIdentity[] = []): T | undefined {
  const sameHost = candidates.filter(item => (item.hostId ?? "local") === (project.hostId ?? "local"));
  const matches = project.sourceProjectId
    ? sameHost.filter(item => item.projectId === project.sourceProjectId)
    : sameHost.filter(item => path.resolve(item.workspace) === path.resolve(project.workspace));
  if (matches.length !== 1) return undefined;
  const candidate = matches[0];
  if (!project.sourceProjectId && candidate.projectId && managed.some(other => other.sourceProjectId === candidate.projectId
    && (other.hostId ?? "local") === (candidate.hostId ?? "local"))) return undefined;
  return candidate;
}

export function managedProjectForNative<T extends ManagedProjectIdentity>(candidate: NativeProject, projects: readonly T[]): T | undefined {
  const sameHost = projects.filter(project => (project.hostId ?? "local") === (candidate.hostId ?? "local"));
  const matches = candidate.projectId
    ? sameHost.filter(project => project.sourceProjectId === candidate.projectId)
    : sameHost.filter(project => !project.sourceProjectId && path.resolve(project.workspace) === path.resolve(candidate.workspace));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Legacy local services expose only a cwd. Refuse to invent a host/native
 * identity when that location names more than one managed project identity. */
export function localProjectsAtWorkspace<T extends ManagedProjectIdentity>(workspace: string, projects: readonly T[]): T[] {
  const canonical = (value: string) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  const root = canonical(workspace);
  const matches = projects.filter(project => (project.hostId ?? "local") === "local"
    && canonical(project.workspace) === root);
  const identities = new Set(matches.map(project => JSON.stringify(project.sourceProjectId
    ? ["native", project.sourceProjectId] : ["legacy", canonical(project.workspace)])));
  return identities.size === 1 ? matches : [];
}
