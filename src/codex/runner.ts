import { AppServerCodexRunner } from "./app-server-runner.js";
import path from "node:path";
import {
  resolveLocalAppServerTransport,
  type AppServerConnectionMode
} from "./app-server-daemon.js";
import { CodexExecRunner } from "./exec-runner.js";
import type { CodexExecSandbox } from "./sandbox.js";
import { DesktopCodexRunner } from "./desktop-runner.js";
import { CodexBackendCapabilityError, CodexOwnerUnavailableError } from "./backend.js";
import { communicationError } from "./communication-error.js";
import { resolveRemoteCodexTransport } from "./remote-host.js";
import { stageRemoteFiles, type StageInboundFiles } from "./inbound-files.js";
import type {
  CodexAppServerBackend,
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
    Partial<Pick<DesktopCodexRunner, "refreshTaskList" | "readThreadSnapshot" | "inspectThread">>;
  appServerBackend?: CodexAppServerBackend;
  execBackend?: CodexBackendAdapter;
  remoteTransportResolver?: typeof resolveRemoteCodexTransport;
  stageAttachments?: StageInboundFiles;
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
  private readonly appServer: CodexAppServerBackend;
  private readonly exec: CodexBackendAdapter;
  private readonly desktop: Pick<DesktopCodexRunner, "run" | "steer" | "stop" | "close"> &
    Partial<Pick<DesktopCodexRunner, "refreshTaskList" | "readThreadSnapshot" | "inspectThread">>;
  private readonly remoteAppServers = new Map<string, CodexAppServerBackend>();
  private readonly remoteTransports = new Map<string, ReturnType<typeof resolveRemoteCodexTransport>>();
  private readonly runTails = new Map<string, Promise<void>>();
  private readonly desktopOwnedThreads = new Set<string>();
  private selectedAutoBackend?: "exec" | "app-server";
  private get selectedBackend() { return this.options.backend === "auto" ? this.selectedAutoBackend ?? "app-server" : this.options.backend; }

  constructor(private readonly options: CodexBackendRouterOptions) {
    const requestedTransport = options.appServerTransport ?? "auto";
    const effectiveTransport = requestedTransport === "auto"
      && options.codexBin
      && options.codexBin !== "codex"
      ? "stdio"
      : requestedTransport;
    const appServerTransport = resolveLocalAppServerTransport({
      mode: effectiveTransport
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
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    const queueKey = input.queueKey ?? input.threadId;
    const routedQueueKey = queueKey ? `${input.hostId ?? "local"}:${queueKey}` : undefined;
    if (!routedQueueKey) return this.runImmediately(input);

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
      return await this.runImmediately(input);
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
    if (isRemoteHost(hostId)) return this.appServerFor(hostId).steer(input);
    if (this.selectedBackend === "exec") return this.exec.steer(input);
    const state = await this.inspectThread(input.threadId);
    if (state.executionOwner === "desktop") return this.desktop.steer(input);
    try {
      return await this.appServer.steer(input);
    } catch (error) {
      if (!isDesktopSteerCandidateError(error)) throw error;
      return this.desktop.steer(input);
    }
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
    return this.nativeQueue(hostId).addQueuedSubmission(input);
  }
  async listQueuedSubmissions(threadId: string, cursor?: string, hostId?: string) {
    return this.nativeQueue(hostId).listQueuedSubmissions(threadId, cursor);
  }
  async deleteQueuedSubmission(threadId: string, queuedSubmissionId: string, hostId?: string) {
    return this.nativeQueue(hostId).deleteQueuedSubmission(threadId, queuedSubmissionId);
  }
  async runQueuedSubmission(input: CodexQueuedRunInput) {
    // Queue metadata can be read without owning the thread. Consumption is a
    // writer operation and must never steal a Desktop owner's execution.
    const backend = this.nativeQueue(input.hostId);
    const state = await this.inspectThread(input.threadId, input.hostId);
    if (state.executionOwner === "desktop" && !input.observeOnly) throw new Error("Desktop 正在持有此会话，原生队列等待实际持有者消费；Gateway 不接管任务。");
    return backend.runQueuedSubmission(input);
  }

  private async runImmediately(input: CodexRunnerInput): Promise<CodexRunResult> {
    if (isRemoteHost(input.hostId)) {
      if (this.selectedBackend === "exec") {
        throw new Error(
          "The codex exec backend cannot run a remote Codex Desktop project. " +
          "Select app-server or auto for remote projects."
        );
      }
      return this.appServerFor(input.hostId).run(input);
    }
    if (this.selectedBackend === "exec") {
      return this.exec.run(withInlineDeveloperInstructions(input));
    }
    // Read and write must target the same owner. A private app-server can read
    // a Desktop rollout as notLoaded even when Desktop is actively working.
    if (input.threadId && this.desktopOwnedThreads.has(input.threadId)) {
      try {
        return await this.desktop.run(withInlineDeveloperInstructions(input));
      } catch (error) {
        // A cached renderer can disappear after inspection. Only an explicit
        // pre-submission negative discovery permits the guarded resume below.
        if (!(error instanceof CodexOwnerUnavailableError)) throw error;
        this.desktopOwnedThreads.delete(input.threadId);
      }
    }
    try {
      return await this.runOnAppServer(input);
    } catch (error) {
      if (input.threadId && isActiveWriterError(error)) {
        this.desktopOwnedThreads.add(input.threadId);
        try {
          return await this.desktop.run(withInlineDeveloperInstructions(input));
        } catch (ownerError) {
          if (!(ownerError instanceof CodexOwnerUnavailableError)) throw ownerError;
          this.desktopOwnedThreads.delete(input.threadId);
          // The writer vanished between the lock rejection and discovery.
          // Exactly one retry of the SAME id, with app-server's writer lock;
          // no loop, force takeover, thread/start or CLI fallback.
          return this.runOnAppServer(input);
        }
      }
      if (this.options.backend === "app-server" || this.selectedAutoBackend || input.threadId || !canRunWithoutCapabilityLoss(this.exec, input)) {
        throw error;
      }
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

  private async runOnAppServer(input: CodexRunnerInput): Promise<CodexRunResult> {
    const result = await this.appServer.run({
      ...input,
      onThreadCreated: async (threadId) => {
        try { await input.onThreadCreated?.(threadId); }
        finally { await this.refreshDesktopTaskList(threadId); }
      }
    });
    await this.refreshDesktopTaskList(result.threadId);
    if (this.options.backend === "auto") this.selectedAutoBackend = "app-server";
    return result;
  }

  async stop(threadId?: string, hostId?: string): Promise<CodexStopResult> {
    if (isRemoteHost(hostId)) {
      return this.appServerFor(hostId).stop(threadId);
    }
    if (this.selectedBackend === "exec") return this.exec.stop(threadId);
    if (threadId) {
      const owner = await this.inspectThread(threadId);
      if (owner.executionOwner === "desktop") {
        // Never use an unguarded interrupt to clear an optimistic UI tail.
        if (owner.runtimeStatus !== "active" || !owner.activeTurnId) return "not-active";
        return this.desktop.stop(threadId, owner.activeTurnId);
      }
      return this.appServer.stop(threadId);
    }
    const results = await Promise.all([this.appServer.stop(threadId), this.desktop.stop(threadId)]);
    return results.includes("interrupted") ? "interrupted" : "not-active";
  }

  runEphemeral(input: EphemeralCodexRunnerInput): Promise<CodexRunResult> {
    if (this.selectedBackend === "exec") return Promise.reject(new CodexBackendCapabilityError("structuredOutput", "exec"));
    return this.appServer.run({
      ...input,
      ephemeral: true,
      sandbox: "read-only"
    });
  }

  async warmUp(cwd: string, hostId?: string): Promise<void> {
    await this.backendForSharedOperation(hostId).warmUp(cwd);
  }

  async listProjects(hostId?: string): Promise<CodexProjectCatalog> {
    if (isRemoteHost(hostId)) return this.appServerFor(hostId).listProjects();
    if (this.selectedBackend === "exec") return this.exec.listProjects();
    if (this.options.backend === "app-server" || this.selectedAutoBackend === "app-server") return this.appServer.listProjects();
    try {
      const catalog = await this.appServer.listProjects();
      this.selectedAutoBackend = "app-server";
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
      this.selectedAutoBackend = "exec";
      return this.exec.listProjects();
    }
  }

  async getHistory(threadId: string, hostId?: string): Promise<CodexHistoryMessage[]> {
    return this.backendForSharedOperation(hostId).getHistory(threadId);
  }

  async readThreadSnapshot(threadId: string, hostId?: string): Promise<CodexThreadSnapshot> {
    if (isRemoteHost(hostId) || this.selectedBackend === "exec") {
      return this.backendForSharedOperation(hostId).readThreadSnapshot(threadId);
    }
    const snapshot = await this.appServer.readThreadSnapshot(threadId);
    if (["archived", "missing"].includes(snapshot.state.persistence)) {
      this.desktopOwnedThreads.delete(threadId);
      return snapshot;
    }
    // An active task on this connection is authoritative. A persisted idle or
    // notLoaded record is not: ask the Desktop owner before using it.
    if (snapshot.state.runtimeStatus !== "active") {
      const owner = await this.desktop.readThreadSnapshot?.(threadId);
      if (owner) { this.desktopOwnedThreads.add(threadId); return owner; }
    }
    this.desktopOwnedThreads.delete(threadId);
    return snapshot;
  }

  async getHistoryPage(
    threadId: string,
    input?: CodexHistoryPageInput,
    hostId?: string
  ): Promise<CodexHistoryPage> {
    return this.backendForSharedOperation(hostId).getHistoryPage(threadId, input);
  }

  async getRuntimeInfo(cwd: string, threadId?: string, hostId?: string): Promise<CodexRuntimeInfo> {
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
    hostId?: string
  ): Promise<CodexThreadGoal | undefined> {
    return this.backendForSharedOperation(hostId).setGoal(threadId, input);
  }

  async clearGoal(threadId: string, hostId?: string): Promise<void> {
    await this.backendForSharedOperation(hostId).clearGoal(threadId);
  }

  async inspectThread(threadId: string, hostId?: string): Promise<CodexThreadState> {
    try {
      if (isRemoteHost(hostId) || this.selectedBackend === "exec") {
        return await this.backendForSharedOperation(hostId).inspectThread(threadId);
      }
      // Most IM messages only need metadata. Fetch turns only if a live writer
      // needs a concrete compare-and-steer guard that metadata cannot supply.
      let state = await this.appServer.inspectThread(threadId, { includeTurns: false, timeoutMs: 15_000 });
      if (state.runtimeStatus === "active" && !state.activeTurnId) state = await this.appServer.inspectThread(threadId);
      if (state.runtimeStatus !== "active" && state.persistence !== "missing" && state.persistence !== "archived") {
        const owner = await this.desktop.inspectThread?.(threadId);
        if (owner) { this.desktopOwnedThreads.add(threadId); return owner; }
      }
      this.desktopOwnedThreads.delete(threadId);
      return state;
    } catch (error) { throw communicationError(error, { phase: "preflight", operation: "thread/read", threadId }); }
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
    await this.backendForSharedOperation(hostId).archiveThread(threadId);
    if (!isRemoteHost(hostId)) await this.refreshDesktopTaskList();
  }

  async unarchiveThread(threadId: string, hostId?: string): Promise<CodexThreadState> {
    const state = await this.backendForSharedOperation(hostId).unarchiveThread(threadId);
    if (!isRemoteHost(hostId)) await this.refreshDesktopTaskList(threadId);
    return state;
  }

  async deleteThread(threadId: string, hostId?: string): Promise<void> {
    await this.backendForSharedOperation(hostId).deleteThread(threadId);
    if (!isRemoteHost(hostId)) await this.refreshDesktopTaskList();
  }

  close(): void {
    this.appServer.close();
    this.exec.close();
    this.desktop.close();
    for (const runner of this.remoteAppServers.values()) runner.close();
    this.remoteAppServers.clear();
    this.remoteTransports.clear();
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
