import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ApprovalDeliveryResult } from "../bridge/approval.js";
import type { CodexUserInputAnswer, CodexUserInputRequest, CodexUserInputResult } from "../codex/backend.js";
import { parseUserInputRequest } from "../codex/user-input.js";
import { desktopAsyncUserInputs, asyncUserInputReply } from "../codex/async-user-input.js";

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
  /** This monitor uses the local Desktop IPC socket, never a remote host. */
  hostId?: "local";
  requestId: string | number;
  method: AppServerApprovalMethod;
  request: CodexApprovalRequest;
};

export type CodexDesktopUserInput = {
  hostId: "local";
  requestId: string | number;
  method: "item/tool/requestUserInput";
  request: CodexUserInputRequest;
};
type DesktopRequest = CodexDesktopApproval | CodexDesktopUserInput;

export type CodexDesktopRequestMonitorOptions = {
  socketPath?: string;
  reconnectDelayMs?: number;
  decisionTimeoutMs?: number;
  onApproval: (approval: CodexDesktopApproval) => Promise<CodexApprovalDecision | undefined>;
  onResult?: (approval: CodexDesktopApproval, result: ApprovalDeliveryResult) => Promise<void> | void;
  onUserInput?: (input: CodexDesktopUserInput) => Promise<CodexUserInputAnswer | undefined>;
  onUserInputResult?: (input: CodexDesktopUserInput, result: CodexUserInputResult) => Promise<void> | void;
};

type IpcMessage = Record<string, unknown>;

/** One follower connection for all pending native interactions. */
export class CodexDesktopRequestMonitor {
  private readonly socketPath: string;
  private readonly reconnectDelayMs: number;
  private readonly followedThreads = new Set<string>();
  private readonly handledRequests = new Set<string>();
  private readonly activeRequests = new Map<string, DesktopRequest>();
  private readonly requestSnapshots = new Map<string, { requests: unknown[]; cwd?: string; turns?: unknown[];
    turnHistory?: unknown; threadRuntimeStatus?: unknown }>();
  private readonly processingRequests = new Set<string>();
  private readonly rerouteRequests = new Set<string>();
  private readonly pendingDecisions = new Map<string, {
    method: string; expectedTurnId?: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
  }>();
  private socket?: net.Socket;
  private reconnectTimer?: NodeJS.Timeout;
  private clientId?: string;
  private buffer = Buffer.alloc(0);
  private started = false;

  constructor(private readonly options: CodexDesktopRequestMonitorOptions) {
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
    this.failPendingDecisions();
    for (const [key, approval] of this.activeRequests) this.withdraw(key, approval, true);
    this.requestSnapshots.clear();
  }

  followThread(threadId: string): void {
    if (!threadId.trim() || this.followedThreads.has(threadId)) return;
    this.followedThreads.add(threadId);
    if (this.clientId) this.sendFollow(threadId, true);
  }

  setFollowedThreads(threadIds: Iterable<string>): void {
    const next = new Set(threadIds);
    for (const threadId of this.followedThreads) {
      if (next.has(threadId)) continue;
      this.followedThreads.delete(threadId);
      this.requestSnapshots.delete(threadId);
      if (this.clientId) this.sendFollow(threadId, false);
      for (const [key, approval] of this.activeRequests) {
        if (approval.request.threadId === threadId) this.withdraw(key, approval, true);
      }
    }
    for (const threadId of next) this.followThread(threadId);
    // Retry a previously unroutable request after a binding/channel change.
    for (const [key, approval] of this.activeRequests) this.dispatch(key, approval);
  }

  private connect(): void {
    if (!this.started || this.socket) return;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.on("connect", () => this.initialize());
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (error) => {
      if (!isMissingSocketError(error)) {
        console.warn(`[codex-im-gateway] Codex Desktop request IPC error: ${error.message}`);
      }
    });
    socket.on("close", () => {
      if (this.socket !== socket && this.socket) return;
      if (this.socket === socket) this.socket = undefined;
      this.clientId = undefined;
      this.buffer = Buffer.alloc(0);
      this.failPendingDecisions();
      for (const [key, request] of this.activeRequests) this.withdraw(key, request, true);
      this.requestSnapshots.clear();
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
      } catch {
        // Parse errors may include payload text. Do not log question/answer data.
        console.warn("[codex-im-gateway] ignored invalid Codex Desktop IPC message");
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
      console.log("[codex-im-gateway] connected to Codex Desktop pending-request stream");
      for (const threadId of this.followedThreads) this.sendFollow(threadId, true);
      return;
    }
    if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.pendingDecisions.get(message.requestId);
      if (!pending || message.method !== pending.method) return;
      this.pendingDecisions.delete(message.requestId);
      clearTimeout(pending.timer);
      const acknowledged = pending.method === "thread-follower-steer-turn"
        ? recordValue(recordValue(message.result)?.result)?.turnId === pending.expectedTurnId
        : recordValue(message.result)?.ok === true;
      if (message.resultType === "success" && !message.error && acknowledged) {
        pending.resolve();
      } else {
        // Do not expose backend response bodies, which can include command data.
        pending.reject(new Error("Codex Desktop interaction receipt was not confirmed"));
      }
      return;
    }
    if (message.type !== "broadcast" || message.method !== "thread-stream-state-changed") return;
    const params = recordValue(message.params);
    const threadId = stringValue(params?.conversationId);
    const change = recordValue(params?.change);
    if (!threadId || !change || !this.followedThreads.has(threadId)) return;
    if (change.type === "snapshot") {
      const state = recordValue(change.conversationState);
      if (!state || (state.requests !== undefined && !Array.isArray(state.requests))) return;
      const snapshot = { requests: (state.requests ?? []) as unknown[], cwd: stringValue(state.cwd),
        turns: Array.isArray(state.turns) ? state.turns : [], turnHistory: state.turnHistory,
        threadRuntimeStatus: state.threadRuntimeStatus };
      this.requestSnapshots.set(threadId, snapshot);
      this.processSnapshot(threadId, snapshot);
      return;
    }
    if (change.type !== "patches" || !Array.isArray(change.patches)) return;
    const snapshot = structuredClone(this.requestSnapshots.get(threadId) ?? { requests: [] });
    let changed = false;
    for (const patch of change.patches) {
      const record = recordValue(patch);
      const patchPath = Array.isArray(record?.path) ? record.path : [];
      if (patchPath.length === 1 && patchPath[0] === "cwd") snapshot.cwd = stringValue(record?.value);
      if (["requests", "turns", "turnHistory", "threadRuntimeStatus"].includes(String(patchPath[0]))) {
        if (!applyStatePatch(snapshot as Record<string, unknown>, patchPath, record!)) {
          console.warn("[codex-im-gateway] ignored invalid Desktop pending-request state patch");
          return;
        }
        changed = true;
      }
    }
    this.requestSnapshots.set(threadId, snapshot);
    if (changed) this.processSnapshot(threadId, snapshot);
  }

  private processSnapshot(threadId: string, snapshot: { requests: unknown[]; cwd?: string }): void {
    const asyncRequests = desktopAsyncUserInputs(threadId, snapshot as unknown as Record<string, unknown>);
    this.processRequests(threadId, [...(snapshot.requests ?? []), ...asyncRequests.map(request => ({
      method: "item/tool/requestUserInput", id: request.requestId, params: request, async: true
    }))], snapshot.cwd);
  }

  private processRequests(threadId: string, value: unknown, cwd?: string): void {
    if (!Array.isArray(value)) return;
    const present = new Set<string>();
    for (const raw of value) {
      const envelope = recordValue(raw);
      const method = stringValue(envelope?.method);
      const requestId = requestIdValue(envelope?.id);
      const params = recordValue(envelope?.params);
      if (requestId === undefined || !params) continue;
      const parsedInput = method === "item/tool/requestUserInput" ? parseUserInputRequest(params) : undefined;
      const inputRequest = parsedInput ? { ...parsedInput, ...(envelope?.async === true ? { kind: "async" as const } : {}) } : undefined;
      const request = inputRequest ?? (isAppServerApprovalMethod(method) ? parseAppServerApproval(method, params) : undefined);
      if (!request || request.threadId !== threadId) continue;
      const key = JSON.stringify([threadId, request.turnId, typeof requestId, requestId]);
      present.add(key);
      const normalized = inputRequest ? { ...inputRequest, requestId, hostId: "local" }
        : { ...request, ...((request as CodexApprovalRequest).cwd || !cwd ? {} : { cwd }) };
      const previous = this.activeRequests.get(key);
      if (previous && previous.method === method && JSON.stringify(previous.request) === JSON.stringify(normalized)) continue;
      if (previous) this.withdraw(key, previous);
      const approval: DesktopRequest = inputRequest
        ? { hostId: "local", requestId, method: "item/tool/requestUserInput", request: { ...inputRequest, requestId, hostId: "local" } }
        : { hostId: "local", requestId, method: method as AppServerApprovalMethod, request: normalized as CodexApprovalRequest };
      this.activeRequests.set(key, approval);
      this.dispatch(key, approval);
    }
    for (const [key, approval] of this.activeRequests) {
      if (approval.request.threadId === threadId && !present.has(key)) this.withdraw(key, approval);
    }
  }

  private dispatch(key: string, approval: DesktopRequest): void {
    if (this.handledRequests.has(key)) return;
    if (this.processingRequests.has(key)) {
      this.rerouteRequests.add(key);
      return;
    }
    this.processingRequests.add(key);
    void this.forwardApproval(key, approval).catch(() => {
      console.error("[codex-im-gateway] unable to forward Codex Desktop interaction");
    }).finally(() => {
      this.processingRequests.delete(key);
      const retry = this.rerouteRequests.delete(key);
      const active = this.activeRequests.get(key);
      if (retry && active) this.dispatch(key, active);
    });
  }

  private withdraw(key: string, approval: DesktopRequest, suspended = false): void {
    this.activeRequests.delete(key);
    // A requests-list removal is normal after our own decision; the RPC result
    // is the authoritative receipt in that case.
    if (!this.handledRequests.delete(key)) {
      if (approval.method === "item/tool/requestUserInput") void this.reportInput(approval, suspended ? "suspended" : "withdrawn");
      else void this.report(approval, "withdrawn");
    }
  }

  private async forwardApproval(key: string, approval: DesktopRequest): Promise<void> {
    if (approval.method === "item/tool/requestUserInput") {
      const answers = await this.options.onUserInput?.(approval);
      if (!answers || this.activeRequests.get(key) !== approval) return;
      this.handledRequests.add(key);
      try {
        if (approval.request.kind === "async") {
          // Same structured question-reply envelope as the Desktop UI. This
          // endpoint cannot start a task. Legacy IPC v1 does NOT enforce a
          // caller's expectedTurnId, so check the native identity before sending
          // and the returned turn afterwards. A different returned turn is NOT
          // an acknowledgement of this answer. Never auto-retry this mutation.
          await this.submitDecision("thread-follower-steer-turn", {
            conversationId: approval.request.threadId,
            input: [{ type: "text", text: asyncUserInputReply(approval.request, answers), text_elements: [] }],
            clientUserMessageId: crypto.createHash("sha256").update(JSON.stringify([
              approval.request.threadId, approval.request.turnId, approval.requestId
            ])).digest("hex")
          }, approval.request.turnId);
        } else await this.submitDecision("thread-follower-submit-user-input", {
            conversationId: approval.request.threadId, requestId: approval.requestId, response: { answers }
          });
        await this.reportInput(approval, "confirmed");
      } catch {
        await this.reportInput(approval, "failed");
      }
      return;
    }
    const decision = await this.options.onApproval(approval);
    if (!decision || this.activeRequests.get(key) !== approval) return;
    this.handledRequests.add(key);
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
    try {
      await this.submitDecision(method, params);
      await this.report(approval, "confirmed");
    } catch {
      // Never retry a potentially accepted decision automatically.
      await this.report(approval, "failed");
    }
  }

  private submitDecision(method: string, params: IpcMessage, expectedTurnId?: string): Promise<void> {
    if (!this.clientId || !this.socket?.writable) return Promise.reject(new Error("Desktop IPC disconnected"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDecisions.delete(requestId);
        reject(new Error("Desktop interaction receipt timed out"));
      }, this.options.decisionTimeoutMs ?? 15_000);
      this.pendingDecisions.set(requestId, { method, expectedTurnId,
        resolve, reject, timer });
      try {
        this.send({ type: "request", requestId, sourceClientId: this.clientId, version: 1, method, params });
      } catch {
        clearTimeout(timer);
        this.pendingDecisions.delete(requestId);
        reject(new Error("Desktop interaction send failed"));
      }
    });
  }

  private failPendingDecisions(): void {
    for (const pending of this.pendingDecisions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Desktop IPC disconnected before receipt"));
    }
    this.pendingDecisions.clear();
  }

  private async report(approval: CodexDesktopApproval, result: ApprovalDeliveryResult): Promise<void> {
    try {
      await this.options.onResult?.(approval, result);
    } catch {
      console.warn(`[codex-im-gateway] unable to deliver approval ${result} notice`);
    }
  }

  private async reportInput(input: CodexDesktopUserInput, result: CodexUserInputResult): Promise<void> {
    try { await this.options.onUserInputResult?.(input, result); }
    catch { console.warn("[codex-im-gateway] unable to deliver question resolution notice"); }
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

function applyStatePatch(snapshot: Record<string, unknown>, keys: unknown[], patch: IpcMessage): boolean {
  const op = patch.op ?? "replace";
  if (op !== "add" && op !== "remove" && op !== "replace") return false;
  if (!keys.length) return false;
  // Immer-style array and nested-field patches. Clone before applying so a
  // pending notice's command/permissions can never change beneath the user.
  let parent: unknown = snapshot;
  for (const key of keys.slice(0, -1)) {
    if (!safePatchKey(key) || !parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) return false;
    parent = (parent as Record<string | number, unknown>)[key];
  }
  const key = keys.at(-1);
  if (!safePatchKey(key) || !parent || typeof parent !== "object") return false;
  if (Array.isArray(parent)) {
    if (key === "length" && op === "replace" && Number.isSafeInteger(patch.value)
      && Number(patch.value) >= 0 && Number(patch.value) <= parent.length) {
      parent.length = Number(patch.value);
      return true;
    }
    const index = typeof key === "number" ? key : /^\d+$/.test(key) ? Number(key) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index > parent.length || (op !== "add" && index === parent.length)) return false;
    if (op === "remove") parent.splice(index, 1);
    else if (op === "add") parent.splice(index, 0, patch.value);
    else parent[index] = patch.value;
  } else {
    if (op !== "add" && !Object.hasOwn(parent, key)) return false;
    if (op === "remove") delete (parent as Record<string | number, unknown>)[key];
    else (parent as Record<string | number, unknown>)[key] = patch.value;
  }
  return true;
}

function safePatchKey(key: unknown): key is string | number {
  return (typeof key === "string" || typeof key === "number")
    && key !== "__proto__" && key !== "constructor" && key !== "prototype";
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
