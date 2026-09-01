import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AppServerTransport } from "./app-server-transport.js";

export type AppServerConnectionMode = "auto" | "daemon" | "stdio";

export type LocalAppServerTransportOptions = {
  readonly mode?: AppServerConnectionMode;
  readonly codexHome?: string;
  readonly platform?: NodeJS.Platform;
  readonly existsSync?: (target: string) => boolean;
  readonly commandTimeoutMs?: number;
};

/**
 * Selects the managed app-server daemon when the standalone Codex install is
 * present. `auto` keeps source/npm installations working by falling back to a
 * private stdio app-server; `daemon` fails with an actionable preflight error.
 */
export function resolveLocalAppServerTransport(
  options: LocalAppServerTransportOptions = {}
): AppServerTransport | undefined {
  const mode = options.mode ?? "auto";
  if (mode === "stdio") return undefined;

  const platform = options.platform ?? process.platform;
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
  const executable = path.join(
    codexHome,
    "packages",
    "standalone",
    "current",
    platform === "win32" ? "codex.exe" : "codex"
  );
  const existsSync = options.existsSync ?? fs.existsSync;
  if (!existsSync(executable) && mode === "auto") return undefined;

  const ensureAvailable = async () => {
    if (!existsSync(executable)) {
      throw new Error(
        `Codex app-server daemon requires the managed standalone Codex install at ${executable}. ` +
        "Install Codex with the official standalone installer or set codexAppServerTransport to stdio."
      );
    }
    await runCodexDaemonCommand(executable, ["app-server", "daemon", "start"], options.commandTimeoutMs);
  };

  return {
    command: executable,
    args: ["app-server", "proxy"],
    label: "managed-daemon",
    mode: "daemon-proxy",
    prepare: ensureAvailable
  };
}

function runCodexDaemonCommand(command: string, args: readonly string[], timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
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
