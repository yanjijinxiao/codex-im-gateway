import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ApprovalDeliveryResult } from "../bridge/approval.js";
import type { CodexUserInputAnswer, CodexUserInputRequest, CodexUserInputResult } from "../codex/backend.js";
import { parseUserInputRequest } from "../codex/user-input.js";
import { desktopAsyncUserInputs, asyncUserInputReply, asyncAnswerDigest, desktopAsyncAnswerReceipts, type NativeAsyncAnswerReceipt } from "../codex/async-user-input.js";
import { IpcFrameDecoder, IpcFrameSizeError } from "../codex/ipc-frames.js";
import { applyDesktopStatePatches } from "../codex/desktop-state-patches.js";
import { parseMcpForm, mcpFormResponse, safeElicitationUrl, type McpForm } from "../codex/elicitation.js";

import {
  isAppServerApprovalMethod,
  parseAppServerApproval,
  appServerApprovalResult,
  type AppServerApprovalMethod,
  type CodexApprovalDecision,
  type CodexApprovalRequest
} from "../codex/approval.js";

const IPC_MESSAGE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;

export type CodexDesktopApproval = {
  /** Execution host; the local Desktop peer proxies remote followers. */
  hostId?: string;
  requestId: string | number;
  method: AppServerApprovalMethod;
  request: CodexApprovalRequest;
};

export type CodexDesktopUserInput = {
  hostId: string;
  requestId: string | number;
  method: "item/tool/requestUserInput";
  request: CodexUserInputRequest;
  /** Native method/response stay separate from the IM question projection. */
  mcpForm?: McpForm;
};
export type CodexDesktopUnsupportedInteraction = {
  hostId: string; threadId: string; turnId: string; requestId: string | number;
  method: string;
  reason?: "authentication" | "schema-unsupported" | "request-unsupported";
  safeUrl?: string;
};
type DesktopRequest = CodexDesktopApproval | CodexDesktopUserInput;

export type CodexDesktopRequestMonitorOptions = {
  socketPath?: string;
  reconnectDelayMs?: number;
  decisionTimeoutMs?: number;
  /** Read-only fresh-snapshot probes for interactions not yet routed to IM. */
  deferredRetryDelayMs?: number;
  onApproval: (approval: CodexDesktopApproval) => Promise<CodexApprovalDecision | undefined>;
  onResult?: (approval: CodexDesktopApproval, result: ApprovalDeliveryResult) => Promise<void> | void;
  onUserInput?: (input: CodexDesktopUserInput) => Promise<CodexUserInputAnswer | undefined>;
  onUserInputResult?: (input: CodexDesktopUserInput, result: CodexUserInputResult) => Promise<void> | void;
  onObservedUserInputAnswers?: (receipts: NativeAsyncAnswerReceipt[]) => Promise<void> | void;
  /** Neutral notice only: no unvalidated form, credential or challenge data. */
  onUnsupportedInteraction?: (input: CodexDesktopUnsupportedInteraction) => Promise<boolean | void>;
};

type IpcMessage = Record<string, unknown>;
export type DesktopFollowTarget = { hostId: string; threadId: string };
const followKey = (threadId: string, hostId: string) => JSON.stringify([hostId, threadId]);

/** One follower connection for all pending native interactions. */
export class CodexDesktopRequestMonitor {
  private readonly socketPath: string;
  private readonly reconnectDelayMs: number;
  private readonly followedThreads = new Map<string, DesktopFollowTarget>();
  private readonly handledRequests = new Set<string>();
  private readonly unsupportedNotices = new Map<string, { delivered: boolean; retryAt: number }>();
  private readonly activeRequests = new Map<string, DesktopRequest>();
  private readonly requestSnapshots = new Map<string, { requests: unknown[]; cwd?: string; turns?: unknown[];
    turnHistory?: unknown; threadRuntimeStatus?: unknown }>();
  private readonly processingRequests = new Set<string>();
  private readonly rerouteRequests = new Set<string>();
  private readonly deferredRequests = new Map<string, number>();
  private readonly retryReady = new Set<string>();
  private readonly retryProbes = new Map<string, number>();
  private deferredTimer?: NodeJS.Timeout;
  private readonly pendingDecisions = new Map<string, {
    method: string; expectedTurnId?: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
    answerReceipts?: NativeAsyncAnswerReceipt[];
  }>();
  private socket?: net.Socket;
  private reconnectTimer?: NodeJS.Timeout;
  private clientId?: string;
  private readonly frames = new IpcFrameDecoder(IPC_MESSAGE_MAX_BYTES);
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
    this.clearDeferred();
    this.socket?.destroy();
    this.socket = undefined;
    this.clientId = undefined;
    this.frames.reset();
    this.failPendingDecisions();
    for (const [key, approval] of this.activeRequests) this.withdraw(key, approval, true);
    this.requestSnapshots.clear();
  }

  followThread(threadId: string, hostId = "local"): void {
    const key = followKey(threadId, hostId);
    if (!threadId.trim() || !hostId.trim() || this.followedThreads.has(key)) return;
    this.followedThreads.set(key, { threadId, hostId });
    if (this.clientId) this.sendFollow(threadId, true, hostId);
  }

  setFollowedThreads(threadIds: Iterable<string | DesktopFollowTarget>): void {
    const next = new Map(Array.from(threadIds, value => {
      const target = typeof value === "string" ? { threadId: value, hostId: "local" } : value;
      return [followKey(target.threadId, target.hostId), target] as const;
    }));
    for (const [scope, { threadId, hostId }] of this.followedThreads) {
      if (next.has(scope)) continue;
      this.followedThreads.delete(scope);
      this.requestSnapshots.delete(scope);
      this.retryProbes.delete(scope);
      if (this.clientId) this.sendFollow(threadId, false, hostId);
      for (const [key, approval] of this.activeRequests) {
        if (approval.request.threadId === threadId && (approval.hostId ?? "local") === hostId) this.withdraw(key, approval, true);
      }
    }
    for (const { threadId, hostId } of next.values()) this.followThread(threadId, hostId);
    // Route changes require a fresh native snapshot, not a send from cached UI.
    for (const [key, approval] of this.activeRequests) {
      if (this.processingRequests.has(key)) this.rerouteRequests.add(key);
      else if (!this.handledRequests.has(key)) this.defer(key, 0);
    }
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
      this.frames.reset();
      this.clearDeferred();
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
    try { this.frames.push(chunk, payload => {
      try {
        this.handleMessage(JSON.parse(payload.toString("utf8")) as IpcMessage);
      } catch {
        // Parse errors may include payload text. Do not log question/answer data.
        console.warn("[codex-im-gateway] ignored invalid Codex Desktop IPC message");
      }
    }); } catch (error) {
      if (!(error instanceof IpcFrameSizeError)) throw error;
      console.error(`[codex-im-gateway] rejected oversized Codex Desktop IPC message: ${error.frameBytes} bytes`);
      this.socket?.destroy();
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
      for (const { threadId, hostId } of this.followedThreads.values()) this.sendFollow(threadId, true, hostId);
      return;
    }
    if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.pendingDecisions.get(message.requestId);
      if (!pending || message.method !== undefined && message.method !== pending.method) return;
      this.pendingDecisions.delete(message.requestId);
      clearTimeout(pending.timer);
      const acknowledged = pending.method === "thread-follower-steer-turn"
        ? (recordValue(recordValue(message.result)?.result)?.turnId ?? recordValue(message.result)?.turnId) === pending.expectedTurnId
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
    const hostId = stringValue(params?.hostId) ?? "local";
    const scope = threadId ? followKey(threadId, hostId) : "";
    const change = recordValue(params?.change);
    if (!threadId || !change || !this.followedThreads.has(scope)) return;
    if (change.type === "snapshot") {
      const state = recordValue(change.conversationState);
      if (!state || (state.requests !== undefined && !Array.isArray(state.requests))) return;
      const snapshot = { requests: (state.requests ?? []) as unknown[], cwd: stringValue(state.cwd),
        turns: Array.isArray(state.turns) ? state.turns : [], turnHistory: state.turnHistory,
        threadRuntimeStatus: state.threadRuntimeStatus };
      this.requestSnapshots.set(scope, snapshot);
      this.retryProbes.delete(scope);
      this.processSnapshot(threadId, snapshot, hostId, true);
      return;
    }
    if (change.type !== "patches" || !Array.isArray(change.patches)) return;
    const relevant = change.patches.filter(patch => {
      const record = recordValue(patch);
      const patchPath = Array.isArray(record?.path) ? record.path : [];
      return ["cwd", "requests", "turns", "turnHistory", "threadRuntimeStatus"].includes(String(patchPath[0]));
    });
    if (!relevant.length) return;
    const snapshot = applyDesktopStatePatches(this.requestSnapshots.get(scope) ?? { requests: [] }, relevant);
    if (!snapshot) {
      console.warn("[codex-im-gateway] ignored invalid Desktop pending-request state patch");
      // The base may now be out of date. Suspend pending local handlers and
      // request a fresh read-only snapshot rather than submit from stale data.
      this.requestSnapshots.delete(scope);
      for (const [key, request] of this.activeRequests) if (request.request.threadId === threadId
        && (request.hostId ?? "local") === hostId) this.withdraw(key, request, true);
      this.sendFollow(threadId, true, hostId);
      return;
    }
    this.requestSnapshots.set(scope, snapshot);
    this.processSnapshot(threadId, snapshot, hostId);
  }

  private processSnapshot(threadId: string, snapshot: { requests: unknown[]; cwd?: string }, hostId: string, fresh = false): void {
    const receipts = desktopAsyncAnswerReceipts(threadId, snapshot as unknown as Record<string, unknown>, hostId);
    for (const [id, pending] of this.pendingDecisions) if (pending.answerReceipts?.length
      && pending.answerReceipts.every(expected => receipts.some(actual => actual.hostId === expected.hostId
        && actual.threadId === expected.threadId && actual.turnId === expected.turnId
        && actual.questionId === expected.questionId && actual.digest === expected.digest))) {
      clearTimeout(pending.timer); this.pendingDecisions.delete(id); pending.resolve();
    }
    if (receipts.length) void Promise.resolve(this.options.onObservedUserInputAnswers?.(receipts)).catch(() => {
      console.warn("[codex-im-gateway] native question receipt reconciliation failed");
    });
    const asyncRequests = desktopAsyncUserInputs(threadId, snapshot as unknown as Record<string, unknown>, hostId);
    this.processRequests(threadId, [...(snapshot.requests ?? []), ...asyncRequests.map(request => ({
      method: "item/tool/requestUserInput", id: request.requestId, params: request, async: true
    }))], snapshot.cwd, hostId, fresh);
  }

  private processRequests(threadId: string, value: unknown, cwd: string | undefined, hostId: string, fresh: boolean): void {
    if (!Array.isArray(value)) return;
    const present = new Set<string>();
    for (const raw of value) {
      const envelope = recordValue(raw);
      const method = stringValue(envelope?.method);
      const requestId = requestIdValue(envelope?.id);
      const params = recordValue(envelope?.params);
      if (requestId === undefined || !params || envelope?.completed === true) continue;
      const scopedParams = method === "mcpServer/elicitation/request" && params.threadId === threadId
        ? { ...params, turnId: params.turnId ?? `mcp-thread-scope:${typeof requestId}:${requestId}` } : params;
      const form = method === "mcpServer/elicitation/request" ? parseMcpForm(scopedParams) : undefined;
      const parsedInput = form?.request ?? (method === "item/tool/requestUserInput" ? parseUserInputRequest(params) : undefined);
      const inputRequest = parsedInput ? { ...parsedInput, ...(envelope?.async === true ? { kind: "async" as const } : {}) } : undefined;
      const request = inputRequest ?? (isAppServerApprovalMethod(method) ? parseAppServerApproval(method, scopedParams) : undefined);
      if (!request) {
        if (method && !["currentTime/read", "attestation/generate", "account/chatgptAuthTokens/refresh", "item/tool/call"].includes(method)
          && (params.threadId === undefined || params.threadId === threadId)) {
          const turnId = stringValue(params.turnId) ?? `native-thread-scope:${typeof requestId}:${requestId}`;
          const noticeKey = JSON.stringify([hostId, threadId, turnId, typeof requestId, requestId]);
          const notice = this.unsupportedNotices.get(noticeKey);
          if (!notice?.delivered && (!notice || notice.retryAt <= Date.now())) {
            this.unsupportedNotices.set(noticeKey, { delivered: false, retryAt: Date.now() + 60_000 });
            while (this.unsupportedNotices.size > 500) this.unsupportedNotices.delete(this.unsupportedNotices.keys().next().value!);
            const url = safeElicitationUrl(params);
            void this.options.onUnsupportedInteraction?.({ hostId, threadId, turnId, requestId, method,
              ...(params.mode === "url" ? { reason: "authentication" as const, ...(url ? { safeUrl: url } : {}) }
                : params.mode === "form" || params.mode === "openai/form" ? { reason: "schema-unsupported" as const } : {}) })
              .then(delivered => { if (delivered !== false) this.unsupportedNotices.set(noticeKey, { delivered: true, retryAt: 0 }); })
              .catch(() => { console.warn("[codex-im-gateway] unsupported Desktop interaction notice unconfirmed; retry pending"); });
          }
        }
        continue;
      }
      if (request.threadId !== threadId) continue;
      const key = JSON.stringify([hostId, threadId, request.turnId, typeof requestId, requestId]);
      present.add(key);
      const normalized = inputRequest ? { ...inputRequest, requestId, hostId }
        : { ...request, ...((request as CodexApprovalRequest).cwd || !cwd ? {} : { cwd }) };
      const previous = this.activeRequests.get(key);
      if (previous && previous.method === (form ? "item/tool/requestUserInput" : method) && JSON.stringify(previous.request) === JSON.stringify(normalized)) {
        if (fresh && this.retryReady.has(key)) this.dispatch(key, previous);
        continue;
      }
      if (previous) this.withdraw(key, previous);
      const approval: DesktopRequest = inputRequest
        ? { hostId, requestId, method: "item/tool/requestUserInput", request: { ...inputRequest, requestId, hostId }, ...(form ? { mcpForm: form } : {}) }
        : { hostId, requestId, method: method as AppServerApprovalMethod, request: normalized as CodexApprovalRequest };
      this.activeRequests.set(key, approval);
      this.dispatch(key, approval);
    }
    for (const [key, approval] of this.activeRequests) {
      if (approval.request.threadId === threadId && (approval.hostId ?? "local") === hostId && !present.has(key)) this.withdraw(key, approval);
    }
  }

  private dispatch(key: string, approval: DesktopRequest): void {
    if (this.handledRequests.has(key)) return;
    if (this.processingRequests.has(key)) {
      this.rerouteRequests.add(key);
      return;
    }
    this.deferredRequests.delete(key); this.retryReady.delete(key);
    this.processingRequests.add(key);
    void this.forwardApproval(key, approval).catch(() => {
      console.error("[codex-im-gateway] unable to forward Codex Desktop interaction");
      if (this.activeRequests.get(key) === approval && !this.handledRequests.has(key)) this.defer(key);
    }).finally(() => {
      this.processingRequests.delete(key);
      const retry = this.rerouteRequests.delete(key);
      const active = this.activeRequests.get(key);
      if (retry && active && !this.handledRequests.has(key)) this.defer(key, 0);
    });
  }

  private withdraw(key: string, approval: DesktopRequest, suspended = false): void {
    this.activeRequests.delete(key);
    this.deferredRequests.delete(key); this.retryReady.delete(key); this.rerouteRequests.delete(key);
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
      if (!answers || this.activeRequests.get(key) !== approval) {
        if (!answers && this.activeRequests.get(key) === approval) this.defer(key);
        return;
      }
      this.handledRequests.add(key);
      try {
        if (approval.mcpForm) {
          await this.submitDecision("thread-follower-submit-mcp-server-elicitation-response", {
            conversationId: approval.request.threadId, requestId: approval.requestId,
            response: mcpFormResponse(approval.mcpForm, answers)
          }, undefined, undefined, approval.hostId);
        } else if (approval.request.kind === "async") {
          // Same structured question-reply envelope as the Desktop UI. This
          // endpoint cannot start a task. Legacy IPC v1 does NOT enforce a
          // caller's expectedTurnId, so check the native identity before sending
          // and the returned turn afterwards. A different returned turn is NOT
          // an acknowledgement of this answer. Never auto-retry this mutation.
          await this.submitDecision("thread-follower-steer-turn", {
            conversationId: approval.request.threadId,
            input: [{ type: "text", text: asyncUserInputReply(approval.request, answers), text_elements: [] }],
            // Desktop dereferences restoreMessage.context before steering.
            // Leave optional settings absent so the native owner retains its
            // current cwd, workspace, collaboration mode and permissions.
            restoreMessage: { context: {} },
            clientUserMessageId: crypto.createHash("sha256").update(JSON.stringify([
              approval.hostId, approval.request.threadId, approval.request.turnId, approval.requestId
            ])).digest("hex")
          }, approval.request.turnId, approval.request.questions.map(question => ({ hostId: approval.hostId,
            threadId: approval.request.threadId, turnId: approval.request.turnId, questionId: question.id,
            digest: asyncAnswerDigest(question.id, question.question, answers[question.id]?.answers[0] ?? "") })), approval.hostId);
        } else await this.submitDecision("thread-follower-submit-user-input", {
            conversationId: approval.request.threadId, requestId: approval.requestId, response: { answers }
          }, undefined, undefined, approval.hostId);
        await this.reportInput(approval, "confirmed");
      } catch (error) {
        console.warn(`[codex-im-gateway] native question RPC unconfirmed ${JSON.stringify({ timestamp: new Date().toISOString(),
          hostId: approval.hostId, threadId: approval.request.threadId, turnId: approval.request.turnId,
          code: /timed out/.test(error instanceof Error ? error.message : "") ? "timeout" : "invalid-or-disconnected-receipt" })}`);
        await this.reportInput(approval, "failed");
      }
      return;
    }
    const decision = await this.options.onApproval(approval);
    if (!decision || this.activeRequests.get(key) !== approval) {
      if (!decision && this.activeRequests.get(key) === approval) this.defer(key);
      return;
    }
    this.handledRequests.add(key);
    const method = approval.method === "item/commandExecution/requestApproval"
      ? "thread-follower-command-approval-decision"
      : approval.method === "item/fileChange/requestApproval"
        ? "thread-follower-file-approval-decision"
        : approval.method === "mcpServer/elicitation/request"
          ? "thread-follower-submit-mcp-server-elicitation-response"
          : "thread-follower-permissions-request-approval-response";
    const params = approval.method === "mcpServer/elicitation/request"
      ? { conversationId: approval.request.threadId, requestId: approval.requestId,
          response: appServerApprovalResult(approval.method, approval.request, decision) }
      : approval.method === "item/permissions/requestApproval"
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
      await this.submitDecision(method, params, undefined, undefined, approval.hostId);
      await this.report(approval, "confirmed");
    } catch {
      // Never retry a potentially accepted decision automatically.
      await this.report(approval, "failed");
    }
  }

  private submitDecision(method: string, params: IpcMessage, expectedTurnId?: string, answerReceipts?: NativeAsyncAnswerReceipt[], hostId = "local"): Promise<void> {
    if (!this.clientId || !this.socket?.writable) return Promise.reject(new Error("Desktop IPC disconnected"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDecisions.delete(requestId);
        reject(new Error("Desktop interaction receipt timed out"));
      }, this.options.decisionTimeoutMs ?? 15_000);
      this.pendingDecisions.set(requestId, { method, expectedTurnId, answerReceipts,
        resolve, reject, timer });
      try {
        // Installed Desktop uses follower v2 when execution host is explicit.
        // The host belongs on the envelope, not inside the RPC params.
        this.send({ type: "request", requestId, sourceClientId: this.clientId,
          version: hostId === "local" ? 1 : 2, ...(hostId === "local" ? {} : { hostId }), method, params });
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

  private defer(key: string, delayMs = this.options.deferredRetryDelayMs ?? 30_000): void {
    if (!this.started || !this.activeRequests.has(key) || this.handledRequests.has(key)) return;
    this.deferredRequests.set(key, Math.min(this.deferredRequests.get(key) ?? Infinity, Date.now() + delayMs));
    this.scheduleDeferred();
  }

  private scheduleDeferred(): void {
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = undefined;
    if (!this.started || !this.deferredRequests.size) return;
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = undefined;
      const now = Date.now(), delay = Math.max(1, this.options.deferredRetryDelayMs ?? 30_000);
      for (const [key, retryAt] of this.deferredRequests) {
        const request = this.activeRequests.get(key);
        if (!request || this.handledRequests.has(key)) { this.deferredRequests.delete(key); continue; }
        if (retryAt > now) continue;
        this.deferredRequests.set(key, now + delay);
        if (!this.clientId || this.processingRequests.has(key)) continue;
        const hostId = request.hostId ?? "local", threadId = request.request.threadId;
        const scope = followKey(threadId, hostId);
        if (!this.followedThreads.has(scope)) continue;
        this.retryReady.add(key);
        if ((this.retryProbes.get(scope) ?? 0) > now) continue;
        this.retryProbes.set(scope, now + delay);
        // A read-only subscription refresh. Only its fresh snapshot may retry
        // delivery; a removed question or changed host must never be replayed.
        this.sendFollow(threadId, true, hostId);
      }
      this.scheduleDeferred();
    }, Math.max(0, Math.min(...this.deferredRequests.values()) - Date.now()));
    this.deferredTimer.unref();
  }

  private clearDeferred(): void {
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = undefined;
    this.deferredRequests.clear(); this.retryReady.clear(); this.retryProbes.clear();
  }

  private async report(approval: CodexDesktopApproval, result: ApprovalDeliveryResult): Promise<void> {
    try {
      await this.options.onResult?.(approval, result);
    } catch {
      console.warn(`[codex-im-gateway] unable to deliver approval ${result} notice`);
    }
  }

  private async reportInput(input: CodexDesktopUserInput, result: CodexUserInputResult): Promise<void> {
    console.info(`[codex-im-gateway] native question result ${JSON.stringify({ timestamp: new Date().toISOString(),
      hostId: input.hostId, threadId: input.request.threadId, turnId: input.request.turnId,
      kind: input.request.kind ?? "sync", result })}`);
    try { await this.options.onUserInputResult?.(input, result); }
    catch { console.warn("[codex-im-gateway] unable to deliver question resolution notice"); }
  }

  private sendFollow(threadId: string, following: boolean, hostId: string): void {
    this.send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: this.clientId,
      params: { conversationId: threadId, hostId, following },
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
