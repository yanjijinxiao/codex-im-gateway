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
  args.push(target, remoteRelayCommand());
  return {
    command: options.sshBin ?? "/usr/bin/ssh",
    args,
    label: normalizedHostId,
    mode: "remote-daemon"
  };
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
  const encoded = Buffer.from(REMOTE_APP_SERVER_RELAY, "utf8").toString("base64");
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

// This fixed helper runs on the selected SSH host. It performs only protocol
// translation: stdin/stdout JSONL <-> the Desktop control socket WebSocket.
const REMOTE_APP_SERVER_RELAY = String.raw`
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const socketPath = path.join(process.env.HOME || "", ".codex", "app-server-control", "app-server-control.sock");
let socket;
let buffer = Buffer.alloc(0);
let upgraded = false;
let fragmentOpcode = null;
let fragments = [];
const queued = [];

function fail(error) {
  const detail = error && error.message ? error.message : String(error);
  process.stderr.write("remote Codex Desktop relay failed: " + detail + "\n");
  process.exitCode = 1;
  if (socket && !socket.destroyed) socket.destroy();
}

function frame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function send(line) {
  if (!upgraded) {
    queued.push(line);
    return;
  }
  socket.write(frame(0x1, line));
}

function handleFrame(opcode, final, payload) {
  if (opcode === 0x8) {
    socket.end(frame(0x8, Buffer.alloc(0)));
    return;
  }
  if (opcode === 0x9) {
    socket.write(frame(0xA, payload));
    return;
  }
  if (opcode === 0xA) return;
  if (opcode === 0x1 || opcode === 0x2) {
    fragmentOpcode = opcode;
    fragments = [payload];
  } else if (opcode === 0x0 && fragmentOpcode !== null) {
    fragments.push(payload);
  } else {
    return;
  }
  if (!final) return;
  const complete = Buffer.concat(fragments);
  const completeOpcode = fragmentOpcode;
  fragmentOpcode = null;
  fragments = [];
  if (completeOpcode === 0x1) process.stdout.write(complete.toString("utf8") + "\n");
}

function parseFrames() {
  while (buffer.length >= 2) {
    const first = buffer[0];
    const second = buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      const largeLength = buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) return fail(new Error("WebSocket frame is too large"));
      length = Number(largeLength);
      offset = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskBytes = masked ? 4 : 0;
    if (buffer.length < offset + maskBytes + length) return;
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
    offset += maskBytes;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    buffer = buffer.subarray(offset + length);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    handleFrame(first & 0x0f, (first & 0x80) !== 0, payload);
  }
}

socket = net.createConnection({ path: socketPath });
socket.once("connect", () => {
  const key = crypto.randomBytes(16).toString("base64");
  socket.write([
    "GET / HTTP/1.1",
    "Host: localhost",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: " + key,
    "Sec-WebSocket-Version: 13",
    "",
    ""
  ].join("\r\n"));
});
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!upgraded) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    const headers = buffer.subarray(0, end).toString("utf8");
    buffer = buffer.subarray(end + 4);
    if (!headers.startsWith("HTTP/1.1 101")) return fail(new Error("WebSocket upgrade was rejected: " + headers.split("\r\n")[0]));
    upgraded = true;
    for (const line of queued.splice(0)) send(line);
  }
  parseFrames();
});
socket.on("error", fail);
socket.on("close", () => {
  if (!process.exitCode) process.exitCode = 0;
});

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", send);
lines.on("close", () => {
  if (socket && !socket.destroyed) socket.end(frame(0x8, Buffer.alloc(0)));
});
`;
