import { AppServerCodexRunner } from "./app-server-runner.js";
import {
  resolveLocalAppServerTransport,
  type AppServerConnectionMode
} from "./app-server-daemon.js";
import { CodexExecRunner } from "./exec-runner.js";
import type { CodexExecSandbox } from "./sandbox.js";
import { DesktopCodexRunner } from "./desktop-runner.js";
import { resolveRemoteCodexTransport } from "./remote-host.js";
import type {
  CodexAppServerBackend,
  CodexBridgeBackend,
  CodexHistoryMessage,
  CodexHistoryPage,
  CodexHistoryPageInput,
  CodexModelOption,
  CodexProjectCatalog,
  CodexRunResult,
  CodexRunnerInput,
  CodexSteerInput,
  CodexSteerResult,
  CodexRuntimeInfo,
  CodexStopResult,
  CodexThreadListInput,
  CodexThreadState,
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
  desktopRunner?: Pick<DesktopCodexRunner, "run" | "steer" | "stop" | "close"> &
    Partial<Pick<DesktopCodexRunner, "refreshTaskList">>;
  appServerBackend?: CodexAppServerBackend;
  execBackend?: CodexBackendAdapter;
  remoteTransportResolver?: typeof resolveRemoteCodexTransport;
};

export type { EphemeralCodexRunnerInput } from "./backend.js";

export type HybridCodexRunnerOptions = CodexBackendRouterOptions;

/**
 * Stable Bridge facade over the two concrete Codex backends.
 *
 * Turn and shared catalog routing obey `backend` strictly. Protocol-only
 * operations (history, runtime, models and goals) use the app-server extension
 * because codex exec does not expose equivalent APIs.
 */
export class CodexBackendRouter implements CodexBridgeBackend {
  private readonly appServer: CodexAppServerBackend;
  private readonly exec: CodexBackendAdapter;
  private readonly desktop: Pick<DesktopCodexRunner, "run" | "steer" | "stop" | "close"> &
    Partial<Pick<DesktopCodexRunner, "refreshTaskList">>;
  private readonly remoteAppServers = new Map<string, CodexAppServerBackend>();
  private readonly runTails = new Map<string, Promise<void>>();

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
      codexBin: options.codexBin,
      requestTimeoutMs: options.timeoutMs,
      sandbox: options.execSandbox,
      transport: appServerTransport
    });
    this.exec = options.execBackend ?? new CodexExecRunner({
      codexBin: options.codexBin,
      sandbox: options.execSandbox,
      timeoutMs: options.timeoutMs
    });
    this.desktop = options.desktopRunner ?? new DesktopCodexRunner({ timeoutMs: options.timeoutMs });
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

  async steer(input: CodexSteerInput, hostId?: string): Promise<CodexSteerResult> {
    if (isRemoteHost(hostId)) return this.appServerFor(hostId).steer(input);
    if (this.options.backend === "exec") return this.exec.steer(input);
    try {
      return await this.appServer.steer(input);
    } catch (error) {
      if (!isDesktopSteerCandidateError(error)) throw error;
      return this.desktop.steer(input);
    }
  }

  private async runImmediately(input: CodexRunnerInput): Promise<CodexRunResult> {
    if (isRemoteHost(input.hostId)) {
      if (this.options.backend === "exec") {
        throw new Error(
          "The codex exec backend cannot run a remote Codex Desktop project. " +
          "Select app-server or auto for remote projects."
        );
      }
      return this.appServerFor(input.hostId).run(input);
    }
    if (this.options.backend === "exec") {
      return this.exec.run(withInlineDeveloperInstructions(input));
    }
    try {
      const result = await this.appServer.run({
        ...input,
        onThreadCreated: async (threadId) => {
          try {
            await input.onThreadCreated?.(threadId);
          } finally {
            await this.refreshDesktopTaskList(threadId);
          }
        }
      });
      await this.refreshDesktopTaskList(result.threadId);
      return result;
    } catch (error) {
      if (input.threadId && isActiveWriterError(error)) {
        return this.desktop.run(withInlineDeveloperInstructions(input));
      }
      if (this.options.backend === "app-server" || !canRunWithoutCapabilityLoss(this.exec, input)) {
        throw error;
      }
      const fallback = await this.exec.run({
        ...withInlineDeveloperInstructions(input),
        onDelta: undefined,
        onProgress: undefined
      });
      return {
        ...fallback,
        text: `Warning: Codex app-server was unavailable, used codex exec fallback.\n\n${fallback.text}`
      };
    }
  }

  async stop(threadId?: string, hostId?: string): Promise<CodexStopResult> {
    if (isRemoteHost(hostId)) {
      return this.appServerFor(hostId).stop(threadId);
    }
    if (threadId) {
      if (this.options.backend === "exec") return this.exec.stop(threadId);
      try {
        const result = await this.appServer.stop(threadId);
        if (result === "interrupted") return result;
      } catch (error) {
        if (!isDesktopSteerCandidateError(error)) throw error;
      }
      const state = await this.appServer.inspectThread(threadId);
      if (!state.activeTurnId) return "not-active";
      return this.desktop.stop(threadId, state.activeTurnId);
    }
    const results = await Promise.all([
      this.appServer.stop(threadId),
      this.exec.stop(threadId),
      this.desktop.stop(threadId)
    ]);
    return results.includes("interrupted") ? "interrupted" : "not-active";
  }

  runEphemeral(input: EphemeralCodexRunnerInput): Promise<CodexRunResult> {
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
    if (this.options.backend === "exec") return this.exec.listProjects();
    if (this.options.backend === "app-server") return this.appServer.listProjects();
    try {
      return await this.appServer.listProjects();
    } catch (error) {
      console.warn(
        `[codex-im-gateway] app-server project catalog unavailable; using CLI catalog: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return this.exec.listProjects();
    }
  }

  async getHistory(threadId: string, hostId?: string): Promise<CodexHistoryMessage[]> {
    return this.appServerFor(hostId).getHistory(threadId);
  }

  async readThreadSnapshot(threadId: string, hostId?: string) {
    return this.appServerFor(hostId).readThreadSnapshot(threadId);
  }

  async getHistoryPage(
    threadId: string,
    input?: CodexHistoryPageInput,
    hostId?: string
  ): Promise<CodexHistoryPage> {
    return this.appServerFor(hostId).getHistoryPage(threadId, input);
  }

  async getRuntimeInfo(cwd: string, threadId?: string, hostId?: string): Promise<CodexRuntimeInfo> {
    return this.appServerFor(hostId).getRuntimeInfo(cwd, threadId);
  }

  async listModels(): Promise<CodexModelOption[]> {
    return this.appServer.listModels();
  }

  async getAccountRateLimits(): Promise<CodexAccountBalance> {
    return this.appServer.getAccountRateLimits();
  }

  async getGoal(threadId: string, hostId?: string): Promise<CodexThreadGoal | undefined> {
    return this.appServerFor(hostId).getGoal(threadId);
  }

  async setGoal(
    threadId: string,
    input: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number },
    hostId?: string
  ): Promise<CodexThreadGoal | undefined> {
    return this.appServerFor(hostId).setGoal(threadId, input);
  }

  async clearGoal(threadId: string, hostId?: string): Promise<void> {
    await this.appServerFor(hostId).clearGoal(threadId);
  }

  inspectThread(threadId: string, hostId?: string): Promise<CodexThreadState> {
    return this.appServerFor(hostId).inspectThread(threadId);
  }

  listThreads(input?: CodexThreadListInput, hostId?: string): Promise<CodexThreadState[]> {
    return this.appServerFor(hostId).listThreads(input);
  }

  async archiveThread(threadId: string, hostId?: string): Promise<void> {
    await this.appServerFor(hostId).archiveThread(threadId);
    if (!isRemoteHost(hostId)) await this.refreshDesktopTaskList();
  }

  async unarchiveThread(threadId: string, hostId?: string): Promise<CodexThreadState> {
    const state = await this.appServerFor(hostId).unarchiveThread(threadId);
    if (!isRemoteHost(hostId)) await this.refreshDesktopTaskList(threadId);
    return state;
  }

  async deleteThread(threadId: string, hostId?: string): Promise<void> {
    await this.appServerFor(hostId).deleteThread(threadId);
    if (!isRemoteHost(hostId)) await this.refreshDesktopTaskList();
  }

  close(): void {
    this.appServer.close();
    this.exec.close();
    this.desktop.close();
    for (const runner of this.remoteAppServers.values()) runner.close();
    this.remoteAppServers.clear();
  }

  private appServerFor(hostId?: string): CodexAppServerBackend {
    if (!isRemoteHost(hostId)) return this.appServer;
    const existing = this.remoteAppServers.get(hostId);
    if (existing) return existing;
    const transport = (this.options.remoteTransportResolver ?? resolveRemoteCodexTransport)(hostId);
    const runner = new AppServerCodexRunner({
      transport,
      requestTimeoutMs: this.options.timeoutMs,
      sandbox: this.options.execSandbox
    });
    this.remoteAppServers.set(hostId, runner);
    return runner;
  }

  private backendForSharedOperation(hostId?: string): CodexBackendAdapter {
    if (isRemoteHost(hostId)) return this.appServerFor(hostId);
    return this.options.backend === "exec" ? this.exec : this.appServer;
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
