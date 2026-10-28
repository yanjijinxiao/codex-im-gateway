import path from "node:path";
import { z } from "zod";

import { parseCodexExecSandbox, type CodexExecSandbox } from "../codex/sandbox.js";
import type { AppServerConnectionMode } from "../codex/app-server-daemon.js";
import { readJsonObjectFile, writeJsonFile } from "./json-store.js";
import { defaultStateDir, type StatePaths } from "./paths.js";
import { DEFAULT_BINDING_IDLE_DAYS, idleDays } from "./binding-expiry.js";
import { validManagedTaskboardOrigin } from "../taskboard/config.js";

export const MAX_INBOUND_BYTES = 100 * 1024 * 1024;
const LEGACY_DEFAULT_INBOUND_BYTES = 50 * 1024 * 1024;

// Enum/default migrations below are intentionally compatible with older files.
// Operational types and access lists must not reach consumers through a cast:
// a string is iterable too, but it is not a list of complete user identities.
const operationalFields = z.object({
  defaultCwd: z.string().min(1).optional(),
  allowedSenderIds: z.array(z.string().min(1)).optional(),
  allowedWorkspaces: z.array(z.string().min(1)).optional(),
  codexBin: z.string().min(1).optional(),
  model: z.string().optional(), effort: z.string().optional(),
  maxBufferItems: z.number().safe().positive().optional(),
  promptBufferTtlMs: z.number().finite().positive().optional()
}).passthrough();

function validateOperationalFields(value: unknown): asserts value is Partial<CodexImGatewayConfig> {
  const result = operationalFields.safeParse(value);
  if (!result.success) throw new Error(`Invalid configuration field: ${result.error.issues[0]?.path.join(".") || "root"}; original file preserved`);
}

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
  /** Default busy-session policy. A ManagedSession may explicitly override it. */
  activeMessagePolicy: "ask" | "steer" | "queue";
  bindingIdleDays: number;
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
    activeMessagePolicy: "steer",
    bindingIdleDays: DEFAULT_BINDING_IDLE_DAYS,
    maxBufferItems: 50,
    promptBufferTtlMs: 10 * 60_000,
    maxInboundBytes: MAX_INBOUND_BYTES,
    taskboardEnabled: true,
    taskboardUrl: "http://127.0.0.1:47823"
  };
}

export function loadConfig(paths: StatePaths, cwd?: string): CodexImGatewayConfig {
  const base = defaultConfig(cwd ?? paths.root);
  const loaded = readJsonObjectFile<Partial<CodexImGatewayConfig>>(paths.configPath, {});
  validateOperationalFields(loaded);
  const codexExecSandbox = parseCodexExecSandbox(loaded.codexExecSandbox);
  const defaultCwd = path.resolve(loaded.defaultCwd ?? base.defaultCwd);
  const taskboardUrl = typeof loaded.taskboardUrl === "string" && loaded.taskboardUrl.trim() ? loaded.taskboardUrl.trim() : base.taskboardUrl;
  if (!validManagedTaskboardOrigin(taskboardUrl)) throw new Error("Invalid configuration field: taskboardUrl; expected an HTTP IPv4 loopback origin supported by the bundled server");
  return {
    ...base,
    ...loaded,
    defaultCwd,
    codexBackend: normalizeCodexBackend(loaded.codexBackend, base.codexBackend),
    codexAppServerTransport: normalizeAppServerTransport(
      loaded.codexAppServerTransport,
      base.codexAppServerTransport
    ),
    codexExecSandbox,
    streamReplies: typeof loaded.streamReplies === "boolean" ? loaded.streamReplies : base.streamReplies,
    activeMessagePolicy: normalizeActiveMessagePolicy(loaded.activeMessagePolicy),
    bindingIdleDays: idleDays(loaded.bindingIdleDays),
    taskboardEnabled: typeof loaded.taskboardEnabled === "boolean" ? loaded.taskboardEnabled : base.taskboardEnabled,
    taskboardUrl,
    maxInboundBytes: normalizeInboundBytes(loaded.maxInboundBytes, base.maxInboundBytes),
    allowedSenderIds: loaded.allowedSenderIds ?? base.allowedSenderIds,
    allowedWorkspaces: (loaded.allowedWorkspaces?.length ? loaded.allowedWorkspaces : [defaultCwd])
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
  validateOperationalFields(config);
  if (!validManagedTaskboardOrigin(config.taskboardUrl)) throw new Error("Invalid configuration field: taskboardUrl; expected an HTTP IPv4 loopback origin supported by the bundled server");
  writeJsonFile(paths.configPath, {
    ...config,
    activeMessagePolicy: normalizeActiveMessagePolicy(config.activeMessagePolicy),
    bindingIdleDays: idleDays(config.bindingIdleDays),
    maxInboundBytes: normalizeInboundBytes(config.maxInboundBytes, MAX_INBOUND_BYTES)
  });
}

function normalizeActiveMessagePolicy(value: unknown): CodexImGatewayConfig["activeMessagePolicy"] {
  return value === "ask" || value === "queue" ? value : "steer";
}

function normalizeInboundBytes(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const bytes = Math.floor(value);
  if (bytes < 1) return fallback;
  if (bytes === LEGACY_DEFAULT_INBOUND_BYTES) return MAX_INBOUND_BYTES;
  return Math.min(bytes, MAX_INBOUND_BYTES);
}

export function isWorkspaceAllowed(workspace: string, allowedWorkspaces: string[]): boolean {
  const resolved = path.resolve(workspace);
  return allowedWorkspaces.some((allowed) => {
    const root = path.resolve(allowed);
    const relative = path.relative(root, resolved);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}
