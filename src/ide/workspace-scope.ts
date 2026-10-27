import crypto from "node:crypto";
import type { IDEWorkspace } from "./manager.js";

/** Security identity excludes labels and alias ordering. Directory expansion,
 * host/owner/project changes still require a new browser grant. */
export function workspaceAuthorizationScope(target: IDEWorkspace): string {
  return "v2:" + crypto.createHash("sha256").update(JSON.stringify([
    target.owner, target.hostId, target.projectId ?? null, target.workspace,
    [...new Set(target.rootPaths ?? [target.workspace])].sort()
  ])).digest("hex");
}
export function legacyWorkspaceScope(target: IDEWorkspace): string {
  return crypto.createHash("sha256").update(JSON.stringify(target)).digest("hex");
}
