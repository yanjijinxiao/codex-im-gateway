import crypto from "node:crypto";
import type { ChannelTextClient } from "./types.js";
import { TextProgressBatcher } from "./text-progress.js";
import { channelProgressError } from "./errors.js";
import { summarizeProgress } from "./progress-summary.js";

const MAX_RECOVERY_PROBES = 3;

export type ChannelStreamCheckpoint = {
  streamId?: string;
  messageId?: string;
  startedAt: number;
  progressEntries: string[];
  thought: string;
  answerPreview: string;
  finished: boolean;
  /** Terminal delivery may be retried, but progress must never resume. */
  terminal?: { text: string; error: boolean };
  /** A delivery-error notice is not a replacement answer/card. Persist its receipt. */
  terminalNoticeSent?: boolean;
};

export class ChannelTurnTextStream {
  private readonly textProgress?: TextProgressBatcher;
  readonly supported: boolean;
  private messageId?: string;
  private readonly streamId: string;
  private phase: "active" | "backoff" | "unavailable" = "active";
  private failures = 0;
  private recoveryProbes = 0;
  private retryAt = 0;
  private suspended = false;
  private terminal?: { text: string; error: boolean };
  private finalizing?: Promise<boolean>;
  private terminalBlocked = false;
  private terminalNoticeSent = false;
  private notifying?: Promise<boolean>;
  private latestText = "";
  private startedAt = Date.now();
  private finished = false;
  private opening?: Promise<boolean>;
  private readonly progressEntries: string[] = [];
  private thought = "正在理解任务并规划下一步…";
  private answerPreview = "";
  private updateTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();
  private updating = false;
  private lastUpdateAt = 0;

  constructor(
    private readonly client: ChannelTextClient,
    private readonly toUserId: string,
    private readonly persistence?: {
      restore?: ChannelStreamCheckpoint;
      save: (checkpoint: ChannelStreamCheckpoint) => void;
      contextToken?: string;
      onTextDelivered?: (part: { messageId: string; text: string }) => void;
    }
  ) {
    const saved = persistence?.restore;
    this.supported = Boolean(saved?.messageId) || (client.capabilities
      ? client.capabilities.progress === "available" : Boolean(client.startTextStream && client.updateTextStream));
    // Choose presentation once per turn. Card failures never switch to text.
    if (!this.supported) this.textProgress = new TextProgressBatcher((text) => this.sendPlainText(text));
    this.streamId = saved?.streamId ?? saved?.messageId ?? `codex_bridge_${crypto.randomUUID().replaceAll("-", "")}`;
    if (saved) {
      this.messageId = saved.messageId;
      this.startedAt = saved.startedAt;
      this.progressEntries.push(...saved.progressEntries.map((entry) => summarizeProgress(entry)));
      this.thought = saved.thought;
      this.answerPreview = saved.answerPreview;
      this.finished = saved.finished;
      this.terminal = saved.terminal;
      this.terminalNoticeSent = saved.terminalNoticeSent ?? false;
    }
  }

  checkpoint(): ChannelStreamCheckpoint {
    return { streamId: this.streamId, messageId: this.messageId, startedAt: this.startedAt,
      progressEntries: [...this.progressEntries], thought: this.thought,
      answerPreview: this.answerPreview, finished: this.finished,
      ...(this.terminal ? { terminal: this.terminal } : {}),
      ...(this.terminalNoticeSent ? { terminalNoticeSent: true } : {}) };
  }

  deliveryState(): "active" | "pending" | "unavailable" | "finished" {
    if (this.finished || this.terminal) return "finished";
    if (this.phase !== "active" || this.suspended) return "unavailable";
    return this.messageId || !this.supported ? "active" : "pending";
  }

  /** Stop local timers without marking a remote card completed during shutdown. */
  async suspend(): Promise<void> { this.suspended = true; this.stopTimers(); await this.textProgress?.close(); await this.opening; await this.chain.catch(() => undefined); await this.notifying; }

  async flush(): Promise<void> {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
      await this.updateNow();
    }
    await this.chain;
  }

  /** Explicit recovery probe using the persisted handle, never a replacement card. */
  async synchronize(): Promise<"updated" | "text-only" | "unavailable" | "finished"> {
    if (this.finished || this.terminal) return "finished";
    if (this.suspended) return "unavailable";
    if (!this.supported) return "text-only";
    await this.opening;
    await this.chain.catch(() => undefined);
    if (this.finished || this.terminal || this.suspended) return "unavailable";
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.phase = "active";
    this.retryAt = 0;
    this.latestText = this.render();
    if (this.messageId) {
      this.startHeartbeat();
      await this.updateNow();
    } else {
      await this.openNow();
    }
    return this.phase === "active" && this.messageId ? "updated" : "unavailable";
  }

  async progress(text: string): Promise<boolean> {
    if (this.finished || this.terminal || this.suspended) return true;
    const content = summarizeProgress(text);
    if (!content) return false;
    if (content.startsWith("🤔")) {
      this.thought = boundedProgressText(content.replace(/^🤔\s*/, ""), 600);
    } else {
      const entry = boundedProgressText(content, 600);
      if (entry && this.progressEntries.at(-1) !== entry) {
        this.progressEntries.push(entry);
        if (this.progressEntries.length > 5) this.progressEntries.shift();
      }
      this.thought = thinkingStatusForProgress(content);
    }
    this.persistence?.save(this.checkpoint());
    if (this.supported) { await this.publish(this.render()); return true; }
    // Native text-only channels retain their normal progress presentation.
    try { return await this.textProgress!.push(content.startsWith("🤔") ? "任务正在执行，等待新的进展。" : content); }
    catch { console.warn("[codex-im-gateway] text progress delivery failed"); return true; }
  }

  async answer(text: string): Promise<boolean> {
    if (this.finished || this.terminal || this.suspended) return true;
    const content = text.trim();
    if (!content) return false;
    this.answerPreview = boundedProgressText(content, 2_400);
    this.thought = "正在组织最终回复…";
    return this.publish(this.render());
  }

  private async publish(content: string): Promise<boolean> {
    if (!this.supported || this.finished || this.terminal || this.suspended || !content) return false;
    this.latestText = content;
    if (this.phase === "unavailable" || Date.now() < this.retryAt) return false;
    if (this.opening) return this.opening;
    if (!this.messageId) return this.openNow();
    this.startHeartbeat();
    this.scheduleUpdate();
    return true;
  }

  async finalize(text: string, error = false): Promise<boolean> {
    const content = text.trim();
    if (this.finished) return true;
    if (!content) return false;
    // Set the terminal guard before awaiting any in-flight operation. A failed
    // final frame retains its handle and terminal payload for later recovery.
    this.terminal ??= { text: content, error };
    this.stopTimers();
    this.persistence?.save(this.checkpoint());
    if (this.finalizing) return this.finalizing;
    this.finalizing = this.finalizeNow();
    try { return await this.finalizing; } finally { this.finalizing = undefined; }
  }

  private async finalizeNow(): Promise<boolean> {
    await this.textProgress?.close();
    await this.opening;
    await this.chain.catch(() => undefined);
    if (!this.supported || !this.messageId || this.terminalBlocked) return false;
    try {
      await this.client.updateTextStream!({
        toUserId: this.toUserId,
        messageId: this.messageId,
        text: this.terminal!.text,
        finalize: true,
        ...(this.terminal!.error ? { error: true } : {})
      });
      this.finished = true;
      this.lastUpdateAt = Date.now();
      this.persistence?.save(this.checkpoint());
      return true;
    } catch (error) {
      // The hub retains terminalPending and retries only the final frame.
      console.warn("[codex-im-gateway] channel terminal progress update failed");
      this.terminalBlocked = !channelProgressError(error).retryable;
      return false;
    }
  }

  async fail(text: string): Promise<boolean> {
    return this.finalize(text, true);
  }

  /** Report failed terminal delivery once; never resend the answer as a new card. */
  async reportTerminalFailure(): Promise<boolean> {
    if (!this.supported || !this.terminal || this.finished) return false;
    if (this.terminalNoticeSent) return true;
    if (this.notifying) return this.notifying;
    this.notifying = (async () => {
      await this.sendPlainText(this.terminal!.error
        ? "任务执行失败，原 AI Card 也未能更新。请到原 Codex 会话查看详细错误。"
        : "最终答复未能更新原 AI Card。请到原 Codex 会话查看结果。");
      this.terminalNoticeSent = true;
      this.persistence?.save(this.checkpoint());
      return true;
    })();
    try { return await this.notifying; } finally { this.notifying = undefined; }
  }

  private async sendPlainText(text: string): Promise<void> {
    // Explicit plain delivery also carries a single terminal delivery-error
    // notice. It must never use sendText's implicit one-shot card conversion.
    const send = this.client.sendProgressText ?? (!this.client.capabilities ? this.client.sendText : undefined);
    if (!send) throw new Error("Channel plain-text operation unavailable");
    const sent = await send.call(this.client, { toUserId: this.toUserId, text,
      ...(this.persistence?.contextToken ? { contextToken: this.persistence.contextToken } : {}) });
    this.persistence?.onTextDelivered?.({ messageId: sent.messageId, text });
  }

  private async updateNow(): Promise<void> {
    if (this.updating) return this.chain;
    this.updating = true;
    let attemptedText = "";
    this.chain = this.chain.catch(() => undefined).then(async () => {
      if (!this.canUpdate() || !this.messageId || Date.now() < this.retryAt) return;
      // Read the latest snapshot only when this operation actually runs.
      const text = this.latestText;
      attemptedText = text;
      try {
        await this.client.updateTextStream!({ toUserId: this.toUserId, messageId: this.messageId, text });
        this.recovered();
      } catch (error) { this.unavailable(error); }
    });
    try { await this.chain; } finally {
      this.updating = false;
      if (attemptedText && this.latestText !== attemptedText && this.canUpdate()) this.scheduleUpdate();
    }
  }

  private scheduleUpdate(): void {
    if (this.updateTimer || !this.messageId || !this.canUpdate() || this.phase === "backoff") return;
    const delay = Math.max(0, 500 - (Date.now() - this.lastUpdateAt));
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.updateNow();
    }, delay);
    this.updateTimer.unref?.();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer || !this.canUpdate()) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.canUpdate() || !this.messageId || this.phase === "backoff") return;
      this.latestText = this.render();
      this.scheduleUpdate();
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.updateTimer = undefined;
    this.heartbeatTimer = undefined;
    this.retryTimer = undefined;
  }

  private render(): string {
    const sections = [
      "🤔 **正在思考**",
      this.thought || "正在处理当前任务…"
    ];
    if (this.progressEntries.length) {
      const entries = this.progressEntries.map((entry) => `- ${entry.replace(/\n/g, "\n  ")}`).join("\n");
      sections.push(`**最近进展**\n${entries}`);
    }
    if (this.answerPreview) {
      sections.push(`---\n✍️ **正在组织回复**\n\n${this.answerPreview}`);
    }
    sections.push(`_已运行 ${formatTurnElapsed(Date.now() - this.startedAt)} · 长任务会持续执行，发送 /stop 可停止_`);
    return sections.join("\n\n");
  }

  private canUpdate(): boolean {
    return !this.finished && !this.terminal && !this.suspended && this.phase !== "unavailable";
  }

  private async openNow(): Promise<boolean> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      try {
        const result = await this.client.startTextStream!({ toUserId: this.toUserId, text: this.latestText,
          streamId: this.streamId, ...(this.persistence?.contextToken ? { contextToken: this.persistence.contextToken } : {}) });
        this.messageId = result.messageId;
        this.recovered();
        return true;
      } catch (error) {
        const failure = channelProgressError(error);
        if (failure.messageId) this.messageId = failure.messageId;
        this.persistence?.save(this.checkpoint());
        this.unavailable(failure);
        return false;
      }
    })();
    try { return await this.opening; } finally { this.opening = undefined; }
  }

  private recovered(): void {
    const wasUnavailable = this.phase !== "active";
    this.phase = "active";
    this.failures = 0;
    this.recoveryProbes = 0;
    this.retryAt = 0;
    this.lastUpdateAt = Date.now();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.persistence?.save(this.checkpoint());
    this.startHeartbeat();
    if (wasUnavailable) this.reportRecovery("recovered");
  }

  private unavailable(error: unknown): void {
    if (this.finished || this.terminal || this.suspended) return;
    const failure = channelProgressError(error);
    const probe = !failure.retryable && failure.recoveryProbe && Boolean(this.messageId)
      && this.recoveryProbes < MAX_RECOVERY_PROBES;
    this.phase = failure.retryable || probe ? "backoff" : "unavailable";
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    if (!failure.retryable && !probe) {
      this.stopTimers();
      this.reportRecovery("unavailable");
      return;
    }
    const delay = Math.max(failure.retryAfterMs ?? 0, probe
      ? Math.min(120_000, 30_000 * 2 ** this.recoveryProbes++)
      : Math.min(60_000, 5_000 * 2 ** Math.min(this.failures++, 4)));
    this.retryAt = Date.now() + delay;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.canUpdate()) return;
      this.latestText = this.render();
      if (this.messageId) void this.updateNow();
      else void this.openNow();
    }, delay);
    this.retryTimer.unref?.();
    this.reportRecovery(probe ? "recovery_probe_scheduled" : "retry_scheduled", delay);
  }

  private reportRecovery(event: string, delayMs?: number): void {
    // Do not log commentary, shell arguments, tokens or raw provider errors.
    console.warn(`[codex-im-gateway] channel progress ${JSON.stringify({
      timestamp: new Date().toISOString(), event, streamId: this.streamId,
      messageId: this.messageId, phase: this.phase, recoveryProbes: this.recoveryProbes,
      ...(delayMs !== undefined ? { delayMs } : {})
    })}`);
  }
}

function thinkingStatusForProgress(progress: string): string {
  if (/命令|工具|检索|查询|检查|读取|下载/.test(progress) && !/完成|失败/.test(progress)) {
    return "正在等待当前步骤返回结果…";
  }
  if (/修改|写入|补丁/.test(progress) && !/完成|失败/.test(progress)) {
    return "正在应用并检查代码修改…";
  }
  if (/完成|成功/.test(progress)) return "正在分析刚完成步骤的结果并决定下一步…";
  if (/失败|错误/.test(progress)) return "正在分析失败原因并寻找可行的下一步…";
  return "正在处理当前步骤并决定下一步…";
}

function boundedProgressText(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function formatTurnElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
}
