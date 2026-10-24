import { resolveCodexCommand } from "../codex/exec-runner.js";
import type { CodexImGatewayConfig } from "../state/config.js";
import { embeddedTaskboardPort, startEmbeddedTaskboard, type EmbeddedTaskboard } from "./embedded-server.js";

/** The startup path and management settings control the same owned service. */
export class TaskboardLifecycle {
  private service?: EmbeddedTaskboard;
  private key?: string;
  private transition: Promise<void> = Promise.resolve();
  constructor(private readonly dataDirectory: string) {}
  apply(config: Pick<CodexImGatewayConfig, "taskboardEnabled" | "taskboardUrl" | "codexBin">): Promise<void> {
    const work = this.transition.catch(() => {}).then(async () => {
      const key = JSON.stringify([config.taskboardUrl, config.codexBin]);
      if (config.taskboardEnabled && this.service && key === this.key) return;
      await this.service?.close(); this.service = undefined; this.key = undefined;
      if (!config.taskboardEnabled) return;
      const command = resolveCodexCommand(config.codexBin);
      this.service = await startEmbeddedTaskboard({ dataDirectory: this.dataDirectory,
        port: embeddedTaskboardPort(config.taskboardUrl),
        codexExecutable: command.argsPrefix.length === 0 ? command.command : config.codexBin });
      this.key = key;
    });
    this.transition = work; return work;
  }
  close(): Promise<void> {
    const work = this.transition.catch(() => {}).then(async () => {
      await this.service?.close(); this.service = undefined; this.key = undefined;
    });
    this.transition = work; return work;
  }
}
