import type { ChannelTextClient } from "./types.js";
import { TextProgressBatcher } from "./text-progress.js";

export type ChannelStreamCheckpoint = {
  messageId?: string;
  startedAt: number;
  progressEntries: string[];
  thought: string;
  answerPreview: string;
  finished: boolean;
};

export class ChannelTurnTextStream {
  private readonly fallback: TextProgressBatcher;
  readonly supported: boolean;
  private messageId?: string;
  private disabled = false;
  private latestText = "";
  private startedAt = Date.now();
  private finished = false;
  private opening?: Promise<boolean>;
  private readonly progressEntries: string[] = [];
  private thought = "正在理解任务并规划下一步…";
  private answerPreview = "";
  private updateTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();
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
    this.fallback = new TextProgressBatcher(async (text) => {
      const sent = await client.sendText({ toUserId, text, ...(persistence?.contextToken ? { contextToken: persistence.contextToken } : {}) });
      persistence?.onTextDelivered?.({ messageId: sent.messageId, text });
    });
    this.supported = client.capabilities ? client.capabilities.progress === "available" : Boolean(client.startTextStream && client.updateTextStream);
    const saved = persistence?.restore;
    if (saved) {
      this.messageId = saved.messageId;
      this.startedAt = saved.startedAt;
      this.progressEntries.push(...saved.progressEntries);
      this.thought = saved.thought;
      this.answerPreview = saved.answerPreview;
      this.finished = saved.finished;
    }
  }

  checkpoint(): ChannelStreamCheckpoint {
    return { messageId: this.messageId, startedAt: this.startedAt,
      progressEntries: [...this.progressEntries], thought: this.thought,
      answerPreview: this.answerPreview, finished: this.finished };
  }

  /** Stop local timers without marking a remote card completed during shutdown. */
  async suspend(): Promise<void> { this.stopTimers(); await this.fallback.close(); await this.opening; await this.chain.catch(() => undefined); }

  async flush(): Promise<void> {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
      await this.updateNow();
    }
    await this.chain;
  }

  async progress(text: string): Promise<boolean> {
    if (this.finished) return true;
    const content = text.trim();
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
    if (await this.publish(this.render())) return true;
    try { return await this.fallback.push(content); }
    catch { console.warn("[codex-im-gateway] text progress delivery failed"); return true; }
  }

  async answer(text: string): Promise<boolean> {
    const content = text.trim();
    if (!content) return false;
    this.answerPreview = boundedProgressText(content, 2_400);
    this.thought = "正在组织最终回复…";
    return this.publish(this.render());
  }

  private async publish(content: string): Promise<boolean> {
    if (!this.supported || this.disabled || this.finished || !content) return false;
    this.latestText = content;
    if (this.opening) await this.opening;
    if (!this.messageId) {
      this.opening = (async () => { try {
        const result = await this.client.startTextStream!({ toUserId: this.toUserId, text: content });
        this.messageId = result.messageId;
        this.persistence?.save(this.checkpoint());
        this.lastUpdateAt = Date.now();
        this.startHeartbeat();
        return true;
      } catch (error) {
        this.disable(error);
        return false;
      } })();
      try { return await this.opening; } finally { this.opening = undefined; }
    }
    this.startHeartbeat();
    this.scheduleUpdate();
    return true;
  }

  async finalize(text: string, error = false): Promise<boolean> {
    const content = text.trim();
    await this.fallback.close();
    await this.opening;
    if (this.finished) return true;
    if (!this.supported || !this.messageId || !content) return false;
    this.finished = true;
    this.stopTimers();
    await this.chain.catch(() => undefined);
    try {
      // A transient progress update failure disables further non-terminal
      // frames, but it must not prevent the final frame from closing an
      // already-created card. Otherwise the answer falls back to a separate
      // message while the original card remains stuck in "thinking" forever.
      await this.client.updateTextStream!({
        toUserId: this.toUserId,
        messageId: this.messageId,
        text: content,
        finalize: true,
        ...(error ? { error: true } : {})
      });
      this.lastUpdateAt = Date.now();
      this.persistence?.save(this.checkpoint());
      return true;
    } catch (error) {
      this.finished = false;
      this.disable(error);
      return false;
    }
  }

  async fail(text: string): Promise<boolean> {
    return this.finalize(text, true);
  }

  private async updateNow(): Promise<void> {
    if (this.disabled || this.finished || !this.messageId) return;
    const text = this.latestText;
    this.chain = this.chain.then(async () => {
      if (this.finished) return;
      await this.client.updateTextStream!({
        toUserId: this.toUserId, messageId: this.messageId!, text
      });
      this.lastUpdateAt = Date.now();
      this.persistence?.save(this.checkpoint());
    });
    await this.chain;
  }

  private scheduleUpdate(): void {
    if (this.updateTimer || !this.messageId) return;
    const delay = Math.max(0, 500 - (Date.now() - this.lastUpdateAt));
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.updateNow().catch((error) => this.disable(error));
    }, delay);
    this.updateTimer.unref?.();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.disabled || !this.messageId) return;
      this.latestText = this.render();
      this.scheduleUpdate();
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.updateTimer = undefined;
    this.heartbeatTimer = undefined;
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

  private disable(error: unknown): void {
    this.disabled = true;
    this.stopTimers();
    console.warn(`[codex-im-gateway] channel text stream disabled for this turn: ${error instanceof Error ? error.message : String(error)}`);
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
