import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeAccountId } from "../weixin/accounts.js";

export function defaultStateDir(): string {
  return path.join(os.homedir(), ".codex-im-gateway");
}

/**
 * Reuses an existing installation before choosing the new canonical path.
 * Explicit CODEX_IM_GATEWAY_STATE_DIR / legacy environment variables still
 * take precedence in the server entry point.
 */
export function preferredStateDir(home = os.homedir()): string {
  const candidates = [
    path.join(home, ".codex-im-gateway"),
    path.join(home, ".codex-channel-bridge"),
    path.join(home, ".codex-weixin")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export type StatePaths = {
  root: string;
  accountsDir: string;
  retainedAccountsPath: string;
  configPath: string;
  statePath: string;
  inboundDir: string;
  logsDir: string;
  runtimeDir: string;
  taskboardDir: string;
};

export function resolveStatePaths(root = defaultStateDir()): StatePaths {
  return {
    root,
    accountsDir: path.join(root, "accounts"),
    retainedAccountsPath: path.join(root, "retained-accounts.json"),
    configPath: path.join(root, "config.json"),
    statePath: path.join(root, "state.json"),
    inboundDir: path.join(root, "inbound"),
    logsDir: path.join(root, "logs"),
    runtimeDir: path.join(root, "runtime"),
    taskboardDir: path.join(root, "taskboard")
  };
}

export function accountStatePaths(paths: StatePaths, accountId: string): StatePaths {
  const safeId = normalizeAccountId(accountId);
  const accountRoot = path.join(paths.runtimeDir, safeId);
  return {
    ...paths,
    statePath: path.join(accountRoot, "state.json"),
    inboundDir: path.join(paths.inboundDir, safeId),
    logsDir: path.join(paths.logsDir, safeId)
  };
}
