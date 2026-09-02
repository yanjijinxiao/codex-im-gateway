import path from "node:path";

import { parseCodexExecSandbox, type CodexExecSandbox } from "../codex/sandbox.js";
import type { AppServerConnectionMode } from "../codex/app-server-daemon.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import { defaultStateDir, type StatePaths } from "./paths.js";

export const MAX_INBOUND_BYTES = 100 * 1024 * 1024;
const LEGACY_DEFAULT_INBOUND_BYTES = 50 * 1024 * 1024;

export type CodexImGatewayConfig = {
  defaultCwd: string;
  allowedSenderIds: string[];
  allowedWorkspaces: string[];
  codexBin: string;
  codexBackend: "auto" | "app-server" | "exec";
  codexAppServerTransport: AppServerConnectionMode;
  codexExecSandbox?: CodexExecSandbox;
  model?: string;
  effort?: string;
  streamReplies: boolean;
  maxBufferItems: number;
  promptBufferTtlMs: number;
  maxInboundBytes: number;
  taskboardEnabled: boolean;
  taskboardUrl: string;
};

/** @deprecated Use CodexImGatewayConfig. */
export type CodexWeixinConfig = CodexImGatewayConfig;

export function defaultConfig(cwd = defaultStateDir()): CodexImGatewayConfig {
  return {
    defaultCwd: path.resolve(cwd),
    allowedSenderIds: [],
    allowedWorkspaces: [path.resolve(cwd)],
    codexBin: "codex",
    codexBackend: "auto",
    codexAppServerTransport: "auto",
    streamReplies: true,
    maxBufferItems: 50,
    promptBufferTtlMs: 10 * 60_000,
    maxInboundBytes: MAX_INBOUND_BYTES,
    taskboardEnabled: true,
    taskboardUrl: "http://127.0.0.1:47823"
  };
}

export function loadConfig(paths: StatePaths, cwd?: string): CodexImGatewayConfig {
  const base = defaultConfig(cwd ?? paths.root);
  const loaded = readJsonFile<Partial<CodexImGatewayConfig>>(paths.configPath, {});
  const codexExecSandbox = parseCodexExecSandbox(loaded.codexExecSandbox);
  return {
    ...base,
    ...loaded,
    codexBackend: normalizeCodexBackend(loaded.codexBackend, base.codexBackend),
    codexAppServerTransport: normalizeAppServerTransport(
      loaded.codexAppServerTransport,
      base.codexAppServerTransport
    ),
    codexExecSandbox,
    streamReplies: typeof loaded.streamReplies === "boolean" ? loaded.streamReplies : base.streamReplies,
    taskboardEnabled: typeof loaded.taskboardEnabled === "boolean" ? loaded.taskboardEnabled : base.taskboardEnabled,
    taskboardUrl: typeof loaded.taskboardUrl === "string" && loaded.taskboardUrl.trim()
      ? loaded.taskboardUrl.trim()
      : base.taskboardUrl,
    maxInboundBytes: normalizeInboundBytes(loaded.maxInboundBytes, base.maxInboundBytes),
    allowedSenderIds: loaded.allowedSenderIds ?? base.allowedSenderIds,
    allowedWorkspaces: (loaded.allowedWorkspaces?.length ? loaded.allowedWorkspaces : base.allowedWorkspaces)
      .map((workspace) => path.resolve(workspace))
  };
}

function normalizeCodexBackend(
  value: unknown,
  fallback: CodexImGatewayConfig["codexBackend"]
): CodexImGatewayConfig["codexBackend"] {
  return value === "auto" || value === "app-server" || value === "exec" ? value : fallback;
}

function normalizeAppServerTransport(
  value: unknown,
  fallback: AppServerConnectionMode
): AppServerConnectionMode {
  return value === "auto" || value === "daemon" || value === "stdio" ? value : fallback;
}

export function saveConfig(paths: StatePaths, config: CodexImGatewayConfig): void {
  writeJsonFile(paths.configPath, {
    ...config,
    maxInboundBytes: normalizeInboundBytes(config.maxInboundBytes, MAX_INBOUND_BYTES)
  });
}

function normalizeInboundBytes(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const bytes = Math.floor(value);
  if (bytes === LEGACY_DEFAULT_INBOUND_BYTES) return MAX_INBOUND_BYTES;
  return Math.min(bytes, MAX_INBOUND_BYTES);
}

export function isWorkspaceAllowed(workspace: string, allowedWorkspaces: string[]): boolean {
  const resolved = path.resolve(workspace);
  return allowedWorkspaces.some((allowed) => {
    const root = path.resolve(allowed);
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
