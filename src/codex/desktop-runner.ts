import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CodexInterventionError } from "./backend.js";

import type {
  CodexRunResult,
  CodexRunnerInput,
  CodexSteerInput,
  CodexSteerResult,
  CodexStopResult,
  CodexThreadContinuation
} from "./backend.js";
import {
  CodexSessionCompletionMonitor,
  type CodexSessionActivity,
  type CodexSessionCompletion
} from "../server/codex-session-monitor.js";

const IPC_MESSAGE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

type IpcMessage = Record<string, unknown>;

export type DesktopCodexRunnerOptions = {
  socketPath?: string;
  codexHome?: string;
  timeoutMs?: number;
  completionPollIntervalMs?: number;
  busyRetryDelayMs?: number;
};

type CompletionWaiter = {
  resolve: (completion: CodexSessionCompletion) => void;
  reject: (error: Error) => void;
  onProgress?: (message: string) => Promise<void> | void;
  chain: Promise<void>;
};

/**
 * Relays turns to the Codex Desktop process that already owns a thread.
 *
 * Codex app-server deliberately permits only one writer for a thread. When a
 * Desktop task is selected in a chat channel, a second app-server therefore
 * cannot resume it directly. Desktop exposes a local follower IPC protocol for
 * exactly this case. The final result is read from Codex's session log so the
 * channel receives the same final answer as Desktop.
 */
export class DesktopCodexRunner implements CodexThreadContinuation {
  readonly id = "desktop-relay" as const;
  private readonly socketPath: string;
  private readonly requestTimeoutMs: number;
  private readonly busyRetryDelayMs: number;
  private readonly completions = new Map<string, CodexSessionCompletion>();
  private readonly activities = new Map<string, CodexSessionActivity[]>();
  private readonly waiters = new Map<string, CompletionWaiter>();
  private readonly activeThreads = new Set<string>();
  private readonly monitor: CodexSessionCompletionMonitor;
  private monitorStarted = false;
  private closed = false;

  constructor(options: DesktopCodexRunnerOptions = {}) {
    this.socketPath = options.socketPath ?? path.join(os.homedir(), ".codex", "ipc", "ipc.sock");
    this.requestTimeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.busyRetryDelayMs = options.busyRetryDelayMs ?? 1_000;
    this.monitor = new CodexSessionCompletionMonitor({
      codexHome: options.codexHome,
      pollIntervalMs: options.completionPollIntervalMs ?? 1_000,
      onCompletion: (completion) => this.handleCompletion(completion),
      onActivity: (activity) => this.handleActivity(activity)
    });
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    if (this.closed) throw new Error("Codex Desktop runner is closed");
    if (!input.threadId) throw new Error("Codex Desktop relay requires an existing thread id");
    if (input.dynamicTools?.length || input.onDynamicToolCall) {
      throw new Error("Codex Desktop relay does not support dynamic bridge tools for an existing Desktop-owned thread");
    }

    this.activeThreads.add(input.threadId);
    try {
      await this.ensureMonitorReady();
      await input.onProgress?.("当前会话由 Codex Desktop 持有，已转交桌面端继续执行。");
      const request = compactObject({
        threadId: input.threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.cwd,
        approvalPolicy: input.onApproval ? "on-request" : "never",
        sandboxPolicy: appServerSandboxPolicy(input.sandbox),
        model: input.model,
        effort: input.effort,
        outputSchema: input.outputSchema,
        ...(input.collaborationMode ? {
          collaborationMode: {
            mode: input.collaborationMode,
            settings: {
              model: input.model ?? null,
              reasoning_effort: input.effort ?? null,
              developer_instructions: null
            }
          }
        } : {})
      });
      let queuedNoticeSent = false;
      let response: unknown;
      while (response === undefined) {
        if (this.closed) throw new Error("Codex Desktop runner is closed");
        try {
          response = await sendFollowerStartTurn({
            socketPath: this.socketPath,
            timeoutMs: this.requestTimeoutMs,
            threadId: input.threadId,
            request
          });
        } catch (error) {
          if (!isDesktopTurnBusyError(error)) throw error;
          if (!queuedNoticeSent) {
            queuedNoticeSent = true;
            await input.onProgress?.("当前会话的上一条任务仍在处理中，已加入队列。");
          }
          await delay(this.busyRetryDelayMs);
        }
      }
      const turnId = followerTurnId(response);
      if (!turnId) {
        throw new Error("Codex Desktop accepted the message but did not return a turn id");
      }
      await input.onTurnStarted?.({ threadId: input.threadId, turnId });
      const completion = await this.waitForCompletion(input.threadId, turnId, input.onProgress);
      if (!completion.success) throw new Error(completion.text);
      return {
        threadId: input.threadId,
        turnId,
        text: completion.text,
        raw: JSON.stringify(completion)
      };
    } finally {
      this.activeThreads.delete(input.threadId);
    }
  }

  async stop(threadId?: string, expectedTurnId?: string): Promise<CodexStopResult> {
    const target = threadId
      ? (expectedTurnId || this.activeThreads.has(threadId) ? threadId : undefined)
      : [...this.activeThreads].at(-1);
    if (!target) return "not-active";
    await sendFollowerInterrupt({
      socketPath: this.socketPath,
      timeoutMs: Math.min(this.requestTimeoutMs, 30_000),
      threadId: target,
      expectedTurnId
    });
    return "interrupted";
  }

  async steer(input: CodexSteerInput): Promise<CodexSteerResult> {
    if (this.closed) throw new Error("Codex Desktop runner is closed");
    // Desktop follower v1 chooses (and may retry against) its own active turn.
    // It ignores expectedTurnId, so even a read-before-write check is unsafe.
    // Only the shared daemon's official turn/steer can enforce this guard.
    throw new CodexInterventionError("当前 Desktop 转发协议不支持指定任务的安全介入。请使用 /queue 排到下一轮，或通过共享 App Server 后端介入。");
  }

  /**
   * Tells an already-running Codex Desktop window that its task catalog is stale.
   *
   * A separate app-server process persists the thread in the shared state DB,
   * but it cannot emit lifecycle notifications on Desktop's own app-server
   * connection. For a newly active thread, the unarchive lifecycle broadcast
   * makes Desktop hydrate the thread into its in-memory catalog. The query
   * invalidation remains as a compatibility fallback for renderer versions
   * that read the state DB directly.
   */
  async refreshTaskList(threadId?: string): Promise<void> {
    if (this.closed) return;
    const connection = new DesktopIpcConnection(this.socketPath, this.requestTimeoutMs);
    try {
      await connection.initialize();
      if (threadId) {
        await connection.broadcast("thread-unarchived", 1, {
          conversationId: threadId,
          hostId: "local"
        });
      }
      await connection.broadcast("query-cache-invalidate", 0, {
        queryKey: ["tasks"]
      });
    } finally {
      connection.close();
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.values()) {
      waiter.reject(new Error("Codex Desktop runner closed"));
    }
    this.waiters.clear();
    this.activities.clear();
    void this.monitor.stop();
  }

  private async ensureMonitorReady(): Promise<void> {
    if (!this.monitorStarted) {
      this.monitorStarted = true;
      this.monitor.start();
    }
    await this.monitor.ready();
  }

  private waitForCompletion(
    threadId: string,
    turnId: string,
    onProgress?: (message: string) => Promise<void> | void
  ): Promise<CodexSessionCompletion> {
    const key = turnKey(threadId, turnId);
    const completed = this.completions.get(key);
    if (completed) {
      this.completions.delete(key);
      const waiter: CompletionWaiter = {
        resolve: () => undefined,
        reject: () => undefined,
        onProgress,
        chain: Promise.resolve()
      };
      for (const activity of this.activities.get(key) ?? []) this.enqueueActivity(waiter, activity.text);
      this.activities.delete(key);
      return waiter.chain.then(() => completed);
    }
    return new Promise((resolve, reject) => {
      const waiter: CompletionWaiter = { resolve, reject, onProgress, chain: Promise.resolve() };
      this.waiters.set(key, waiter);
      for (const activity of this.activities.get(key) ?? []) this.enqueueActivity(waiter, activity.text);
      this.activities.delete(key);
    });
  }

  private handleActivity(activity: CodexSessionActivity): void {
    const key = turnKey(activity.sessionId, activity.turnId);
    console.log(
      `[codex-im-gateway] Desktop progress ${activity.turnId}: ${oneLineProgress(activity.text, 180)}`
    );
    const waiter = this.waiters.get(key);
    if (waiter) {
      this.enqueueActivity(waiter, activity.text);
      return;
    }
    if (!this.activeThreads.has(activity.sessionId)) return;
    const queued = this.activities.get(key) ?? [];
    queued.push(activity);
    this.activities.set(key, queued.slice(-20));
    if (this.activities.size > 100) this.activities.delete(this.activities.keys().next().value as string);
  }

  private enqueueActivity(waiter: CompletionWaiter, text: string): void {
    if (!waiter.onProgress) return;
    waiter.chain = waiter.chain
      .then(() => waiter.onProgress?.(text))
      .then(() => undefined)
      .catch((error) => {
        console.warn(`[codex-im-gateway] unable to stream Desktop progress: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private handleCompletion(completion: CodexSessionCompletion): void {
    const key = turnKey(completion.sessionId, completion.turnId);
    const waiter = this.waiters.get(key);
    if (!waiter) {
      this.completions.set(key, completion);
      if (this.completions.size > 100) this.completions.delete(this.completions.keys().next().value as string);
      return;
    }
    this.waiters.delete(key);
    void waiter.chain.then(() => waiter.resolve(completion));
  }
}

function oneLineProgress(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

type FollowerRequest = {
  socketPath: string;
  timeoutMs: number;
  threadId: string;
  request: Record<string, unknown>;
};

async function sendFollowerStartTurn(input: FollowerRequest): Promise<unknown> {
  const connection = new DesktopIpcConnection(input.socketPath, input.timeoutMs);
  try {
    await connection.initialize();
    await connection.request("thread-owner-discovery", 1, {
      conversationId: input.threadId,
      hostId: "local"
    });
    await connection.broadcast("thread-stream-following-changed", 1, {
      conversationId: input.threadId,
      hostId: "local",
      following: true
    });
    return await connection.request("thread-follower-start-turn", 2, {
      conversationId: input.threadId,
      turnStart: {
        request: input.request,
        context: {
          inheritThreadSettings: false,
          useAppServerPermissionDefault: true,
          usePermissionSelection: false
        }
      }
    });
  } finally {
    connection.close();
  }
}

async function sendFollowerInterrupt(input: Omit<FollowerRequest, "request"> & { expectedTurnId?: string }): Promise<void> {
  const connection = new DesktopIpcConnection(input.socketPath, input.timeoutMs);
  try {
    await connection.initialize();
    // Protocol v3 is the compatibility form used when no expected turn id is
    // available. V4 requires a concrete expectedTurnId.
    await connection.request("thread-follower-interrupt-turn", input.expectedTurnId ? 4 : 3, {
      conversationId: input.threadId,
      ...(input.expectedTurnId ? { expectedTurnId: input.expectedTurnId } : {})
    });
  } finally {
    connection.close();
  }
}

class DesktopIpcConnection {
  private socket?: net.Socket;
  private clientId = "initializing-client";
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number
  ) {}

  async initialize(): Promise<void> {
    await this.connect();
    const result = recordValue(await this.request("initialize", 0, {
      clientType: "codex-im-gateway"
    }));
    const clientId = stringValue(result?.clientId);
    if (!clientId) throw new Error("Codex Desktop IPC initialize response did not include a client id");
    this.clientId = clientId;
  }

  request(method: string, version: number, params: Record<string, unknown>): Promise<unknown> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(requestId, { method, resolve, reject, timer });
      try {
        this.send({
          type: "request",
          requestId,
          sourceClientId: this.clientId,
          version,
          method,
          params
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  broadcast(method: string, version: number, params: Record<string, unknown>): Promise<void> {
    return this.sendAndFlush({ type: "broadcast", sourceClientId: this.clientId, version, method, params });
  }

  close(): void {
    const error = new Error("Codex Desktop IPC connection closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = undefined;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Codex Desktop IPC connection timed out after ${this.timeoutMs}ms`));
      }, Math.min(this.timeoutMs, 30_000));
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Unable to connect to Codex Desktop IPC: ${error.message}`));
      });
      socket.on("data", (chunk) => this.receive(chunk));
      socket.on("close", () => {
        if (!this.pending.size) return;
        const error = new Error("Codex Desktop IPC connection closed before the response arrived");
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
      });
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > IPC_MESSAGE_MAX_BYTES) {
        this.socket?.destroy(new Error(`Rejected oversized Codex Desktop IPC message: ${length} bytes`));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let message: IpcMessage;
      try {
        message = JSON.parse(payload.toString("utf8")) as IpcMessage;
      } catch {
        continue;
      }
      this.handleMessage(message);
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
    if (message.type !== "response" || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.resultType === "error" || message.error) {
      pending.reject(new Error(`Codex Desktop IPC ${pending.method} failed: ${ipcErrorDetail(message)}`));
      return;
    }
    pending.resolve(message.result);
  }

  private send(message: IpcMessage): void {
    if (!this.socket?.writable) throw new Error("Codex Desktop IPC is not connected");
    const payload = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }

  private sendAndFlush(message: IpcMessage): Promise<void> {
    if (!this.socket?.writable) {
      return Promise.reject(new Error("Codex Desktop IPC is not connected"));
    }
    const payload = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    return new Promise((resolve, reject) => {
      this.socket?.write(Buffer.concat([header, payload]), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function followerTurnId(value: unknown): string | undefined {
  let current = recordValue(value);
  for (let depth = 0; current && depth < 5; depth += 1) {
    const direct = stringValue(current.turnId);
    const turn = recordValue(current.turn);
    const nestedTurnId = stringValue(turn?.id);
    if (direct || nestedTurnId) return direct ?? nestedTurnId;
    current = recordValue(current.result);
  }
  return undefined;
}

function ipcErrorDetail(message: IpcMessage): string {
  const directError = stringValue(message.error);
  const error = recordValue(message.error) ?? recordValue(message.result);
  return directError ?? stringValue(error?.message) ?? stringValue(message.message) ?? "unknown error";
}

function isDesktopTurnBusyError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /active turn|turn .*in progress|turn.*running|already.*(?:turn|task)|thread.*busy/i.test(detail);
}

function appServerSandboxPolicy(value: CodexRunnerInput["sandbox"]): Record<string, unknown> | undefined {
  if (value === "danger-full-access") return { type: "dangerFullAccess" };
  if (value === "read-only") return { type: "readOnly" };
  if (value === "workspace-write") return { type: "workspaceWrite" };
  return undefined;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\n${turnId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
