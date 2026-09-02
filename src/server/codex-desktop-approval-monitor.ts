import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  isAppServerApprovalMethod,
  parseAppServerApproval,
  type AppServerApprovalMethod,
  type CodexApprovalDecision,
  type CodexApprovalRequest
} from "../codex/approval.js";

const IPC_MESSAGE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;

export type CodexDesktopApproval = {
  requestId: string | number;
  method: AppServerApprovalMethod;
  request: CodexApprovalRequest;
};

export type CodexDesktopApprovalMonitorOptions = {
  socketPath?: string;
  reconnectDelayMs?: number;
  onApproval: (approval: CodexDesktopApproval) => Promise<CodexApprovalDecision | undefined>;
};

type IpcMessage = Record<string, unknown>;

export class CodexDesktopApprovalMonitor {
  private readonly socketPath: string;
  private readonly reconnectDelayMs: number;
  private readonly followedThreads = new Set<string>();
  private readonly handledRequests = new Set<string>();
  private socket?: net.Socket;
  private reconnectTimer?: NodeJS.Timeout;
  private clientId?: string;
  private buffer = Buffer.alloc(0);
  private started = false;

  constructor(private readonly options: CodexDesktopApprovalMonitorOptions) {
    this.socketPath = options.socketPath ?? path.join(os.homedir(), ".codex", "ipc", "ipc.sock");
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.clientId = undefined;
    this.buffer = Buffer.alloc(0);
  }

  followThread(threadId: string): void {
    if (!threadId.trim()) return;
    this.followedThreads.add(threadId);
    if (this.clientId) this.sendFollow(threadId, true);
  }

  private connect(): void {
    if (!this.started || this.socket) return;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.on("connect", () => this.initialize());
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (error) => {
      if (!isMissingSocketError(error)) {
        console.warn(`[codex-im-gateway] Codex Desktop approval IPC error: ${error.message}`);
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.clientId = undefined;
      this.buffer = Buffer.alloc(0);
      this.scheduleReconnect();
    });
  }

  private initialize(): void {
    this.send({
      type: "request",
      requestId: crypto.randomUUID(),
      sourceClientId: "initializing-client",
      version: 0,
      method: "initialize",
      params: { clientType: "codex-im-gateway" }
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > IPC_MESSAGE_MAX_BYTES) {
        console.error(`[codex-im-gateway] rejected oversized Codex Desktop IPC message: ${length} bytes`);
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try {
        this.handleMessage(JSON.parse(payload.toString("utf8")) as IpcMessage);
      } catch (error) {
        console.warn(`[codex-im-gateway] ignored invalid Codex Desktop IPC message: ${String(error)}`);
      }
    }
  }

  private handleMessage(message: IpcMessage): void {
    if (message.type === "client-discovery-request" && typeof message.requestId === "string") {
      this.send({
        type: "client-discovery-response",
        requestId: message.requestId,
        sourceClientId: this.clientId,
        response: { canHandle: false }
      });
      return;
    }
    if (message.type === "response" && message.method === "initialize") {
      const result = recordValue(message.result);
      const clientId = stringValue(result?.clientId);
      if (!clientId) return;
      this.clientId = clientId;
      console.log("[codex-im-gateway] connected to Codex Desktop approval stream");
      for (const threadId of this.followedThreads) this.sendFollow(threadId, true);
      return;
    }
    if (message.type !== "broadcast" || message.method !== "thread-stream-state-changed") return;
    const params = recordValue(message.params);
    const threadId = stringValue(params?.conversationId);
    const change = recordValue(params?.change);
    if (!threadId || !change || !this.followedThreads.has(threadId)) return;
    if (change.type === "snapshot") {
      const state = recordValue(change.conversationState);
      this.processRequests(threadId, state?.requests, stringValue(state?.cwd));
      return;
    }
    if (change.type !== "patches" || !Array.isArray(change.patches)) return;
    for (const patch of change.patches) {
      const record = recordValue(patch);
      const patchPath = Array.isArray(record?.path) ? record.path : [];
      if (patchPath.length === 1 && patchPath[0] === "requests") {
        this.processRequests(threadId, record?.value);
      }
    }
  }

  private processRequests(threadId: string, value: unknown, cwd?: string): void {
    if (!Array.isArray(value)) return;
    for (const raw of value) {
      const envelope = recordValue(raw);
      const method = stringValue(envelope?.method);
      const requestId = requestIdValue(envelope?.id);
      const params = recordValue(envelope?.params);
      if (!isAppServerApprovalMethod(method) || requestId === undefined || !params) continue;
      const request = parseAppServerApproval(method, params);
      if (!request) continue;
      const key = `${threadId}\n${String(requestId)}`;
      if (this.handledRequests.has(key)) continue;
      this.handledRequests.add(key);
      const normalized = { ...request, ...(request.cwd || !cwd ? {} : { cwd }) };
      void this.forwardApproval({ requestId, method, request: normalized }).catch((error) => {
        console.error(`[codex-im-gateway] unable to forward Codex Desktop approval: ${String(error)}`);
      });
    }
  }

  private async forwardApproval(approval: CodexDesktopApproval): Promise<void> {
    const decision = await this.options.onApproval(approval);
    if (!decision || !this.clientId) return;
    const method = approval.method === "item/commandExecution/requestApproval"
      ? "thread-follower-command-approval-decision"
      : approval.method === "item/fileChange/requestApproval"
        ? "thread-follower-file-approval-decision"
        : "thread-follower-permissions-request-approval-response";
    const params = approval.method === "item/permissions/requestApproval"
      ? {
          conversationId: approval.request.threadId,
          requestId: approval.requestId,
          response: {
            permissions: decision === "accept" ? approval.request.permissions ?? {} : {},
            scope: "turn"
          }
        }
      : {
          conversationId: approval.request.threadId,
          requestId: approval.requestId,
          decision
        };
    this.send({
      type: "request",
      requestId: crypto.randomUUID(),
      sourceClientId: this.clientId,
      version: 1,
      method,
      params
    });
  }

  private sendFollow(threadId: string, following: boolean): void {
    this.send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: this.clientId,
      params: { conversationId: threadId, hostId: "local", following },
      version: 1
    });
  }

  private send(message: IpcMessage): void {
    if (!this.socket?.writable) return;
    const payload = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requestIdValue(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isMissingSocketError(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ECONNREFUSED";
}
