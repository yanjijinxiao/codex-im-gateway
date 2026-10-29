import { assertQueueAdmissionCurrent, CodexQueueAdmissionError, CodexTurnExecutionError, type CodexTurnObservation } from "./backend.js";
import { AppServerCodexRunner } from "./app-server-runner.js";
import { observeOwnerTurn } from "./native-turn-lifecycle.js";
import path from "node:path";
import {
  resolveLocalAppServerTransport,
  type AppServerConnectionMode
} from "./app-server-daemon.js";
import { CodexExecRunner } from "./exec-runner.js";
import type { CodexExecSandbox } from "./sandbox.js";
import { DesktopCodexRunner } from "./desktop-runner.js";
import { assertCodexThreadRunnable, assertCapacityResume, CodexBackendCapabilityError, CodexOwnerUnavailableError, CodexInterventionError, type CodexCapacityResumeInput } from "./backend.js";
import { canRecoverSystemError, type CodexSystemRecoveryInput, type CodexSystemRecoveryResult } from "./backend.js";
import { communicationError, isCodexCommunicationFailure, CodexCommunicationError } from "./communication-error.js";
import { resolveRemoteCodexTransport } from "./remote-host.js";
import { CodexMetadataReader, type MetadataConnection } from "./metadata-reader.js";
import { stageRemoteFiles, type StageInboundFiles } from "./inbound-files.js";
import type {
  CodexAppServerBackend,
  CodexMetadataObservation,
  CodexBridgeBackend,
  CodexHistoryMessage,
  CodexHistoryPage,
  CodexHistoryPageInput,
  CodexModelOption,
  CodexProjectCatalog,
  CodexSessionCatalog,
  CodexRunResult,
  CodexRunnerInput,
  CodexSteerInput,
  CodexSteerResult,
  CodexThreadMessageInput,
  CodexInputReceipt,
  CodexNativeQueue,
  CodexQueueAddInput,
  CodexQueuedRunInput,
  CodexRuntimeInfo,
  CodexStopResult,
  CodexThreadListInput,
  CodexThreadState,
  CodexThreadSnapshot,
  CodexThreadGoal,
  CodexThreadGoalStatus,
  CodexExecutionScope,
  CodexBackendAdapter,
  EphemeralCodexRunnerInput
} from "./backend.js";
import type { CodexAccountBalance } from "./account-balance.js";

export type CodexBackend = "auto" | "app-server" | "exec";

export type CodexBackendRouterOptions = {
  backend: CodexBackend;
  appServerTransport?: AppServerConnectionMode;
  codexBin?: string;
  execSandbox?: CodexExecSandbox;
  timeoutMs?: number;
  codexHome?: string;
  desktopRunner?: Pick<DesktopCodexRunner, "run" | "steer" | "stop" | "close"> &
    Partial<Pick<DesktopCodexRunner, "refreshTaskList" | "readThreadSnapshot" | "inspectThread" | "submitThreadMessage" | "resumeAfterCapacity" | "detachIndependentObservations">>;
  onThreadMutation?: (threadId: string, hostId: string) => void;
  appServerBackend?: CodexAppServerBackend;
  execBackend?: CodexBackendAdapter;
  remoteTransportResolver?: typeof resolveRemoteCodexTransport;
  stageAttachments?: StageInboundFiles;
  metadataConnectionFactory?: (hostId: string) => MetadataConnection;
};

export type { EphemeralCodexRunnerInput } from "./backend.js";

export type HybridCodexRunnerOptions = CodexBackendRouterOptions;

/**
 * Stable Bridge facade over the two concrete Codex backends.
 *
 * All command operations obey the selected backend. CLI controls use local
 * rollouts or reject unsupported capabilities; they never borrow app-server.
 */
export class CodexBackendRouter implements CodexBridgeBackend {
  readonly systemErrorLifecycleRecovery = true;
  private readonly appServer: CodexAppServerBackend;
  private readonly exec: CodexBackendAdapter;
  private readonly desktop: Pick<DesktopCodexRunner, "run" | "steer" | "stop" | "close"> &
    Partial<Pick<DesktopCodexRunner, "refreshTaskList" | "readThreadSnapshot" | "inspectThread" | "submitThreadMessage" | "resumeAfterCapacity" | "detachIndependentObservations">>;
  private readonly remoteAppServers = new Map<string, CodexAppServerBackend>();
  private readonly remoteTransports = new Map<string, ReturnType<typeof resolveRemoteCodexTransport>>();
  private readonly runTails = new Map<string, Promise<void>>();
  private readonly desktopOwnedThreads = new Set<string>();
  /** Only in-flight read sharing; never reuse an old snapshot to authorize a write. */
  private readonly observations = new Map<string, Promise<unknown>>();
  private readonly metadataReader: CodexMetadataReader;
  private readonly statusReader: CodexMetadataReader;
  private selectedAutoBackend?: "exec" | "app-server";
  private appServerRuns = 0;
  private readonly restartRuns = new Set<{ scope?: CodexExecutionScope }>();
  private get selectedBackend() { return this.options.backend === "auto" ? this.selectedAutoBackend ?? "app-server" : this.options.backend; }

  constructor(private readonly options: CodexBackendRouterOptions) {
    const requestedTransport = options.appServerTransport ?? "auto";
    const effectiveTransport = requestedTransport === "auto"
      && options.codexBin
      && !/^codex(?:\.exe)?$/i.test(path.basename(options.codexBin))
      ? "stdio"
      : requestedTransport;
    const appServerTransport = resolveLocalAppServerTransport({
      mode: effectiveTransport,
      codexHome: options.codexHome,
      codexBin: options.codexBin ?? "codex"
    });
    this.appServer = options.appServerBackend ?? new AppServerCodexRunner({
      codexHome: options.codexHome,
      codexBin: options.codexBin,
      requestTimeoutMs: options.timeoutMs,
      sandbox: options.execSandbox,
      transport: appServerTransport
    });
    this.exec = options.execBackend ?? new CodexExecRunner({
      codexHome: options.codexHome,
      codexBin: options.codexBin,
      sandbox: options.execSandbox,
      timeoutMs: options.timeoutMs
    });
    this.desktop = options.desktopRunner ?? new DesktopCodexRunner({
      timeoutMs: options.timeoutMs,
      codexHome: options.codexHome,
      ...(options.codexHome ? { socketPath: path.join(options.codexHome, "ipc", "ipc.sock") } : {})
    });
    const metadataConnection = options.metadataConnectionFactory ?? (hostId => new AppServerCodexRunner({
      codexHome: options.codexHome, codexBin: options.codexBin, hostId,
      metadataOnly: true,
      requestTimeoutMs: options.timeoutMs, sandbox: options.execSandbox,
      transport: isRemoteHost(hostId) ? this.remoteTransport(hostId) : appServerTransport
    }));
    this.metadataReader = new CodexMetadataReader(metadataConnection);
    this.statusReader = new CodexMetadataReader(metadataConnection);
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    const lease: { scope?: CodexExecutionScope } = {};
    this.restartRuns.add(lease);
    try { return await this.runTracked(input, lease); }
    finally { this.restartRuns.delete(lease); }
  }

  private async runTracked(input: CodexRunnerInput, lease: { scope?: CodexExecutionScope }): Promise<CodexRunResult> {
    if (input.threadId) this.options.onThreadMutation?.(input.threadId, input.hostId ?? "local");
    const queueKey = input.queueKey ?? input.threadId;
    const routedQueueKey = queueKey ? `${input.hostId ?? "local"}:${queueKey}` : undefined;
    if (!routedQueueKey) return this.runImmediately(input, lease);

    const predecessor = this.runTails.get(routedQueueKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = (predecessor ?? Promise.resolve()).catch(() => undefined).then(() => gate);
    this.runTails.set(routedQueueKey, tail);
    try {
      if (predecessor) {
        await input.onProgress?.("当前会话的上一条消息仍在处理中，已加入队列。");
        await predecessor.catch(() => undefined);
      }
      return await this.runImmediately(input, lease);
    } finally {
      release();
      if (this.runTails.get(routedQueueKey) === tail) {
        this.runTails.delete(routedQueueKey);
      }
    }
  }

  stageAttachments: StageInboundFiles = async (files, input) => {
    if (!files.length || !isRemoteHost(input.hostId)) return files;
    if (this.selectedBackend === "exec") throw new Error("CLI backend does not support remote attachment staging");
    if (this.options.stageAttachments) return this.options.stageAttachments(files, input);
    const transport = this.remoteTransport(input.hostId!);
    return stageRemoteFiles(files, input.scope, input.maxBytes, transport);
  };

  async steer(input: CodexSteerInput, hostId?: string): Promise<CodexSteerResult> {
    this.options.onThreadMutation?.(input.threadId, hostId ?? "local");
    if (isRemoteHost(hostId)) return this.appServerFor(hostId).steer(input);
    if (this.selectedBackend === "exec") return this.exec.steer(input);
    const state = await this.inspectThread(input.threadId);
    assertCodexThreadRunnable(state);
    if (state.executionOwner === "desktop") return this.desktop.steer(input);
    try {
      return await this.appServer.steer(input);
    } catch (error) {
      if (!isDesktopSteerCandidateError(error)) throw error;
      return this.desktop.steer(input);
    }
  }

  async resumeAfterCapacity(input: CodexCapacityResumeInput): Promise<CodexRunResult> {
    if (this.selectedBackend === "exec") throw new CodexInterventionError("CLI 后端不支持空输入容量恢复，未重发原消息或切换后端。");
    const snapshot = await this.readThreadSnapshot(input.threadId, input.hostId);
    assertCapacityResume(snapshot, input.failedTurnId);
    if ((await this.listQueuedSubmissions(input.threadId, undefined, input.hostId)).data.length) {
      throw new CodexInterventionError("原生队列已有输入，容量恢复未抢先执行。");
    }
    input.assertCurrent();
    const owner = snapshot.state.executionOwner === "desktop" ? this.desktop : this.appServerFor(input.hostId);
    if (!owner.resumeAfterCapacity) throw new CodexInterventionError("当前执行者不支持空输入容量恢复，未切换执行者。");
    return owner.resumeAfterCapacity(input);
  }

  async recoverSystemError(input: CodexSystemRecoveryInput, hostId = "local"): Promise<CodexSystemRecoveryResult> {
    // Undo only a durable recovery-owned lifecycle write, even if the user
    // has since switched bindings/backend. No task is run by this compensation.
    if (input.lifecycle?.restoring) return this.appServerFor(hostId).recoverSystemError!(input);
    if (this.selectedBackend === "exec") return { status: "unsupported", reason: "owner-unsupported" };
    const snapshot = await this.readThreadSnapshot(input.threadId, hostId);
    input.assertCurrent();
    if (snapshot.state.threadId !== input.threadId || !canRecoverSystemError(snapshot, input.failedTurnId))
      return { status: "deferred", reason: "changed", state: snapshot.state };
    // Desktop IPC currently exposes no state-only reload operation. A private
    // stdio reader cannot clear the live Desktop owner's runtime failure.
    if (snapshot.state.executionOwner === "desktop") return { status: "unsupported", reason: "owner-unsupported" };
    const owner = this.appServerFor(hostId);
    return owner.recoverSystemError ? owner.recoverSystemError(input) : { status: "unsupported", reason: "owner-unsupported" };
  }

  async submitThreadMessage(input: CodexThreadMessageInput, hostId?: string): Promise<CodexInputReceipt> {
    this.options.onThreadMutation?.(input.threadId, hostId ?? "local");
    if (this.selectedBackend === "exec") throw new CodexBackendCapabilityError("turnSteering", "exec");
    const state = await this.inspectThread(input.threadId, hostId);
    assertCodexThreadRunnable(state);
    if (state.threadId !== input.threadId || state.persistence !== "active" || state.runtimeStatus !== "active" || !state.activeTurnId) {
      throw new CodexInterventionError("目标会话没有可确认的活动任务，消息未提交；未启动或排队新任务。");
    }
    input.assertCurrent?.();
    if (!isRemoteHost(hostId) && state.executionOwner === "desktop") {
      if (!this.desktop.submitThreadMessage) throw new CodexInterventionError("当前 Desktop 适配器不支持普通会话消息，未提交。");
      return this.desktop.submitThreadMessage(input);
    }
    // Other owners retain official compare-and-steer, with no foreign writer
    // fallback if ownership or turn identity changes during the request.
    return this.appServerFor(hostId).steer({ ...input, expectedTurnId: state.activeTurnId });
  }

  private nativeQueue(hostId?: string): CodexAppServerBackend & CodexNativeQueue {
    if (this.selectedBackend === "exec") throw new CodexBackendCapabilityError("nativeQueue", "exec");
    const backend = this.appServerFor(hostId);
    if (!backend.addQueuedSubmission || !backend.listQueuedSubmissions || !backend.deleteQueuedSubmission || !backend.runQueuedSubmission) {
      throw new CodexBackendCapabilityError("nativeQueue", "app-server");
    }
    return backend as CodexAppServerBackend & CodexNativeQueue;
  }

  async addQueuedSubmission(input: CodexQueueAddInput, hostId?: string) {
    this.options.onThreadMutation?.(input.threadId, hostId ?? "local");
    const backend = this.nativeQueue(hostId);
    const state = await this.inspectThread(input.threadId, hostId);
    // Selection is based on the fresh native owner, never a project name or
    // an old queue receipt. External ownership only changes admission, not the
    // selected backend or the native FIFO/receipt format.
    try {
      assertCodexThreadRunnable(state);
      if (state.threadId !== input.threadId) throw new Error("队列目标身份不匹配，消息未提交。");
    } catch (error) { throw new CodexQueueAdmissionError(error); }
    assertQueueAdmissionCurrent(input);
    return backend.addQueuedSubmission({ ...input, ...(state.executionOwner === "desktop" ? { enqueueOnly: true } : {}) });
  }
  async listQueuedSubmissions(threadId: string, cursor?: string, hostId?: string) {
    return this.nativeQueue(hostId).listQueuedSubmissions(threadId, cursor);
  }
  async deleteQueuedSubmission(threadId: string, queuedSubmissionId: string, hostId?: string, assertCurrent?: () => void) {
    assertCurrent?.();
    return this.nativeQueue(hostId).deleteQueuedSubmission(threadId, queuedSubmissionId, undefined, assertCurrent);
  }
  async runQueuedSubmission(input: CodexQueuedRunInput) {
    const lease: { scope?: CodexExecutionScope } = {};
    this.restartRuns.add(lease);
    try { return await this.runQueuedTracked(input, lease); }
    finally { this.restartRuns.delete(lease); }
  }
  private async runQueuedTracked(input: CodexQueuedRunInput, lease: { scope?: CodexExecutionScope }) {
    // Queue metadata can be read without owning the thread. Consumption is a
    // writer operation and must never steal a Desktop owner's execution.
    const backend = this.nativeQueue(input.hostId);
    const state = await this.inspectThread(input.threadId, input.hostId);
    if (!input.observeOnly) assertCodexThreadRunnable(state);
    if (input.observeOnly) {
      const turnId = input.acceptedTurnId;
      if (!turnId) throw new CodexInterventionError("只读结果恢复缺少已接收轮次，未启动任务。");
      const observed = await this.readTurnLifecycle(input.threadId, turnId, input.hostId);
      if (observed.status === "unknown" || observed.status === "inProgress" || observed.source === "unknown")
        throw new CodexCommunicationError("observation", "queue/observe", input.threadId, turnId);
      await input.onTurnStarted?.({ threadId: input.threadId, turnId });
      if (observed.status !== "completed") throw new CodexTurnExecutionError(observed.status, "原生轮次已确认结束", observed.failureCode);
      return { threadId: input.threadId, turnId, text: observed.text || "任务已完成。", raw: "" };
    }
    if (state.executionOwner === "desktop") throw new Error("Desktop 正在持有此会话，原生队列等待实际持有者消费；Gateway 不接管任务。");
    const watched = this.observationInput({ ...input, prompt: "" }, lease, backend.executionLifetime === "independent");
    return backend.runQueuedSubmission({ ...input, onTurnStarted: watched.onTurnStarted });
  }

  async readTurnLifecycle(threadId: string, turnId: string, hostId?: string): Promise<CodexTurnObservation> {
    const observed = observeOwnerTurn(await this.readThreadSnapshot(threadId, hostId), threadId, turnId);
    if (observed.source !== "unknown") return observed;
    const backend = this.appServerFor(hostId);
    return backend.readNativeTurnLifecycle ? backend.readNativeTurnLifecycle(threadId, turnId) : { status: "unknown", source: "unknown" };
  }
  async readThreadProvenance(threadId: string, hostId?: string) {
    if (this.selectedBackend === "exec") return undefined;
    return this.appServerFor(hostId).readThreadProvenance?.(threadId);
  }

  private async runImmediately(input: CodexRunnerInput, lease: { scope?: CodexExecutionScope }): Promise<CodexRunResult> {
    input.assertCurrent?.();
    if (isRemoteHost(input.hostId)) {
      if (this.selectedBackend === "exec") {
        throw new Error(
          "The codex exec backend cannot run a remote Codex Desktop project. " +
          "Select app-server or auto for remote projects."
        );
      }
      const backend = this.appServerFor(input.hostId);
      return backend.run(this.observationInput(input, lease, backend.executionLifetime === "independent"));
    }
    if (this.selectedBackend === "exec") {
      if (this.options.backend === "auto" && !canRunWithoutCapabilityLoss(this.exec, input)) {
        throw new CodexInterventionError("自动选择的 CLI 后端不支持本次请求的交互或项目能力；消息未提交，请显式选择支持这些能力的后端。");
      }
      return this.exec.run(withInlineDeveloperInstructions(input));
    }
    // Read and write must target the same owner. A private app-server can read
    // a Desktop rollout as notLoaded even when Desktop is actively working.
    if (input.threadId && this.desktopOwnedThreads.has(input.threadId)) {
      try {
        return await this.desktop.run(this.observationInput(withInlineDeveloperInstructions(input), lease, true));
      } catch (error) {
        // A cached renderer can disappear after inspection. Only an explicit
        // pre-submission negative discovery permits the guarded resume below.
        if (!(error instanceof CodexOwnerUnavailableError)) throw error;
        this.desktopOwnedThreads.delete(input.threadId);
      }
    }
    try {
      return await this.runOnAppServer(input, lease);
    } catch (error) {
      if (input.threadId && isActiveWriterError(error)) {
        this.desktopOwnedThreads.add(input.threadId);
        try {
          return await this.desktop.run(this.observationInput(withInlineDeveloperInstructions(input), lease, true));
        } catch (ownerError) {
          if (!(ownerError instanceof CodexOwnerUnavailableError)) throw ownerError;
          this.desktopOwnedThreads.delete(input.threadId);
          // The writer vanished between the lock rejection and discovery.
          // Exactly one retry of the SAME id, with app-server's writer lock;
          // no loop, force takeover, thread/start or CLI fallback.
          return this.runOnAppServer(input, lease);
        }
      }
      if (this.options.backend === "app-server" || this.selectedAutoBackend || this.appServerRuns > 0 || input.threadId
        || this.appServer.executionLifetime === "independent"
        || error instanceof CodexCommunicationError && error.submission !== "not-submitted" || !canRunWithoutCapabilityLoss(this.exec, input)) {
        throw error;
      }
      this.selectedAutoBackend = "exec";
      const fallback = await this.exec.run({
        ...withInlineDeveloperInstructions(input),
        onDelta: undefined,
        onProgress: undefined
      });
      this.selectedAutoBackend = "exec";
      return {
        ...fallback,
        text: `Warning: Codex app-server was unavailable, used codex exec fallback.\n\n${fallback.text}`
      };
    }
  }

  private observationInput(input: CodexRunnerInput, lease: { scope?: CodexExecutionScope }, independent: boolean): CodexRunnerInput {
    delete lease.scope;
    return { ...input, onTurnStarted: async event => {
      await input.onTurnStarted?.(event); // Durable source/audience receipts first.
      if (independent && !input.ephemeral && !input.onDynamicToolCall && !input.dynamicTools?.length
        && (event.status === undefined || event.status === "inProgress"))
        lease.scope = { hostId: input.hostId ?? "local", threadId: event.threadId, turnId: event.turnId };
    } };
  }

  private async runOnAppServer(input: CodexRunnerInput, lease: { scope?: CodexExecutionScope }): Promise<CodexRunResult> {
    const accepted = () => { if (this.options.backend === "auto") this.selectedAutoBackend = "app-server"; };
    this.appServerRuns++;
    try {
      const result = await this.appServer.run(this.observationInput({
        ...input,
        onThreadCreated: async (threadId) => {
          accepted();
          try { await input.onThreadCreated?.(threadId); }
          finally { await this.refreshDesktopTaskList(threadId); }
        },
        onTurnStarted: async turn => { accepted(); await input.onTurnStarted?.(turn); }
      }, lease, this.appServer.executionLifetime === "independent"));
      delete lease.scope;
      await this.refreshDesktopTaskList(result.threadId);
      if (this.options.backend === "auto") this.selectedAutoBackend = "app-server";
      return result;
    } finally { delete lease.scope; this.appServerRuns--; }
  }

  async stop(threadId?: string, hostId?: string, assertCurrent?: () => void): Promise<CodexStopResult> {
    assertCurrent?.();
    if (threadId) this.options.onThreadMutation?.(threadId, hostId ?? "local");
    if (isRemoteHost(hostId)) {
      return this.appServerFor(hostId).stop(threadId, assertCurrent);
    }
    if (this.selectedBackend === "exec") return this.exec.stop(threadId, assertCurrent);
    if (threadId) {
      const owner = await this.inspectThread(threadId);
      assertCurrent?.();
      if (owner.executionOwner === "desktop") {
        // Never use an unguarded interrupt to clear an optimistic UI tail.
        if (owner.runtimeStatus !== "active" || !owner.activeTurnId) return "not-active";
        return this.desktop.stop(threadId, owner.activeTurnId, assertCurrent);
      }
      return this.appServer.stop(threadId, assertCurrent);
    }
    const results = await Promise.all([this.appServer.stop(threadId, assertCurrent), this.desktop.stop(threadId, undefined, assertCurrent)]);
    return results.includes("interrupted") ? "interrupted" : "not-active";
  }

  async runEphemeral(input: EphemeralCodexRunnerInput): Promise<CodexRunResult> {
    if (this.selectedBackend === "exec") return Promise.reject(new CodexBackendCapabilityError("structuredOutput", "exec"));
    const lease = {};
    this.restartRuns.add(lease);
    try { return await this.appServer.run({
      ...input,
      ephemeral: true,
      sandbox: "read-only"
    }); } finally { this.restartRuns.delete(lease); }
  }

  async warmUp(cwd: string, hostId?: string): Promise<void> {
    await this.backendForSharedOperation(hostId).warmUp(cwd);
  }

  async listProjects(hostId?: string, observation?: Pick<CodexMetadataObservation, "timeoutMs">): Promise<CodexProjectCatalog> {
    if (observation && this.selectedBackend !== "exec") return this.metadataReader.projects(hostId ?? "local", observation.timeoutMs);
    if (isRemoteHost(hostId)) return this.appServerFor(hostId).listProjects();
    if (this.selectedBackend === "exec") return this.exec.listProjects();
    if (this.options.backend === "app-server" || this.selectedAutoBackend === "app-server") return this.appServer.listProjects();
    try {
      const catalog = await this.appServer.listProjects();
      this.selectedAutoBackend ??= "app-server";
      return catalog;
    } catch (error) {
      // Another discovery operation may already have selected App while this
      // project request was in flight. Never replace that catalog with CLI.
      if (this.selectedAutoBackend === "app-server") throw error;
      console.warn(
        `[codex-im-gateway] app-server project catalog unavailable; using CLI catalog: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      // A catalog fallback is a read result, not permission to switch writers.
      return this.exec.listProjects();
    }
  }

  async getHistory(threadId: string, hostId?: string): Promise<CodexHistoryMessage[]> {
    return this.backendForSharedOperation(hostId).getHistory(threadId);
  }

  readThreadSnapshot(threadId: string, hostId?: string): Promise<CodexThreadSnapshot> {
    return this.observeOnce("snapshot", threadId, hostId, () => this.readThreadSnapshotOnce(threadId, hostId));
  }

  private async readThreadSnapshotOnce(threadId: string, hostId?: string): Promise<CodexThreadSnapshot> {
    if (isRemoteHost(hostId) || this.selectedBackend === "exec") {
      return this.backendForSharedOperation(hostId).readThreadSnapshot(threadId);
    }
    let state: CodexThreadState;
    try { state = await this.readMetadata(threadId); }
    catch (error) {
      if (isCodexCommunicationFailure(error)) {
        const owner = await this.desktop.readThreadSnapshot?.(threadId).catch(() => undefined);
        if (owner && confirmedDesktopObservation(threadId, owner.state)) {
          this.desktopOwnedThreads.add(threadId); return owner;
        }
      }
      throw error;
    }
    if (["archived", "missing"].includes(state.persistence)) {
      this.desktopOwnedThreads.delete(threadId);
      return { state, turns: [] };
    }
    // An active task on this connection is authoritative. A persisted idle or
    // notLoaded record is not: ask the Desktop owner before using it.
    if (state.runtimeStatus !== "active") {
      const owner = await this.desktop.readThreadSnapshot?.(threadId);
      if (owner && confirmedDesktopObservation(threadId, owner.state)) { this.desktopOwnedThreads.add(threadId); return owner; }
    }
    this.desktopOwnedThreads.delete(threadId);
    // Only hydrate private turns when that backend is the owner, or no live
    // Desktop owner was confirmed. Foreign history can be arbitrarily large.
    try { return await this.appServer.readThreadSnapshot(threadId); }
    catch (error) {
      if (isCodexCommunicationFailure(error)) {
        const owner = await this.desktop.readThreadSnapshot?.(threadId).catch(() => undefined);
        if (owner && confirmedDesktopObservation(threadId, owner.state)) {
          this.desktopOwnedThreads.add(threadId); return owner;
        }
      }
      throw error;
    }
  }

  async getHistoryPage(
    threadId: string,
    input?: CodexHistoryPageInput,
    hostId?: string
  ): Promise<CodexHistoryPage> {
    return this.backendForSharedOperation(hostId).getHistoryPage(threadId, input);
  }

  async getRuntimeInfo(cwd: string, threadId?: string, hostId?: string, observation?: Pick<CodexMetadataObservation, "timeoutMs" | "purpose">): Promise<CodexRuntimeInfo> {
    if (observation && this.selectedBackend !== "exec") return (observation.purpose === "status" ? this.statusReader : this.metadataReader).runtime(cwd, threadId, hostId ?? "local", observation.timeoutMs);
    return this.backendForSharedOperation(hostId).getRuntimeInfo(cwd, threadId);
  }

  async listModels(): Promise<CodexModelOption[]> {
    return this.backendForSharedOperation().listModels();
  }

  async getAccountRateLimits(): Promise<CodexAccountBalance> {
    return this.backendForSharedOperation().getAccountRateLimits();
  }

  async getGoal(threadId: string, hostId?: string): Promise<CodexThreadGoal | undefined> {
    return this.backendForSharedOperation(hostId).getGoal(threadId);
  }

  async setGoal(
    threadId: string,
    input: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number },
    hostId?: string,
    assertCurrent?: () => void
  ): Promise<CodexThreadGoal | undefined> {
    assertCurrent?.();
    this.options.onThreadMutation?.(threadId, hostId ?? "local");
    return this.backendForSharedOperation(hostId).setGoal(threadId, input, assertCurrent);
  }

  async clearGoal(threadId: string, hostId?: string, assertCurrent?: () => void): Promise<void> {
    assertCurrent?.();
    await this.backendForSharedOperation(hostId).clearGoal(threadId, assertCurrent);
  }

  inspectThread(threadId: string, hostId?: string, observation?: CodexMetadataObservation): Promise<CodexThreadState> {
    // Project authorization needs current host-scoped membership, not an entire
    // history or Desktop writer ownership. Keep write preflight unchanged.
    if (observation) return this.observeOnce(observation.purpose === "status" ? "status" : "membership", threadId, hostId, () => this.selectedBackend === "exec"
      ? this.backendForSharedOperation(hostId).inspectThread(threadId)
      : (observation.purpose === "status" ? this.statusReader : this.metadataReader).inspect(threadId, hostId ?? "local", observation));
    return this.observeOnce("inspect", threadId, hostId, () => this.inspectThreadOnce(threadId, hostId));
  }

  private async inspectThreadOnce(threadId: string, hostId?: string): Promise<CodexThreadState> {
    let desktopObserved = false;
    try {
      if (isRemoteHost(hostId) || this.selectedBackend === "exec") {
        return await this.backendForSharedOperation(hostId).inspectThread(threadId);
      }
      // Most IM messages only need metadata. Fetch turns only if a live writer
      // needs a concrete compare-and-steer guard that metadata cannot supply.
      let state = await this.readMetadata(threadId);
      if (state.runtimeStatus === "active" && !state.activeTurnId) state = await this.appServer.inspectThread(threadId);
      if (state.runtimeStatus !== "active" && state.persistence !== "missing" && state.persistence !== "archived") {
        desktopObserved = true;
        const owner = await this.desktop.inspectThread?.(threadId);
        if (owner && confirmedDesktopObservation(threadId, owner)) { this.desktopOwnedThreads.add(threadId); return owner; }
      }
      this.desktopOwnedThreads.delete(threadId);
      return state;
    } catch (error) {
      // A failed private app-server read says nothing about Desktop's writer.
      // This is observation-only recovery: never resume/start or switch writes.
      if (!desktopObserved && !isRemoteHost(hostId) && this.selectedBackend !== "exec" && isCodexCommunicationFailure(error)) {
        const owner = await this.desktop.inspectThread?.(threadId).catch(() => undefined);
        if (owner && confirmedDesktopObservation(threadId, owner)) {
          this.desktopOwnedThreads.add(threadId); return owner;
        }
      }
      const failure = communicationError(error, { phase: "preflight", operation: "thread/read", threadId });
      if (failure instanceof CodexCommunicationError) console.warn(`[codex-im-gateway] backend observation ${JSON.stringify({
        timestamp: new Date().toISOString(), hostId: hostId ?? "local", threadId,
        phase: failure.phase, operation: failure.operation, code: failure.code, submission: failure.submission
      })}`);
      throw failure;
    }
  }

  private readMetadata(threadId: string): Promise<CodexThreadState> {
    return this.observeOnce("metadata", threadId, "local", () =>
      this.appServer.inspectThread(threadId, { includeTurns: false, timeoutMs: 5_000 }));
  }

  private observeOnce<T>(operation: string, threadId: string, hostId: string | undefined, read: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([this.selectedBackend, hostId ?? "local", threadId, operation]);
    const existing = this.observations.get(key);
    if (existing) return existing as Promise<T>;
    const work = Promise.resolve().then(read).finally(() => {
      if (this.observations.get(key) === work) this.observations.delete(key);
    });
    this.observations.set(key, work);
    return work;
  }

  listThreads(input?: CodexThreadListInput, hostId?: string): Promise<CodexThreadState[]> {
    return this.backendForSharedOperation(hostId).listThreads(input);
  }

  listSessionCatalog(input?: CodexThreadListInput, hostId?: string): Promise<CodexSessionCatalog> {
    const backend = this.backendForSharedOperation(hostId);
    // Discovery is a backend selection too. A later project-name lookup must
    // not silently switch /sessions to CLI if the App request fails.
    if (this.options.backend === "auto") this.selectedAutoBackend ??= backend.id;
    return backend.listSessionCatalog(input);
  }

  async archiveThread(threadId: string, hostId?: string): Promise<void> {
    this.options.onThreadMutation?.(threadId, hostId ?? "local");
    await this.backendForSharedOperation(hostId).archiveThread(threadId);
    if (!isRemoteHost(hostId)) await this.refreshDesktopTaskList();
  }

  async unarchiveThread(threadId: string, hostId?: string): Promise<CodexThreadState> {
    const state = await this.backendForSharedOperation(hostId).unarchiveThread(threadId);
    if (!isRemoteHost(hostId)) await this.refreshDesktopTaskList(threadId);
    return state;
  }

  async deleteThread(threadId: string, hostId?: string): Promise<void> {
    this.options.onThreadMutation?.(threadId, hostId ?? "local");
    await this.backendForSharedOperation(hostId).deleteThread(threadId);
    if (!isRemoteHost(hostId)) await this.refreshDesktopTaskList();
  }

  hasInFlightWork(): boolean {
    return Boolean(this.runTails.size || this.appServerRuns || this.appServer.hasInFlightWork?.()
      || this.exec.hasInFlightWork?.() || [...this.remoteAppServers.values()].some(runner => runner.hasInFlightWork?.()));
  }

  isIndependentObservation(scope: CodexExecutionScope): boolean {
    return [...this.restartRuns].some(lease => lease.scope?.hostId === scope.hostId
      && lease.scope.threadId === scope.threadId && lease.scope.turnId === scope.turnId);
  }

  hasRestartBlockingWork(): boolean {
    const blocking = (backend: CodexBackendAdapter) => backend.hasRestartBlockingWork?.() ?? backend.hasInFlightWork?.() ?? false;
    return [...this.restartRuns].some(lease => !lease.scope) || blocking(this.appServer) || blocking(this.exec)
      || [...this.remoteAppServers.values()].some(blocking);
  }

  detachIndependentObservations(): void {
    this.desktop.detachIndependentObservations?.();
    this.appServer.detachIndependentObservations?.();
    for (const backend of this.remoteAppServers.values()) backend.detachIndependentObservations?.();
  }

  async close(): Promise<void> {
    const stopping = [this.metadataReader.close(), this.statusReader.close(), this.appServer.close(), this.exec.close(), this.desktop.close(),
      ...[...this.remoteAppServers.values()].map(runner => runner.close())];
    this.remoteAppServers.clear();
    this.remoteTransports.clear();
    await Promise.all(stopping);
  }

  backendInfo(hostId?: string) {
    const backend = this.backendForSharedOperation(hostId);
    return { id: backend.id, capabilities: backend.capabilities };
  }

  private appServerFor(hostId?: string): CodexAppServerBackend {
    if (this.selectedBackend === "exec") throw new Error("当前为纯 CLI 后端，不支持远程主机或 App-server 操作；请切换后端配置。");
    if (!isRemoteHost(hostId)) return this.appServer;
    const existing = this.remoteAppServers.get(hostId);
    if (existing) return existing;
    const transport = this.remoteTransport(hostId);
    const runner = new AppServerCodexRunner({
      codexHome: this.options.codexHome,
      hostId,
      transport,
      requestTimeoutMs: this.options.timeoutMs,
      sandbox: this.options.execSandbox
    });
    this.remoteAppServers.set(hostId, runner);
    return runner;
  }

  private remoteTransport(hostId: string): ReturnType<typeof resolveRemoteCodexTransport> {
    let transport = this.remoteTransports.get(hostId);
    if (!transport) {
      transport = (this.options.remoteTransportResolver ?? resolveRemoteCodexTransport)(hostId, { codexHome: this.options.codexHome });
      this.remoteTransports.set(hostId, transport);
    }
    return transport;
  }

  private backendForSharedOperation(hostId?: string): CodexBackendAdapter {
    if (isRemoteHost(hostId)) return this.appServerFor(hostId);
    return this.selectedBackend === "exec" ? this.exec : this.appServer;
  }

  private async refreshDesktopTaskList(threadId?: string): Promise<void> {
    try {
      await this.desktop.refreshTaskList?.(threadId);
    } catch (error) {
      // Codex Desktop may be closed. Task persistence must not depend on the
      // renderer being present; the task will be discovered on its next load.
      console.warn(
        `[codex-im-gateway] unable to refresh Codex Desktop task list: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/** @deprecated Use CodexBackendRouter. Kept for API compatibility. */
export { CodexBackendRouter as HybridCodexRunner };

function isActiveWriterError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /already has an active writer/i.test(detail);
}

function isDesktopSteerCandidateError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /active writer|no active turn|当前没有正在执行|任务已经结束|not loaded|not subscribed/i.test(detail);
}

function isRemoteHost(hostId?: string): hostId is string {
  return Boolean(hostId && hostId !== "local");
}

function confirmedDesktopObservation(threadId: string, state: CodexThreadState): boolean {
  return state.threadId === threadId && state.executionOwner === "desktop" && state.persistence === "active"
    && (state.runtimeStatus === "idle" || state.runtimeStatus === "systemError" || state.runtimeStatus === "active" && Boolean(state.activeTurnId));
}

function canRunWithoutCapabilityLoss(backend: CodexBackendAdapter, input: CodexRunnerInput): boolean {
  const capabilities = backend.capabilities;
  if (input.onApproval && !capabilities.approvals) return false;
  if ((input.onDynamicToolCall || input.dynamicTools?.length) && !capabilities.dynamicTools) return false;
  if (input.onUserInput && !capabilities.userInput) return false;
  if (input.outputSchema && !capabilities.structuredOutput) return false;
  if (input.collaborationMode && input.collaborationMode !== "default" && !capabilities.collaborationModes) return false;
  if ((input.projectId || input.projectName) && !capabilities.projects) return false;
  if (input.threadTitle && !capabilities.threadNaming) return false;
  if (input.onThreadCreated && !capabilities.threadNaming) return false;
  return true;
}

function withInlineDeveloperInstructions(input: CodexRunnerInput): CodexRunnerInput {
  if (!input.developerInstructions?.trim()) return input;
  return {
    ...input,
    prompt: `${input.developerInstructions.trim()}\n\n${input.prompt}`.trim(),
    developerInstructions: undefined
  };
}
