import { APP_SERVER_SOCKET_RELAY } from "./app-server-socket-relay.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AppServerTransport } from "./app-server-transport.js";

type DesktopRemoteConnection = {
  readonly hostId?: unknown;
  readonly alias?: unknown;
  readonly hostname?: unknown;
  readonly identity?: unknown;
  readonly sshPort?: unknown;
  readonly user?: unknown;
  readonly username?: unknown;
};

type DesktopGlobalState = {
  readonly "codex-managed-remote-connections"?: unknown;
};

export type RemoteCodexTransportOptions = {
  readonly codexHome?: string;
  readonly sshBin?: string;
};

const REMOTE_HOST_PREFIX = "remote-ssh-discovered:";
const SAFE_SSH_TARGET = /^[A-Za-z0-9._:@%+\-[\]]+$/;

/**
 * Resolves a Codex Desktop host id to an SSH process that relays JSONL stdio
 * to the remote Desktop app-server control WebSocket.
 */
export function resolveRemoteCodexTransport(
  hostId: string,
  options: RemoteCodexTransportOptions = {}
): AppServerTransport {
  const connection = resolveRemoteSshConnection(hostId, options);
  return { command: connection.command, args: [...connection.args, connection.target, remoteRelayCommand()],
    label: hostId.trim(), mode: "remote-daemon" };
}

/** Shared SSH *configuration*, never a shared process/control socket. IDE and
 * Codex retain independent connection lifetimes and failure domains. */
export function resolveRemoteSshConnection(hostId: string, options: RemoteCodexTransportOptions = {}): {
  command: string; args: string[]; target: string;
} {
  const normalizedHostId = hostId.trim();
  if (!normalizedHostId || normalizedHostId === "local") {
    throw new Error("Remote Codex routing requires a remote Desktop host id");
  }

  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
  const connection = readRemoteConnections(codexHome)
    .find((candidate) => stringValue(candidate.hostId) === normalizedHostId);
  const hostFromId = normalizedHostId.startsWith(REMOTE_HOST_PREFIX)
    ? normalizedHostId.slice(REMOTE_HOST_PREFIX.length)
    : undefined;
  const host = stringValue(connection?.alias)
    ?? stringValue(connection?.hostname)
    ?? stringValue(hostFromId);
  const user = stringValue(connection?.user) ?? stringValue(connection?.username);
  const target = user && host && !host.includes("@") ? `${user}@${host}` : host;
  if (!target || !SAFE_SSH_TARGET.test(target)) {
    throw new Error(`Codex Desktop remote host is not routable: ${normalizedHostId}`);
  }

  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2"
  ];
  const port = integerPort(connection?.sshPort);
  if (port) args.push("-p", String(port));
  const identity = stringValue(connection?.identity);
  if (identity) args.push("-i", identity);
  return { command: options.sshBin ?? "/usr/bin/ssh", args, target };
}

function readRemoteConnections(codexHome: string): DesktopRemoteConnection[] {
  for (const name of [".codex-global-state.json", ".codex-global-state.json.bak"]) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(codexHome, name), "utf8")) as DesktopGlobalState;
      const connections = state["codex-managed-remote-connections"];
      if (Array.isArray(connections)) {
        return connections.filter((value): value is DesktopRemoteConnection => isRecord(value));
      }
    } catch {
      // Desktop replaces the registry atomically; try the backup next.
    }
  }
  return [];
}

function remoteRelayCommand(): string {
  const encoded = Buffer.from(APP_SERVER_SOCKET_RELAY, "utf8").toString("base64");
  return `exec node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerPort(value: unknown): number | undefined {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
