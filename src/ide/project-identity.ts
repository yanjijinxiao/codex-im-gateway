import path from "node:path";
import type { CodexProject } from "../codex/backend.js";

type DesktopProject = { projectId?: string; hostId?: string; workspace: string; rootPaths?: readonly string[]; available?: boolean };
/** Bridge two independently assigned project IDs only after the backend has
 * confirmed the exact native ID. Never use a session cwd or a partial root. */
export function desktopIDEProjectId(native: Pick<CodexProject, "id" | "roots">, hostId: string, projects: readonly DesktopProject[]): string | undefined {
  const roots = rootKey(native.roots);
  if (!roots) return;
  const matches = new Set(projects.filter(project => project.projectId && project.available !== false
    && (project.hostId ?? "local") === hostId && rootKey(project.rootPaths ?? [project.workspace]) === roots).map(project => project.projectId!));
  return matches.size === 1 ? [...matches][0] : undefined;
}
function rootKey(roots: readonly string[]): string | undefined {
  if (!roots.length || roots.length > 32 || roots.some(root => !path.posix.isAbsolute(root) || /[\r\n\0]/.test(root))) return;
  const normalized = roots.map(root => path.posix.normalize(root));
  if (new Set(normalized).size !== normalized.length) return;
  return JSON.stringify(normalized.sort());
}
