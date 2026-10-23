import crypto from "node:crypto";
import type { ChannelTextClient } from "./types.js";
import { TextProgressBatcher } from "./text-progress.js";
import { channelProgressError } from "./errors.js";
import { summarizeProgress, meaningfulProgress, progressKind } from "./progress-summary.js";
import { DEFAULT_RESULT_PAGE_BYTES, resultPages } from "./result-pages.js";
import { restoredBootstrap, canRetryUnsentCreation, type ChannelStreamBootstrap, type ChannelStreamFailure } from "./stream-bootstrap.js";

const MAX_RECOVERY_PROBES = 3;

export type ChannelStreamCheckpoint = {
  streamId?: string;
  messageId?: string;
  /** Persist before a create POST; missing acknowledgement must not be replayed after a crash. */
  creationAttempted?: boolean;
  bootstrap?: ChannelStreamBootstrap;
  presentationFailure?: ChannelStreamFailure;
  startedAt: number;
  progressEntries: string[];
  thought: string;
  answerPreview: string;
  finished: boolean;
  /** Presentation notice, never a task-completion receipt. */
  communicationNotice?: string;
  /** Native execution recovery, independent of transport/delivery retry. */
  recoveryNotice?: string;
  toolActivity?: { completed: number; failed: number; active?: string; last?: string };
  /** Terminal delivery may be retried, but progress must never resume. */
  terminal?: { text: string; error: boolean };
  /** A delivery-error notice is not a replacement answer/card. Persist its receipt. */
  terminalNoticeSent?: boolean;
  /** Pinned layout and acknowledged pages survive a restart/partial failure. */
  resultPageBytes?: number;
  resultPresentation?: "card" | "native-text";
  terminalPages?: Array<{ messageId?: string; delivered: boolean; attempted?: boolean; bootstrap?: ChannelStreamBootstrap }>;
  /** Independent presentation segments within the SAME native turn. */
  segments?: {
    acceptedInputs: string[];
    previous: Array<{ inputId: string; checkpoint: ChannelStreamCheckpoint; attempts: number; retryAt?: number }>;
    answerPrefix?: { length: number; digest: string };
  };
};

export class ChannelTurnTextStream {
  private readonly textProgress?: TextProgressBatcher;
  readonly supported: boolean;
  private messageId?: string;
  private creationAttempted = false;
  private bootstrap?: ChannelStreamBootstrap;
  private presentationFailure?: ChannelStreamFailure;
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
  private resultPageBytes?: number;
  private resultPresentation?: "card" | "native-text";
  private terminalPages: NonNullable<ChannelStreamCheckpoint["terminalPages"]> = [];
  private notifying?: Promise<boolean>;
  private latestText = "";
  private startedAt = Date.now();
  private finished = false;
  private communicationNotice?: string;
  private recoveryNotice?: string;
  private toolActivity = { completed: 0, failed: 0 } as NonNullable<ChannelStreamCheckpoint["toolActivity"]>;
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
      progressEnabled?: boolean;
    }
  ) {
    const saved = persistence?.restore;
    this.supported = saved?.resultPresentation === "native-text" ? false
      : saved?.resultPresentation === "card" || Boolean(saved?.messageId || saved?.bootstrap || saved?.creationAttempted) || (persistence?.progressEnabled !== false && (client.capabilities
        ? client.capabilities.progress === "available" : Boolean(client.startTextStream && client.updateTextStream)));
    // Choose presentation once per turn. Card failures never switch to text.
    if (!this.supported) this.textProgress = new TextProgressBatcher((text) => this.sendPlainText(text));
    this.streamId = saved?.streamId ?? saved?.messageId ?? `codex_bridge_${crypto.randomUUID().replaceAll("-", "")}`;
    if (saved) {
      this.messageId = saved.messageId;
      this.creationAttempted = saved.creationAttempted ?? false;
      this.bootstrap = saved.bootstrap ? restoredBootstrap(saved.bootstrap) : undefined;
      this.presentationFailure = saved.presentationFailure;
      if (this.bootstrap?.stage === "delivered") this.messageId ??= this.bootstrap.messageId;
      this.startedAt = saved.startedAt;
      this.progressEntries.push(...meaningfulProgress(saved.progressEntries));
      this.toolActivity = saved.toolActivity ? { ...saved.toolActivity } : {
        completed: saved.progressEntries.filter(entry => entry.startsWith("✅")).length,
        failed: saved.progressEntries.filter(entry => entry.startsWith("❌")).length
      };
      this.thought = saved.thought;
      this.answerPreview = saved.answerPreview;
      this.finished = saved.finished;
      this.communicationNotice = saved.communicationNotice;
      this.recoveryNotice = saved.recoveryNotice;
      this.terminal = saved.terminal;
      this.terminalNoticeSent = saved.terminalNoticeSent ?? false;
      this.resultPageBytes = saved.resultPageBytes;
      this.resultPresentation = saved.resultPresentation;
      this.terminalPages = saved.terminalPages?.map(page => ({ ...page, ...(page.bootstrap ? { bootstrap: restoredBootstrap(page.bootstrap) } : {}) })) ?? [];
    }
  }

  checkpoint(): ChannelStreamCheckpoint {
    return { streamId: this.streamId, messageId: this.messageId, creationAttempted: this.creationAttempted, startedAt: this.startedAt,
      ...(this.bootstrap ? { bootstrap: structuredClone(this.bootstrap) } : {}),
      ...(this.presentationFailure ? { presentationFailure: this.presentationFailure } : {}),
      progressEntries: [...this.progressEntries], thought: this.thought,
      answerPreview: this.answerPreview, finished: this.finished,
      ...(this.communicationNotice ? { communicationNotice: this.communicationNotice } : {}),
      ...(this.recoveryNotice ? { recoveryNotice: this.recoveryNotice } : {}),
      toolActivity: { ...this.toolActivity },
      ...(this.terminal ? { terminal: this.terminal } : {}),
      ...(this.resultPageBytes ? { resultPageBytes: this.resultPageBytes, resultPresentation: this.resultPresentation,
        terminalPages: this.terminalPages.map(page => ({ ...page })) } : {}),
      ...(this.terminalNoticeSent ? { terminalNoticeSent: true } : {}) };
  }

  deliveryState(): "active" | "pending" | "unavailable" | "finished" {
    if (this.finished || this.terminal) return "finished";
    if (this.phase !== "active" || this.suspended) return "unavailable";
    if (this.creationAttempted && !this.messageId && !this.opening) return "unavailable";
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
  async synchronize(options: { confirmUncertainDelivery?: boolean } = {}): Promise<"updated" | "text-only" | "unavailable" | "finished"> {
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
      await this.openNow(true, options.confirmUncertainDelivery);
    }
    return this.phase === "active" && this.messageId ? "updated" : "unavailable";
  }

  async progress(text: string): Promise<boolean> {
    if (this.finished || this.terminal || this.suspended) return true;
    const content = summarizeProgress(text);
    if (!content) return false;
    this.communicationNotice = undefined;
    this.recoveryNotice = undefined;
    const kind = progressKind(content);
    if (kind === "thought") {
      this.thought = boundedProgressText(content.replace(/^🤔\s*/, ""), 600);
    } else if (kind === "activity" || kind === "failure") {
      if (this.toolActivity.last !== content) {
        this.toolActivity.last = content;
        if (kind === "failure") this.toolActivity.failed++;
        else if (content.startsWith("✅")) this.toolActivity.completed++;
      }
      this.toolActivity.active = /^[🔎✏️]/u.test(content) ? boundedProgressText(content, 100) : undefined;
      if (kind === "failure") this.progressEntries.push(boundedProgressText(content, 600));
    } else {
      const entry = boundedProgressText(content, 600);
      if (entry && this.progressEntries.at(-1) !== entry) {
        this.progressEntries.push(entry);
      }
    }
    this.progressEntries.splice(0, this.progressEntries.length, ...meaningfulProgress(this.progressEntries));
    this.persistence?.save(this.checkpoint());
    if (this.supported) { await this.publish(this.render()); return true; }
    // Native text-only channels retain their normal progress presentation.
    try { return kind === "thought" || kind === "activity" ? true : await this.textProgress!.push(content); }
    catch { console.warn("[codex-im-gateway] text progress delivery failed"); return true; }
  }

  async answer(text: string): Promise<boolean> {
    if (this.finished || this.terminal || this.suspended) return true;
    const content = text.trim();
    if (!content) return false;
    this.communicationNotice = undefined;
    this.recoveryNotice = undefined;
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

  async finalize(text: string, error = false, recovery: { recoverBootstrap?: boolean; confirmUncertainDelivery?: boolean; existingOnly?: boolean } = {}): Promise<boolean> {
    const content = text.trim();
    if (this.finished) return true;
    // A shutdown-detached writer must not poison the checkpoint that its
    // replacement follower will resume while the Codex task is still running.
    if (this.suspended) return false;
    if (!content) return false;
    // Set the terminal guard before awaiting any in-flight operation. A failed
    // final frame retains its handle and terminal payload for later recovery.
    this.terminal ??= { text: content, error };
    this.recoveryNotice = undefined;
    this.stopTimers();
    this.persistence?.save(this.checkpoint());
    if (this.finalizing) return this.finalizing;
    const recoverBootstrap = recovery.recoverBootstrap || canRetryUnsentCreation(this.bootstrap);
    if (recoverBootstrap) this.terminalBlocked = false;
    this.finalizing = this.finalizeNow(recoverBootstrap, recovery.confirmUncertainDelivery, recovery.existingOnly);
    try { return await this.finalizing; } finally { this.finalizing = undefined; }
  }

  private async finalizeNow(recoverBootstrap = false, confirmUncertainDelivery = false, existingOnly = false): Promise<boolean> {
    await this.textProgress?.close();
    await this.opening;
    await this.chain.catch(() => undefined);
    if (this.suspended || this.terminalBlocked) return false;
    this.resultPageBytes ??= this.client.capabilities?.resultPageBytes ?? DEFAULT_RESULT_PAGE_BYTES;
    this.resultPresentation ??= this.supported ? "card" : "native-text";
    const pages = resultPages(this.terminal!.text, this.resultPageBytes);
    // Historical recovery may update acknowledged cards, but must not create
    // new notifications (including continuation pages or native text). Check
    // the complete layout before updating page 1 so partial recovery is quiet.
    if (existingOnly && (!this.supported || !this.messageId || pages.some((_, index) => index > 0
      && !this.terminalPages[index]?.messageId && this.terminalPages[index]?.bootstrap?.stage !== "delivered"))) return false;
    while (this.terminalPages.length < pages.length) this.terminalPages.push({ delivered: false });
    this.persistence?.save(this.checkpoint());
    if (!this.supported) {
      for (const [index, page] of pages.entries()) {
        const receipt = this.terminalPages[index];
        if (receipt.delivered) continue;
        // Native text has no stable logical creation ID. An uncertain send must
        // not be automatically replayed after a restart and duplicate a result.
        if (receipt.attempted) return false;
        receipt.attempted = true;
        this.persistence?.save(this.checkpoint());
        try {
          const sent = await this.client.sendText({ toUserId: this.toUserId, text: page.text,
            ...(this.persistence?.contextToken ? { contextToken: this.persistence.contextToken } : {}) });
          if (!sent.messageId?.trim()) throw new Error("Channel returned no text receipt");
          receipt.messageId = sent.messageId;
          receipt.delivered = true;
          this.persistence?.save(this.checkpoint());
          this.persistence?.onTextDelivered?.({ messageId: sent.messageId, text: page.text });
        } catch { return false; }
      }
      this.finished = true;
      this.persistence?.save(this.checkpoint());
      return true;
    }
    // Page 1 reuses the original progress card. Only a completed long answer
    // creates continuation cards, each with its own stable logical identity.
    if (!this.messageId) {
      this.latestText = pages[0].text;
      if (!await this.openNow(recoverBootstrap, confirmUncertainDelivery) || !this.messageId) return false;
    }
    this.terminalPages[0].messageId = this.messageId;
    try {
      for (const [index, page] of pages.entries()) {
        const receipt = this.terminalPages[index];
        if (receipt.delivered) continue;
        if (!receipt.messageId) {
          const resume = recoverBootstrap && receipt.bootstrap && ["created", "delivery-rejected", "delivery-unconfirmed"].includes(receipt.bootstrap.stage);
          if (receipt.bootstrap?.stage === "delivered") receipt.messageId = receipt.bootstrap.messageId;
          if (receipt.attempted && !receipt.messageId && !(resume || recoverBootstrap && receipt.bootstrap?.stage === "create-rejected")) return false;
          if (receipt.bootstrap?.stage === "delivery-unconfirmed" && !confirmUncertainDelivery) return false;
          receipt.attempted = true;
          this.persistence?.save(this.checkpoint());
          try {
            const pageId = `${this.streamId}_page_${index + 1}`;
            const input = { toUserId: this.toUserId, text: page.text, streamId: pageId,
              onBootstrap: (state: ChannelStreamBootstrap) => {
                if (state.instanceId !== pageId || state.recipientId !== this.toUserId) throw new Error("Continuation bootstrap identity mismatch");
                receipt.bootstrap = structuredClone(state);
                if (state.stage === "delivered") receipt.messageId = state.messageId;
                this.persistence?.save(this.checkpoint());
              }, ...(this.persistence?.contextToken ? { contextToken: this.persistence.contextToken } : {}) };
            const created = receipt.messageId ? { messageId: receipt.messageId } : resume
              ? await this.client.resumeTextStream!({ ...input, bootstrap: receipt.bootstrap!, confirmUncertainDelivery })
              : await this.client.startTextStream!(input);
            if (!created.messageId?.trim()) throw new Error("Channel returned no continuation receipt");
            receipt.messageId = created.messageId;
          } catch (error) {
            const failure = channelProgressError(error);
            if (failure.messageId) receipt.messageId = failure.messageId;
            if (failure.retryable && !receipt.bootstrap) receipt.attempted = false;
            throw error;
          } finally { this.persistence?.save(this.checkpoint()); }
        }
        await this.client.updateTextStream!({ toUserId: this.toUserId, messageId: receipt.messageId!,
          text: page.text, finalize: true, ...(this.terminal!.error ? { error: true } : {}) });
        receipt.delivered = true;
        this.persistence?.save(this.checkpoint());
      }
      this.finished = true;
      this.lastUpdateAt = Date.now();
      this.persistence?.save(this.checkpoint());
      return true;
    } catch (error) {
      // The hub retains terminalPending and retries only the final frame.
      console.warn("[codex-im-gateway] channel terminal progress update failed");
      this.terminalBlocked = !channelProgressError(error).retryable;
      this.recordFailure(error);
      return false;
    }
  }

  async fail(text: string): Promise<boolean> {
    return this.finalize(text, true);
  }

  /** A lost backend receipt cannot finish a provider stream or assert task failure. */
  async waitForBackend(text: string): Promise<boolean> {
    if (this.finished || this.terminal || this.suspended) return false;
    this.communicationNotice = text.trim();
    this.recoveryNotice = undefined;
    this.persistence?.save(this.checkpoint());
    if (!this.supported) {
      try { await this.sendPlainText(text); return true; } catch { return false; }
    }
    const published = await this.publish(this.render());
    await this.flush();
    return published && this.deliveryState() === "active";
  }

  /** Native retry keeps the same handle and is never a terminal frame. */
  async waitForRecovery(text: string): Promise<boolean> {
    if (this.finished || this.terminal || this.suspended || !text.trim()) return false;
    if (this.recoveryNotice === text.trim()) return true;
    this.recoveryNotice = text.trim();
    this.communicationNotice = undefined;
    this.persistence?.save(this.checkpoint());
    if (!this.supported) {
      try { return await this.textProgress!.push(text); } catch { return false; }
    }
    const published = await this.publish(this.render());
    await this.flush();
    return published && this.deliveryState() === "active";
  }

  /** Report failed terminal delivery once; never resend the answer as a new card. */
  async reportTerminalFailure(): Promise<boolean> {
    if (!this.terminal || this.finished || this.suspended) return false;
    if (this.terminalNoticeSent) return true;
    // A locally blocked create is still waiting for routing, not a failed
    // update to an existing card. Background recovery will retry it safely.
    if (canRetryUnsentCreation(this.bootstrap)) return false;
    if (this.notifying) return this.notifying;
    this.notifying = (async () => {
      await this.sendPlainText(!this.supported
        ? "最终答复有页面未确认送达，未自动重发以避免重复。可用 /history 查看完整结果。"
        : !this.messageId
        ? "最终答复的 AI Card 尚未确认创建或投递。可用 /status 查看送达状态，或到原 Codex 会话查看结果。"
        : this.terminal!.error
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
    const current = this.progressEntries.filter(entry => progressKind(entry) === "update").at(-1);
    const sections = [
      this.communicationNotice ? "⏳ **等待后端确认**" : this.recoveryNotice ? "⏳ **等待 Codex 后续状态**" : current ? "**当前进展**" : "**任务执行中**",
      this.communicationNotice || this.recoveryNotice || current || this.thought || "等待新的可展示进展。"
    ];
    // Keep an actual public reasoning summary available without replacing a
    // concrete task update with a generated, generic "thinking" sentence.
    if (current && this.thought && this.thought !== current
      && !/^(?:正在理解任务并规划下一步|正在等待当前步骤返回结果|正在应用并检查代码修改|正在分析刚完成步骤的结果并决定下一步|正在分析失败原因并寻找可行的下一步|正在处理当前步骤并决定下一步)/.test(this.thought)) {
      sections.push(`**公开摘要**\n${boundedProgressText(this.thought, 240)}`);
    }
    const recent = this.progressEntries.filter(entry => entry !== current);
    if (recent.length) {
      const entries = recent.map((entry) => `- ${entry.replace(/\n/g, "\n  ")}`).join("\n");
      sections.push(`**关键进展与异常**\n${entries}`);
    }
    if (this.toolActivity.active) sections.push(`_工具活动：${this.toolActivity.active}_`);
    else if (this.toolActivity.completed || this.toolActivity.failed) sections.push(`_工具活动：${this.toolActivity.completed} 次成功${this.toolActivity.failed ? `，${this.toolActivity.failed} 次失败（不代表整体任务失败）` : ""}_`);
    if (this.answerPreview) {
      sections.push(`---\n✍️ **正在组织回复**\n\n${this.answerPreview}`);
    }
    sections.push(this.communicationNotice ? "_只读核对原会话中；未重发消息或停止原任务_"
      : this.recoveryNotice ? "_保留本张进度卡；等待 Codex 后续进展或最终状态_"
      : `_已运行 ${formatTurnElapsed(Date.now() - this.startedAt)} · 长任务会持续执行，发送 /stop 可停止_`);
    return sections.join("\n\n");
  }

  private canUpdate(): boolean {
    return !this.finished && !this.terminal && !this.suspended && this.phase !== "unavailable";
  }

  private async openNow(recover = false, confirmUncertainDelivery = false): Promise<boolean> {
    if (this.opening) return this.opening;
    recover ||= canRetryUnsentCreation(this.bootstrap);
    const resume = this.bootstrap && ["created", "delivery-rejected", "delivery-unconfirmed"].includes(this.bootstrap.stage);
    if (this.creationAttempted && !this.messageId && !(recover && (resume && this.client.resumeTextStream
      || this.bootstrap?.stage === "create-rejected"))) return false;
    if (this.bootstrap?.stage === "delivery-unconfirmed" && !confirmUncertainDelivery) return false;
    this.creationAttempted = true;
    this.persistence?.save(this.checkpoint());
    this.opening = (async () => {
      try {
        const input = { toUserId: this.toUserId, text: this.latestText, streamId: this.streamId,
          onBootstrap: (state: ChannelStreamBootstrap) => this.saveBootstrap(state),
          ...(this.persistence?.contextToken ? { contextToken: this.persistence.contextToken } : {}) };
        const result = resume && recover
          ? await this.client.resumeTextStream!({ ...input, bootstrap: this.bootstrap!, confirmUncertainDelivery })
          : await this.client.startTextStream!(input);
        if (!result.messageId?.trim()) throw new Error("Channel returned no card receipt");
        this.messageId = result.messageId;
        this.recovered();
        return true;
      } catch (error) {
        const failure = channelProgressError(error);
        if (failure.messageId) this.messageId = failure.messageId;
        if (failure.retryable && !this.bootstrap) this.creationAttempted = false;
        if (this.terminal) this.terminalBlocked = !failure.retryable;
        this.persistence?.save(this.checkpoint());
        this.unavailable(failure);
        return false;
      }
    })();
    try { return await this.opening; } finally { this.opening = undefined; }
  }

  private saveBootstrap(state: ChannelStreamBootstrap): void {
    if (state.instanceId !== this.streamId || state.recipientId !== this.toUserId) throw new Error("Stream bootstrap identity mismatch");
    this.bootstrap = structuredClone(state);
    if (state.stage === "delivered") this.messageId = state.messageId;
    this.persistence?.save(this.checkpoint());
  }

  private recovered(): void {
    const wasUnavailable = this.phase !== "active";
    this.phase = "active";
    this.failures = 0;
    this.recoveryProbes = 0;
    this.retryAt = 0;
    this.presentationFailure = undefined;
    this.lastUpdateAt = Date.now();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.persistence?.save(this.checkpoint());
    this.startHeartbeat();
    if (wasUnavailable) this.reportRecovery("recovered");
  }

  private unavailable(error: unknown): void {
    this.recordFailure(error);
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

  private recordFailure(error: unknown): void {
    const diagnostic = channelProgressError(error).diagnostic;
    if (diagnostic) { this.presentationFailure = diagnostic; this.persistence?.save(this.checkpoint()); }
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
