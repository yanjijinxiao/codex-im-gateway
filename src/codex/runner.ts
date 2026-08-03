import {
  AppServerCodexRunner,
  type CodexHistoryMessage,
  type CodexModelOption,
  type CodexRunnerInput,
  type CodexRuntimeInfo
} from "./app-server-runner.js";
import { CodexExecRunner, type CodexRunResult } from "./exec-runner.js";
import type { CodexExecSandbox } from "./sandbox.js";
import type { CodexAccountBalance } from "./account-balance.js";

export type CodexBackend = "auto" | "app-server" | "exec";

export type HybridCodexRunnerOptions = {
  backend: CodexBackend;
  codexBin?: string;
  execSandbox?: CodexExecSandbox;
  timeoutMs?: number;
};

export class HybridCodexRunner {
  private readonly appServer: AppServerCodexRunner;
  private readonly exec: CodexExecRunner;
  private readonly runTails = new Map<string, Promise<void>>();

  constructor(private readonly options: HybridCodexRunnerOptions) {
    this.appServer = new AppServerCodexRunner({
      codexBin: options.codexBin,
      requestTimeoutMs: options.timeoutMs,
      sandbox: options.execSandbox
    });
    this.exec = new CodexExecRunner({
      codexBin: options.codexBin,
      sandbox: options.execSandbox,
      timeoutMs: options.timeoutMs
    });
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    const queueKey = input.queueKey ?? input.threadId;
    if (!queueKey) return this.runImmediately(input);

    const predecessor = this.runTails.get(queueKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = (predecessor ?? Promise.resolve()).catch(() => undefined).then(() => gate);
    this.runTails.set(queueKey, tail);
    try {
      if (predecessor) {
        await input.onProgress?.("当前会话的上一条消息仍在处理中，已加入队列。");
        await predecessor.catch(() => undefined);
      }
      return await this.runImmediately(input);
    } finally {
      release();
      if (this.runTails.get(queueKey) === tail) {
        this.runTails.delete(queueKey);
      }
    }
  }

  private async runImmediately(input: CodexRunnerInput): Promise<CodexRunResult> {
    const requiresAppServerForStreaming = Boolean(input.onDelta || input.onProgress || input.onApproval);
    if (this.options.backend === "exec" && !requiresAppServerForStreaming) {
      return this.exec.run(input);
    }
    try {
      return await this.appServer.run(input);
    } catch (error) {
      if (this.options.backend === "app-server" || input.onApproval) {
        throw error;
      }
      const fallback = await this.exec.run({
        ...input,
        onDelta: undefined,
        onProgress: undefined
      });
      return {
        ...fallback,
        text: `Warning: Codex app-server was unavailable, used codex exec fallback.\n\n${fallback.text}`
      };
    }
  }

  async stop(threadId?: string): Promise<void> {
    await Promise.all([
      this.appServer.stop(threadId),
      this.exec.stop(threadId)
    ]);
  }

  async getHistory(threadId: string): Promise<CodexHistoryMessage[]> {
    return this.appServer.getHistory(threadId);
  }

  async getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo> {
    return this.appServer.getRuntimeInfo(cwd, threadId);
  }

  async listModels(): Promise<CodexModelOption[]> {
    return this.appServer.listModels();
  }

  async getAccountRateLimits(): Promise<CodexAccountBalance> {
    return this.appServer.getAccountRateLimits();
  }

  close(): void {
    this.appServer.close();
    this.exec.close();
  }
}
