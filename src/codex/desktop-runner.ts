import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { codexTurnRecovery } from "./turn-recovery.js";
import { setTimeout as sleep } from "node:timers/promises";
import { assertCodexThreadRunnable, assertCapacityResume, type CodexCapacityResumeInput, CodexInterventionError, CodexOwnerUnavailableError, CodexTurnExecutionError } from "./backend.js";
import { lastCodexTurnFailure } from "./turn-failure.js";
import { communicationError, CodexCommunicationError, isCodexCommunicationFailure } from "./communication-error.js";
import { IpcFrameDecoder, IpcFrameSizeError } from "./ipc-frames.js";

import type {
  CodexRunResult,
  CodexRunnerInput,
  CodexSteerInput,
  CodexSteerResult,
  CodexThreadMessageInput,
  CodexInputReceipt,
  CodexStopResult,
  CodexThreadContinuation,
  CodexThreadSnapshot,
  CodexThreadState,
  CodexTurnStatus
} from "./backend.js";
import { parseThreadHistory } from "./app-server-runner.js";
import { desktopSessionMembership } from "./desktop-session-membership.js";
import {
  CodexSessionCompletionMonitor,
  type CodexSessionActivity,
  type CodexSessionCompletion
} from "../server/codex-session-monitor.js";

const IPC_MESSAGE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// The installed Desktop IPC router waits up to 10s for client discovery.
// Do not race that negative acknowledgement with our own 10s deadline.
const DEFAULT_OBSERVATION_TIMEOUT_MS = 12_000;
// A follow read has 25s, including a 5s private metadata read. Leave headroom
// instead of letting a nested recovery outlive the caller and accumulate work.
const MAX_OBSERVATION_BUDGET_MS = 19_000;

type IpcMessage = Record<string, unknown>;

type ObservationStage = "connect" | "initialize" | "discovery" | "snapshot" | "decode";
export type DesktopOwnerObservationDiagnostic = {
  timestamp: string;
  backend: "desktop";
  hostId: "local";
  threadId: string;
  observationId: string;
  phase: "preflight";
  operation: "thread/owner-snapshot";
  attempt: number;
  maxAttempts: 2;
  stage: ObservationStage;
  stageDurationsMs: Partial<Record<ObservationStage, number>>;
  elapsedMs: number;
  attemptBudgetMs: number;
  totalBudgetMs: number;
  outcome: "retrying" | "recovered" | "no-live-owner" | "failed" | "closed";
  code?: "timeout" | "disconnected" | "rejected";
  messageSubmitted: false;
};

export type DesktopCodexRunnerOptions = {
  socketPath?: string;
  codexHome?: string;
  timeoutMs?: number;
  completionPollIntervalMs?: number;
  busyRetryDelayMs?: number;
  observationTimeoutMs?: number;
  onObservationDiagnostic?: (event: DesktopOwnerObservationDiagnostic) => void;
};

type OwnerObservation = { connection: DesktopIpcConnection; snapshot: CodexThreadSnapshot; release: () => void };

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
  private readonly unavailableOwnerLogTimes = new Map<string, number>();
  private readonly monitor: CodexSessionCompletionMonitor;
  private monitorStarted = false;
  private closed = false;
  private readonly observationTimeoutMs: number;
  private readonly codexHome?: string;
  private readonly snapshotReads = new Map<string, Promise<CodexThreadSnapshot | undefined>>();
  private readonly observationConnections = new Set<DesktopIpcConnection>();
  private readonly observationShutdown = new AbortController();
  private readonly onObservationDiagnostic: (event: DesktopOwnerObservationDiagnostic) => void;

  /** Read the actual Desktop writer, not an unrelated private app-server. */
  readThreadSnapshot(threadId: string): Promise<CodexThreadSnapshot | undefined> {
    if (this.closed) return Promise.reject(new Error("Codex Desktop runner is closed"));
    const existing = this.snapshotReads.get(threadId);
    if (existing) return existing;
    const work = this.readThreadSnapshotOnce(threadId).finally(() => {
      if (this.snapshotReads.get(threadId) === work) this.snapshotReads.delete(threadId);
    });
    this.snapshotReads.set(threadId, work);
    return work;
  }

  private async readThreadSnapshotOnce(threadId: string): Promise<CodexThreadSnapshot | undefined> {
    let observation: OwnerObservation | undefined;
    try {
      observation = await this.observeOwner(threadId);
      this.unavailableOwnerLogTimes.delete(threadId);
      // Live IPC can omit projectId even for a project-backed task. Normalize
      // through the same fresh Desktop membership adapter as App/catalog reads;
      // explicit projectless assignments and ambiguous roots remain unassigned.
      return { ...observation.snapshot, state: desktopSessionMembership(this.codexHome, "local", true)(observation.snapshot.state) };
    } catch (error) {
      // Discovery is read-only. An unanswered discovery is not proof of an
      // idle Desktop task; the caller may only fall back to the app-server's
      // own writer, whose resume lock still rejects foreign ownership.
      if (error instanceof CodexOwnerUnavailableError) {
        const last = this.unavailableOwnerLogTimes.get(threadId) ?? 0;
        if (Date.now() - last > 60_000) {
          this.unavailableOwnerLogTimes.set(threadId, Date.now());
          console.info(`[codex-im-gateway] owner discovery ${JSON.stringify({ timestamp: new Date().toISOString(),
            backend: "desktop", hostId: "local", threadId, operation: error.operation, code: error.code,
            outcome: "no-live-owner", messageSubmitted: false })}`);
        }
        return undefined;
      }
      if (isDesktopOwnerUnavailable(error)) return undefined;
      throw error;
    } finally {
      observation?.release();
    }
  }

  async inspectThread(threadId: string): Promise<CodexThreadState | undefined> {
    return (await this.readThreadSnapshot(threadId))?.state;
  }

  constructor(options: DesktopCodexRunnerOptions = {}) {
    this.codexHome = options.codexHome;
    this.socketPath = options.socketPath ?? path.join(os.homedir(), ".codex", "ipc", "ipc.sock");
    this.requestTimeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.busyRetryDelayMs = options.busyRetryDelayMs ?? 1_000;
    this.observationTimeoutMs = Math.min(this.requestTimeoutMs, options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS);
    this.onObservationDiagnostic = options.onObservationDiagnostic ?? (event => {
      console.info(`[codex-im-gateway] owner observation ${JSON.stringify(event)}`);
    });
    this.monitor = new CodexSessionCompletionMonitor({
      codexHome: options.codexHome,
      pollIntervalMs: options.completionPollIntervalMs ?? 1_000,
      onCompletion: (completion) => this.handleCompletion(completion),
      onActivity: (activity) => this.handleActivity(activity)
    });
  }

  /** Only this read-only boundary retries. The returned connection is leased to
   * the caller; any subsequent write and its acknowledgement are outside it. */
  private async observeOwner(threadId: string): Promise<OwnerObservation> {
    const observationId = crypto.randomUUID();
    const started = performance.now();
    const backoffMs = Math.min(250, Math.max(1, Math.floor(this.observationTimeoutMs / 10)));
    const totalBudgetMs = Math.min(this.requestTimeoutMs, this.observationTimeoutMs * 3 + backoffMs, MAX_OBSERVATION_BUDGET_MS);
    const deadline = started + totalBudgetMs;
    for (let attempt = 1; ; attempt++) {
      if (this.closed) throw new Error("Codex Desktop runner is closed");
      if (performance.now() >= deadline) {
        throw new CodexCommunicationError("preflight", "thread/owner-snapshot", threadId, undefined,
          new Error("Desktop owner observation timed out"));
      }
      const attemptBudgetMs = Math.max(1, Math.min(this.observationTimeoutMs * attempt, deadline - performance.now()));
      const connection = new DesktopIpcConnection(this.socketPath, this.requestTimeoutMs);
      this.observationConnections.add(connection);
      const release = () => { connection.close(); this.observationConnections.delete(connection); };
      const stages = new ObservationStages();
      const report = (outcome: DesktopOwnerObservationDiagnostic["outcome"], error?: unknown) => {
        // Whitelist identifiers and timing only: never log IPC payloads or raw errors.
        const event: DesktopOwnerObservationDiagnostic = {
          timestamp: new Date().toISOString(), backend: "desktop", hostId: "local", threadId,
          observationId, phase: "preflight", operation: "thread/owner-snapshot", attempt, maxAttempts: 2,
          stage: stages.stage, stageDurationsMs: stages.durations(),
          elapsedMs: Math.round(performance.now() - started), attemptBudgetMs: Math.round(attemptBudgetMs), totalBudgetMs,
          outcome, ...(error ? { code: observationFailureCode(error) } : {}),
          messageSubmitted: false
        };
        try { this.onObservationDiagnostic(event); } catch { /* Diagnostics cannot change delivery semantics. */ }
      };
      try {
        const snapshot = await observeDesktopOwner(connection, threadId, attemptBudgetMs, stages);
        if (this.closed) throw new Error("Codex Desktop runner is closed");
        if (attempt > 1) report("recovered");
        return { connection, snapshot, release };
      } catch (error) {
        release();
        const retryable = !(error instanceof CodexOwnerUnavailableError || error instanceof DesktopIpcRejectionError) &&
          (isCodexCommunicationFailure(error) || error instanceof DesktopIpcConnectError && error.transient);
        const retry = !this.closed && attempt < 2 && retryable && deadline - performance.now() > backoffMs;
        if (error instanceof CodexOwnerUnavailableError) {
          if (attempt > 1) report("no-live-owner");
        } else report(this.closed ? "closed" : retry ? "retrying" : "failed", error);
        if (!retry) throw error;
        try { await sleep(backoffMs, undefined, { signal: this.observationShutdown.signal }); }
        catch { throw new Error("Codex Desktop runner is closed"); }
      }
    }
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    return this.execute(input);
  }

  async resumeAfterCapacity(resume: CodexCapacityResumeInput): Promise<CodexRunResult> {
    return this.execute({ threadId: resume.threadId, cwd: "", prompt: "", onTurnStarted: resume.onTurnStarted,
      onProgress: resume.onProgress, onRecovery: resume.onRecovery }, resume);
  }

  private async execute(input: CodexRunnerInput, resume?: CodexCapacityResumeInput): Promise<CodexRunResult> {
    if (this.closed) throw new Error("Codex Desktop runner is closed");
    if (!input.threadId) throw new Error("Codex Desktop relay requires an existing thread id");
    if (input.dynamicTools?.length || input.onDynamicToolCall) {
      throw new Error("Codex Desktop relay does not support dynamic bridge tools for an existing Desktop-owned thread");
    }

    let acceptedTurnId: string | undefined;
    this.activeThreads.add(input.threadId);
    try {
      await this.ensureMonitorReady();
      await input.onProgress?.("当前会话由 Codex Desktop 持有，已转交桌面端继续执行。");
      const request = resume ? { threadId: input.threadId, input: [], clientUserMessageId: resume.clientUserMessageId,
        turnTrigger: "capacity_retry_automatic" } : compactObject({
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
      let previousTurnIds = new Set<string>();
      while (response === undefined) {
        if (this.closed) throw new Error("Codex Desktop runner is closed");
        try {
          response = await sendFollowerStartTurn({
            observe: () => this.observeOwner(input.threadId!),
            threadId: input.threadId,
            request,
            resume,
            onSnapshot: (snapshot) => {
              previousTurnIds = new Set(snapshot.turns.map((turn) => turn.id));
            }
          });
        } catch (error) {
          if (resume || !isDesktopTurnBusyError(error)) throw error;
          if (!queuedNoticeSent) {
            queuedNoticeSent = true;
            await input.onProgress?.("当前会话的上一条任务仍在处理中，已加入队列。");
          }
          await delay(this.busyRetryDelayMs);
        }
      }
      const turnId = followerTurnId(response);
      if (!turnId) {
        throw new CodexCommunicationError("submission", "thread-follower-start-turn", input.threadId,
          undefined, { code: "InvalidAcknowledgement" });
      }
      if (previousTurnIds.has(turnId)) {
        // A concurrent Desktop writer can race our read. The message may have
        // been consumed by that turn: fail visibly, never retry or duplicate it.
        throw new CodexInterventionError("Desktop 将这条消息接收到了已有轮次，而不是新任务。未重复提交，请查看 /history 和 /status 确认。");
      }
      acceptedTurnId = turnId;
      await input.onTurnStarted?.({ threadId: input.threadId, turnId });
      const completion = await this.waitForCompletion(input.threadId, turnId, input.onProgress);
      if (!completion.success) throw new CodexTurnExecutionError("failed", completion.text, completion.failureCode);
      return {
        threadId: input.threadId,
        turnId,
        text: completion.text,
        raw: JSON.stringify(completion)
      };
    } catch (error) {
      throw communicationError(error, { phase: acceptedTurnId ? "observation" : "preflight",
        operation: acceptedTurnId ? "turn/observe" : "desktop/prepare", threadId: input.threadId, turnId: acceptedTurnId });
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

  async submitThreadMessage(input: CodexThreadMessageInput): Promise<CodexInputReceipt> {
    if (this.closed) throw new Error("Codex Desktop runner is closed");
    let observation: OwnerObservation | undefined;
    let phase: "preflight" | "submission" = "preflight";
    try {
      observation = await this.observeOwner(input.threadId);
      const { snapshot, connection } = observation;
      assertCodexThreadRunnable(snapshot.state);
      if (snapshot.state.runtimeStatus !== "active" || !snapshot.state.activeTurnId) {
        throw new CodexInterventionError("当前会话已经没有可确认的活动轮次，消息未提交。未新建任务或自动排队，请查看 /status 后重新发送。");
      }
      input.assertCurrent?.();
      phase = "submission";
      // A conversation-targeted user message, like ordinary native UI input.
      // Do not put expectedTurnId here: v1 ignores it. Guarded /steer remains
      // unsupported. Never retry or fall back to start-turn after this write.
      const response = await connection.request("thread-follower-steer-turn", 1, {
        conversationId: input.threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        restoreMessage: { context: {} },
        clientUserMessageId: input.clientUserMessageId
      });
      const turnId = followerTurnId(response);
      if (!turnId) throw new CodexCommunicationError("submission", "thread-follower-steer-turn", input.threadId,
        undefined, { code: "InvalidAcknowledgement" });
      return { status: "accepted", threadId: input.threadId, turnId };
    } catch (error) {
      throw communicationError(error, { phase, operation: phase === "submission" ? "thread-follower-steer-turn" : "desktop/thread-state", threadId: input.threadId });
    } finally {
      observation?.release();
    }
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
    this.observationShutdown.abort();
    for (const connection of this.observationConnections) connection.close();
    this.observationConnections.clear();
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
  observe: () => Promise<OwnerObservation>;
  threadId: string;
  request: Record<string, unknown>;
  onSnapshot?: (snapshot: CodexThreadSnapshot) => void;
  resume?: CodexCapacityResumeInput;
};

class ObservationStages {
  stage: ObservationStage = "connect";
  private since = performance.now();
  private readonly completed: Partial<Record<ObservationStage, number>> = {};
  next(stage: ObservationStage): void {
    this.completed[this.stage] = Math.round(performance.now() - this.since);
    this.stage = stage;
    this.since = performance.now();
  }
  durations(): Partial<Record<ObservationStage, number>> {
    return { ...this.completed, [this.stage]: Math.round(performance.now() - this.since) };
  }
}

/** Every attempt has one deadline, not a new timeout for each RPC/stage. */
async function observeDesktopOwner(connection: DesktopIpcConnection, threadId: string, timeoutMs: number,
  stages: ObservationStages): Promise<CodexThreadSnapshot> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = performance.now() + timeoutMs;
  const timeout = () => new CodexCommunicationError("preflight", "thread/owner-snapshot", threadId, undefined,
    new Error("Desktop owner observation timed out"));
  try {
    return await Promise.race([(async () => {
      await connection.initialize(() => stages.next("initialize"));
      stages.next("discovery");
      await connection.request("thread-owner-discovery", 1, { conversationId: threadId, hostId: "local" });
      stages.next("snapshot");
      const owner = await connection.followSnapshot(threadId);
      stages.next("decode");
      const snapshot = parseDesktopSnapshot(threadId, owner);
      // Synchronous decoding may cross the deadline before the timer can fire.
      if (performance.now() >= deadline) throw timeout();
      return snapshot;
    })(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timeout());
        connection.close();
      }, timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendFollowerStartTurn(input: FollowerRequest): Promise<unknown> {
  let observation: OwnerObservation | undefined;
  let phase: "preflight" | "submission" = "preflight";
  try {
    observation = await input.observe();
    const { connection, snapshot } = observation;
    if (input.resume) assertCapacityResume(snapshot, input.resume.failedTurnId);
    else assertCodexThreadRunnable(snapshot.state);
    if (snapshot.state.pendingTurnWithoutId && snapshot.state.runtimeStatus !== "active") {
      throw new CodexInterventionError("Codex App 残留了没有轮次 ID 的运行中消息，但后端没有执行任务。为避免重复提交，未发送新消息；请先重新加载 Codex App 并检查 /history。");
    }
    if (snapshot.state.runtimeStatus === "active") throw new Error("Codex Desktop thread has an active turn");
    if (snapshot.state.runtimeStatus !== "idle" && !(input.resume && snapshot.state.runtimeStatus === "systemError")) {
      throw new CodexInterventionError("无法确认 Codex Desktop 会话处于空闲状态，未发送新消息。请检查 /status 后重试。");
    }
    input.onSnapshot?.(snapshot);
    if (input.resume) {
      assertCapacityResume(snapshot, input.resume.failedTurnId);
      input.resume.assertCurrent();
    }
    phase = "submission";
    return await connection.request("thread-follower-start-turn", 2, {
      conversationId: input.threadId,
      turnStart: {
        request: input.request,
        context: input.resume ? { inheritThreadSettings: true } : {
          inheritThreadSettings: false,
          useAppServerPermissionDefault: true,
          usePermissionSelection: false
        }
      }
    });
  } catch (error) {
    throw communicationError(error, { phase, operation: phase === "submission" ? "thread-follower-start-turn" : "desktop/thread-state", threadId: input.threadId });
  } finally {
    observation?.release();
  }
}

async function sendFollowerInterrupt(input: { socketPath: string; timeoutMs: number; threadId: string; expectedTurnId?: string }): Promise<void> {
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
  private readonly frames = new IpcFrameDecoder(IPC_MESSAGE_MAX_BYTES);
  private readonly snapshots = new Map<string, Record<string, unknown>>();
  private cancelConnect?: () => void;
  private snapshotWaiter?: {
    threadId: string;
    resolve: (state: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
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

  async initialize(onConnected?: () => void): Promise<void> {
    await this.connect();
    onConnected?.();
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

  followSnapshot(threadId: string): Promise<Record<string, unknown>> {
    // The owner can publish its initial snapshot during discovery, before
    // the response resolves. Do not lose that snapshot between the two RPCs.
    const early = this.snapshots.get(threadId);
    if (early) return Promise.resolve(early);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.snapshotWaiter = undefined;
        reject(new Error("Codex Desktop owner snapshot timed out; no message was submitted"));
      }, this.timeoutMs);
      this.snapshotWaiter = { threadId, resolve, reject, timer };
      void this.broadcast("thread-stream-following-changed", 1, {
        conversationId: threadId, hostId: "local", following: true
      }).catch((error) => { this.failSnapshot(error); });
    });
  }

  private failSnapshot(error: Error): void {
    if (!this.snapshotWaiter) return;
    clearTimeout(this.snapshotWaiter.timer);
    this.snapshotWaiter.reject(error);
    this.snapshotWaiter = undefined;
  }

  close(): void {
    const error = new Error("Codex Desktop IPC connection closed");
    this.cancelConnect?.();
    this.failSnapshot(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.snapshots.clear();
    this.frames.reset();
    this.socket?.destroy();
    this.socket = undefined;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      this.socket = socket;
      const settle = (error?: Error) => {
        clearTimeout(timer);
        this.cancelConnect = undefined;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        socket.destroy();
        settle(new Error(`Codex Desktop IPC connection timed out after ${this.timeoutMs}ms`));
      }, Math.min(this.timeoutMs, 30_000));
      this.cancelConnect = () => settle(new Error("Codex Desktop IPC connection closed while connecting"));
      socket.once("connect", () => {
        settle();
      });
      socket.once("error", (error) => {
        settle(new DesktopIpcConnectError(error));
      });
      socket.on("data", (chunk) => this.receive(chunk));
      socket.on("close", () => {
        this.cancelConnect?.();
        this.failSnapshot(new Error("Codex Desktop IPC closed before the owner snapshot arrived"));
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
    try { this.frames.push(chunk, payload => {
      let message: IpcMessage;
      try { message = JSON.parse(payload.toString("utf8")) as IpcMessage; }
      catch { return; }
      this.handleMessage(message);
    }); } catch (error) {
      if (!(error instanceof IpcFrameSizeError)) throw error;
      this.socket?.destroy(error);
    }
  }

  private handleMessage(message: IpcMessage): void {
    if (message.type === "broadcast" && message.method === "thread-stream-state-changed") {
      const params = recordValue(message.params);
      // This connection observes only the local owner; a remote broadcast with
      // the same conversation ID must never authorize a local write.
      if (params?.hostId !== undefined && params.hostId !== "local") return;
      const change = recordValue(params?.change);
      const state = recordValue(change?.conversationState);
      if (typeof params?.conversationId === "string" && change?.type === "snapshot" && state) {
        this.snapshots.set(params.conversationId, state);
      }
      if (this.snapshotWaiter && params?.conversationId === this.snapshotWaiter.threadId
        && change?.type === "snapshot" && state) {
        clearTimeout(this.snapshotWaiter.timer);
        this.snapshotWaiter.resolve(state);
        this.snapshotWaiter = undefined;
      }
      return;
    }
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
      const detail = ipcErrorDetail(message);
      const errorCode = stringValue(recordValue(message.error)?.code) ?? stringValue(recordValue(message.result)?.code);
      // Only discovery can certify that NOTHING was submitted. The same code
      // from start-turn must remain an uncertain failure and cannot be replayed.
      pending.reject(pending.method === "thread-owner-discovery" && (detail === "no-client-found" || errorCode === "no-client-found")
        ? new CodexOwnerUnavailableError()
        : new DesktopIpcRejectionError(`Codex Desktop IPC ${pending.method} failed: ${detail}`));
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

class DesktopIpcConnectError extends Error {
  readonly transient: boolean;
  readonly unavailable: boolean;
  constructor(error: NodeJS.ErrnoException) {
    super(`Unable to connect to Codex Desktop IPC: ${error.message}`, { cause: error });
    this.transient = ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error.code ?? "");
    this.unavailable = error.code === "ENOENT" || error.code === "ECONNREFUSED";
  }
}

class DesktopIpcRejectionError extends Error {}

function observationFailureCode(error: unknown): DesktopOwnerObservationDiagnostic["code"] {
  if (error instanceof DesktopIpcRejectionError) return "rejected";
  if (error instanceof CodexCommunicationError) return error.code === "timeout" ? "timeout" : "disconnected";
  if (error instanceof DesktopIpcConnectError) return "disconnected";
  if (isCodexCommunicationFailure(error)) return /timed out|timeout/i.test(String(error)) ? "timeout" : "disconnected";
  return "rejected";
}

export function parseDesktopSnapshot(threadId: string, owner: Record<string, unknown>): CodexThreadSnapshot {
  const history = recordValue(recordValue(owner.turnHistory)?.history);
  const entities = recordValue(history?.entitiesByKey);
  // Older pages are appended to entitiesByKey, so object insertion order is
  // not the conversation order. Never mistake an older page for the active tail.
  const rawTurns = (entities ? Object.values(entities) : Array.isArray(owner.turns) ? owner.turns : [])
    .map(recordValue).filter((turn): turn is Record<string, unknown> => Boolean(turn))
    .sort((a, b) => Number(a.turnStartedAtMs ?? 0) - Number(b.turnStartedAtMs ?? 0));
  const turns: CodexThreadSnapshot["turns"] = [];
  let pendingTurnWithoutId = false;
  for (const value of rawTurns) {
    const turn = recordValue(value);
    if (!turn) continue;
    const id = stringValue(turn.turnId) ?? stringValue(turn.id);
    const status = turn.status as CodexTurnStatus;
    if (!["inProgress", "completed", "interrupted", "failed"].includes(status)) continue;
    if (!id) { pendingTurnWithoutId ||= status === "inProgress"; continue; }
    const startedAtMs = typeof turn.turnStartedAtMs === "number" ? turn.turnStartedAtMs
      : typeof turn.startedAt === "number" ? turn.startedAt * 1_000 : NaN;
    turns.push({ id, status, ...(Number.isFinite(new Date(startedAtMs).getTime()) && startedAtMs > 0
      ? { startedAt: new Date(startedAtMs).toISOString() } : {}), messages: parseThreadHistory({ turns: [{ ...turn, id,
      startedAt: typeof turn.turnStartedAtMs === "number" ? turn.turnStartedAtMs / 1_000 : turn.startedAt
    }] }) });
  }
  const runtime = recordValue(owner.threadRuntimeStatus)?.type;
  const runtimeStatus = ["idle", "active", "notLoaded", "systemError"].includes(String(runtime))
    ? runtime as CodexThreadState["runtimeStatus"] : "unknown";
  const activeTurn = runtimeStatus === "active" ? turns.filter((turn) => turn.status === "inProgress").at(-1) : undefined;
  const flags = recordValue(owner.threadRuntimeStatus)?.activeFlags;
  const latestRaw = rawTurns.at(-1);
  const latestTurn = turns.at(-1);
  const failure = (latestRaw?.turnId ?? latestRaw?.id) === latestTurn?.id ? lastCodexTurnFailure(latestRaw) : undefined;
  return { state: {
    threadId, persistence: "active", runtimeStatus, executionOwner: "desktop",
    activeFlags: Array.isArray(flags) ? flags.filter((flag): flag is "waitingOnApproval" | "waitingOnUserInput" =>
      flag === "waitingOnApproval" || flag === "waitingOnUserInput") : [],
    ...(activeTurn ? { activeTurnId: activeTurn.id } : {}),
    ...(activeTurn && latestRaw && (latestRaw.turnId ?? latestRaw.id) === activeTurn.id
      && codexTurnRecovery(threadId, latestRaw) ? { recovery: codexTurnRecovery(threadId, latestRaw) } : {}),
    ...(pendingTurnWithoutId ? { pendingTurnWithoutId: true } : {}),
    ...(turns.at(-1) ? { latestTurnStatus: turns.at(-1)!.status } : {}),
    ...(failure ? { lastTurnFailure: failure } : {}),
    ...(stringValue(owner.cwd) ? { cwd: stringValue(owner.cwd) } : {}),
    ...(stringValue(owner.title) ? { title: stringValue(owner.title) } : {}),
    ...(stringValue(owner.projectId) ? { projectId: stringValue(owner.projectId) } : {})
  }, turns };
}

function isDesktopOwnerUnavailable(error: unknown): boolean {
  return error instanceof DesktopIpcConnectError && error.unavailable;
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
