import { resolveCodexCommand } from "../codex/exec-runner.js";
import type { CodexImGatewayConfig } from "../state/config.js";
import { embeddedTaskboardPort, startEmbeddedTaskboard, type EmbeddedTaskboard } from "./embedded-server.js";

/** The startup path and management settings control the same owned service. */
export class TaskboardLifecycle {
  private service?: EmbeddedTaskboard;
  private key?: string;
  private applied?: { dataDirectory: string; port: number; codexExecutable: string };
  private transition: Promise<void> = Promise.resolve();
  constructor(private readonly dataDirectory: string, private readonly start: typeof startEmbeddedTaskboard = startEmbeddedTaskboard) {}
  apply(config: Pick<CodexImGatewayConfig, "taskboardEnabled" | "taskboardUrl" | "codexBin">): Promise<void> {
    const work = this.transition.catch(() => {}).then(async () => {
      const key = JSON.stringify([config.taskboardUrl, config.codexBin]);
      if (config.taskboardEnabled && this.service && key === this.key) return;
      if (!config.taskboardEnabled) {
        await this.service?.close(); this.service = undefined; this.key = undefined; this.applied = undefined; return;
      }
      // Validate all deterministic inputs before touching the working listener.
      const command = resolveCodexCommand(config.codexBin);
      const desired = { dataDirectory: this.dataDirectory,
        port: embeddedTaskboardPort(config.taskboardUrl),
        codexExecutable: command.argsPrefix.length === 0 ? command.command : config.codexBin };
      const previous = this.service, previousOptions = this.applied;
      if (previous && previousOptions?.port === desired.port) {
        // The same port cannot be prepared alongside itself. Retain a complete
        // restart description and restore it if the replacement fails.
        await previous.close();
        try { this.service = await this.start(desired); }
        catch (error) {
          try { this.service = await this.start(previousOptions); }
          catch (rollback) { this.service = undefined; this.key = undefined; this.applied = undefined;
            throw new AggregateError([error, rollback], "Taskboard 替换和旧服务恢复均失败，请检查本机服务状态。"); }
          throw error;
        }
      } else {
        const prepared = await this.start(desired);
        try { await previous?.close(); }
        catch (error) { await prepared.close(); throw error; }
        this.service = prepared;
      }
      this.key = key;
      this.applied = desired;
    });
    this.transition = work; return work;
  }
  close(): Promise<void> {
    const work = this.transition.catch(() => {}).then(async () => {
      await this.service?.close(); this.service = undefined; this.key = undefined; this.applied = undefined;
    });
    this.transition = work; return work;
  }
}
