import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AppServerTransport } from "./app-server-transport.js";
import { resolveCodexCommand } from "./exec-runner.js";
import { APP_SERVER_SOCKET_RELAY } from "./app-server-socket-relay.js";

export type AppServerConnectionMode = "auto" | "daemon" | "stdio";

export type LocalAppServerTransportOptions = {
  readonly codexBin?: string;
  readonly mode?: AppServerConnectionMode;
  readonly codexHome?: string;
  readonly platform?: NodeJS.Platform;
  readonly existsSync?: (target: string) => boolean;
  readonly commandTimeoutMs?: number;
};

/**
 * Connects to the independent managed daemon using the native CLI (standalone
 * or explicitly configured). Custom script/test commands can opt into stdio;
 * daemon initialization failure must never silently create a private executor.
 */
export function resolveLocalAppServerTransport(
  options: LocalAppServerTransportOptions = {}
): AppServerTransport | undefined {
  const mode = options.mode ?? "auto";
  if (mode === "stdio") return undefined;

  const platform = options.platform ?? process.platform;
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
  const managedExecutable = path.join(
    codexHome,
    "packages",
    "standalone",
    "current",
    platform === "win32" ? "codex.exe" : "codex"
  );
  const existsSync = options.existsSync ?? fs.existsSync;
  const managed = existsSync(managedExecutable);
  if (!managed && !options.codexBin && mode === "auto") return undefined;
  const executable = managed ? managedExecutable : options.codexBin ?? managedExecutable;
  const command = resolveCodexCommand(executable);

  const ensureAvailable = async () => {
    if (!managed && !options.codexBin) {
      throw new Error(
        `Codex app-server daemon requires the managed standalone Codex install at ${executable}. ` +
        "Install Codex with the official standalone installer or set codexAppServerTransport to stdio."
      );
    }
    await runCodexDaemonCommand(command.command, [...command.argsPrefix, "app-server", "daemon", "start"], options.commandTimeoutMs, codexHome);
  };

  return {
    command: process.execPath,
    args: ["-e", APP_SERVER_SOCKET_RELAY, path.join(codexHome, "app-server-control", "app-server-control.sock")],
    label: managed ? "managed-daemon" : "configured-daemon",
    mode: "daemon-proxy",
    prepare: ensureAvailable
  };
}

function runCodexDaemonCommand(command: string, args: readonly string[], timeoutMs = 30_000, codexHome?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(codexHome ? { env: { ...process.env, CODEX_HOME: codexHome } } : {}),
      shell: false,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex app-server daemon command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat([...stderr, ...stdout]).toString("utf8").trim();
      reject(new Error(`Unable to start Codex app-server daemon (exit ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
    });
  });
}
