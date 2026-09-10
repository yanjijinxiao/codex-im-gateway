import crypto from "node:crypto";
import type { CodexBridgeBackend, CodexThreadSnapshot, CodexThreadState } from "../codex/backend.js";
import type { ChannelTextClient } from "../channels/types.js";
import { ChannelTurnTextStream, type ChannelStreamCheckpoint } from "../channels/progress.js";
import { parseActionBlocks } from "../bridge/actions.js";
import { chunkText } from "../bridge/format.js";
import { SessionControlQueue } from "../bridge/session-control.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";

export type ThreadSubscription = {
  key: string;
  hostId: string;
  threadId: string;
  recipientId: string;
  client: ChannelTextClient;
  managed: boolean;
  enabled?: boolean;
  contextToken?: string;
  onTextDelivered?: (part: { messageId: string; text: string }) => void;
};
type FollowState = {
  eventVersion?: number;
  hostId: string;
  threadId: string;
  turnId?: string;
  sequence: number;
  delivered: string[];
  completed: string[];
  baseline?: string[];
  retired?: string[];
  startedAt?: string;
  checkpoint?: ChannelStreamCheckpoint;
  initialized: boolean;
  runtime?: CodexThreadState;
  observedAt?: string;
  terminalPending?: { turnId: string; text: string; fallbackSent: boolean };
};
type Options = {
  filePath: string;
  subscriptions: () => ThreadSubscription[];
  backend: () => Pick<CodexBridgeBackend, "readThreadSnapshot">;
  intervalMs?: number;
};

/**
 * Persistent delivery cursors and card handles, keyed by account/binding and
 * host/thread. Backend snapshots are read-only; following never acquires a writer.
 * Local rollout notifications supply low-latency hints; snapshots repair missed
 * notifications and recover turns completed while the gateway was stopped.
 */
export class ThreadEventHub {
  private readonly states: Record<string, FollowState>;
  private readonly streams = new Map<string, ChannelTurnTextStream>();
  private readonly queue = new SessionControlQueue();
  private timer?: NodeJS.Timeout;
  private scan?: Promise<void>;
  private stopped = false;
  constructor(private readonly options: Options) {
    this.states = readJsonFile(options.filePath, {});
    for (const state of Object.values(this.states)) {
      if (state.eventVersion !== 2) {
        // Older delivery records could contain guardian output attributed to
        // its parent. Keep the card handle, but never replay that saved text.
        state.eventVersion = 2;
        state.initialized = false;
        state.completed = [];
        state.baseline = [];
        delete state.terminalPending;
        if (state.checkpoint) state.checkpoint = { ...state.checkpoint,
          progressEntries: [], thought: "正在恢复会话跟随…", answerPreview: "" };
      }
      if (!state.baseline) {
        state.baseline = state.completed;
        state.completed = state.checkpoint?.finished && state.turnId ? [state.turnId] : [];
      }
    }
  }
  private save(): void { writeJsonFile(this.options.filePath, this.states); }
  private state(sub: ThreadSubscription): FollowState {
    let state = this.states[sub.key];
    if (state && !state.threadId && state.hostId === sub.hostId) state.threadId = sub.threadId;
    if (!state || state.hostId !== sub.hostId || state.threadId !== sub.threadId) {
      state = { eventVersion: 2, hostId: sub.hostId, threadId: sub.threadId, sequence: 0,
        delivered: [], completed: [], baseline: [], initialized: false };
      this.states[sub.key] = state;
      this.save();
    }
    return state;
  }
  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh().catch(report), this.options.intervalMs ?? 5_000);
    this.timer.unref();
    void this.refresh().catch(report);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scan;
    await Promise.all([...this.streams.values()].map((stream) => stream.suspend()));
    this.streams.clear();
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.scan) return this.scan;
    this.scan = this.scanSubscriptions();
    try { await this.scan; } finally { this.scan = undefined; }
  }
  private async scanSubscriptions(): Promise<void> {
    const all = this.options.subscriptions();
    const subscriptions = all.filter((sub) => sub.enabled !== false);
    const live = new Set(subscriptions.map((sub) => sub.key));
    for (const sub of all) {
      if (sub.enabled === false && this.states[sub.key]?.checkpoint?.messageId
        && !this.states[sub.key].checkpoint?.finished && !this.streams.has(sub.key)) this.stream(sub);
    }
    for (const [key, stream] of this.streams) {
      if (!live.has(key)) {
        await stream.finalize("已停止跟随此会话；任务继续运行。");
        await stream.suspend();
        this.streams.delete(key);
      }
    }
    for (const key of Object.keys(this.states)) {
      if (!live.has(key)) {
        // Disabled bindings above can restore their cards. Deleted accounts no
        // longer provide a client, so only their local cursor can be retired.
        delete this.states[key];
      }
    }
    const snapshots = new Map<string, Promise<CodexThreadSnapshot>>();
    await Promise.all(subscriptions.map(async (sub) => {
      if (!sub.threadId || typeof this.options.backend().readThreadSnapshot !== "function") return;
      const sequenceBeforeRead = this.states[sub.key]?.sequence ?? 0;
      const key = JSON.stringify([sub.hostId, sub.threadId]);
      if (!snapshots.has(key)) snapshots.set(key,
        this.options.backend().readThreadSnapshot(sub.threadId, sub.hostId));
      try {
        const snapshot = await snapshots.get(key)!;
        if (this.stopped) return;
        await this.queue.run(sub.key, async () => {
          if ((this.states[sub.key]?.sequence ?? 0) !== sequenceBeforeRead) return;
          await this.reconcile(sub, snapshot);
        });
      } catch (error) { report(error); }
    }));
    this.save();
  }
  private async reconcile(sub: ThreadSubscription, snapshot: CodexThreadSnapshot): Promise<void> {
    const state = this.state(sub);
    state.runtime = snapshot.state;
    state.observedAt = new Date().toISOString();
    if (state.terminalPending) {
      await this.finish(sub, state.terminalPending.turnId, state.terminalPending.text);
      if (state.terminalPending) return;
    }
    const { turns } = snapshot;
    if (!state.initialized) {
      // History replay handles past turns; only current and subsequent turns
      // are forwarded. This boundary is retained across service restarts.
      state.baseline = turns.filter((turn) => turn.status !== "inProgress" && turn.id !== state.turnId).map((turn) => turn.id);
      state.initialized = true;
      this.save();
    }
    const unavailable = ["archived", "missing"].includes(snapshot.state.persistence)
      || snapshot.state.runtimeStatus === "systemError";
    if (unavailable) {
      if (state.turnId) await this.finish(sub, state.turnId, "会话已归档、不可用或发生系统错误；请在 Codex 中检查。");
      return;
    }
    if (state.turnId && !turns.some((turn) => turn.id === state.turnId)
      && snapshot.state.runtimeStatus === "idle") {
      await this.finish(sub, state.turnId, "原任务已不在最近记录中。请用 /history 查看结果。");
    }
    for (const turn of turns) {
      if (state.completed.includes(turn.id) || state.baseline?.includes(turn.id)) continue;
      if (sub.managed) {
        if (turn.status === "inProgress") { state.turnId = turn.id; this.save(); }
        continue;
      }
      if (turn.status === "inProgress") {
        const activeId = snapshot.state.activeTurnId
          ?? turns.filter((item) => item.status === "inProgress").at(-1)?.id;
        if (turn.id !== activeId) continue;
        if (!await this.selectTurn(sub, turn.id, snapshot.state.runtimeStatus === "active")) continue;
        const progress = turn.messages.filter((message) => message.role === "assistant" && message.kind === "progress");
        if (!progress.length) await this.deliver(sub, turn.id, "已连接正在执行的任务，等待新的进展。");
        for (const message of progress) await this.deliver(sub, turn.id, message.text);
      } else {
        // A private App Server reconstructs foreign, unloaded turns as
        // completed/interrupted even while Desktop is still executing them.
        // Only a loaded runtime or an explicit lifecycle event can end a card.
        if (snapshot.state.runtimeStatus === "notLoaded" || snapshot.state.runtimeStatus === "unknown") continue;
        const final = turn.messages.filter((message) => message.role === "assistant" && message.kind !== "progress")
          .map((message) => message.text).join("\n\n");
        await this.finish(sub, turn.id, final || (turn.status === "completed" ? "任务已完成。" : "任务已停止或执行失败。"),
          Boolean(state.turnId && state.completed.includes(state.turnId)));
      }
    }
  }
  /** Only an actual start event (or a loaded backend snapshot) may switch turns. */
  async started(hostId: string, threadId: string, turnId: string, startedAt: string): Promise<void> {
    await Promise.all(this.options.subscriptions().filter((sub) => sub.enabled !== false
      && sub.hostId === hostId && sub.threadId === threadId)
      .map((sub) => this.queue.run(sub.key, async () => {
        const state = this.state(sub);
        if (state.completed.includes(turnId) || state.retired?.includes(turnId)) return;
        if (state.startedAt && Date.parse(startedAt) < Date.parse(state.startedAt)) return;
        if (sub.managed) this.managedStarted(sub, turnId);
        else if (!await this.selectTurn(sub, turnId, true)) return;
        state.startedAt = startedAt;
        state.sequence++;
        this.save();
      })));
  }
  /** A notification is a hint, not authority to target a different host. */
  async activity(hostId: string, threadId: string, turnId: string, text: string): Promise<void> {
    await Promise.all(this.options.subscriptions().filter((sub) => sub.enabled !== false && sub.hostId === hostId && sub.threadId === threadId)
      .map((sub) => this.queue.run(sub.key, async () => {
        if (sub.managed) {
          const state = this.state(sub);
          if (state.turnId && state.turnId !== turnId) return;
          state.turnId = turnId;
          state.sequence++;
          this.save();
          return;
        }
        await this.deliver(sub, turnId, text);
      })));
  }
  async completion(hostId: string, threadId: string, turnId: string, text: string): Promise<void> {
    await Promise.all(this.options.subscriptions().filter((sub) =>
      sub.enabled !== false && sub.hostId === hostId && sub.threadId === threadId && !sub.managed)
      .map((sub) => this.queue.run(sub.key, () => this.finish(sub, turnId, text))));
  }
  async recoverCompletion(hostId: string, threadId: string, turnId: string, text: string): Promise<void> {
    await Promise.all(this.options.subscriptions().filter((sub) => sub.enabled !== false
      && sub.hostId === hostId && sub.threadId === threadId && !sub.managed
      && this.states[sub.key]?.turnId === turnId)
      .map((sub) => this.queue.run(sub.key, () => this.finish(sub, turnId, text))));
  }
  /** Reuse the same persistent record for turns initiated from the IM channel. */
  managedStarted(sub: ThreadSubscription, turnId: string): void {
    const state = this.state(sub);
    state.turnId = turnId;
    state.sequence++;
    this.save();
  }

  managedStream(sub: ThreadSubscription): ChannelTurnTextStream {
    const state = this.state(sub);
    if (state.checkpoint?.finished) state.checkpoint = undefined;
    this.streams.delete(sub.key);
    this.save();
    return this.stream(sub);
  }
  private stream(sub: ThreadSubscription): ChannelTurnTextStream {
    let stream = this.streams.get(sub.key);
    if (stream) return stream;
    const state = this.state(sub);
    const saved = state.checkpoint;
    // Only transports explicitly supporting persisted handles may resume.
    const restore = saved && (sub.client.resumableTextStream || !saved.messageId)
      ? saved : undefined;
    stream = new ChannelTurnTextStream(sub.client, sub.recipientId, {
      restore, contextToken: sub.contextToken, onTextDelivered: sub.onTextDelivered,
      save: (checkpoint) => { state.checkpoint = checkpoint; this.save(); }
    });
    this.streams.set(sub.key, stream);
    return stream;
  }
  private async selectTurn(sub: ThreadSubscription, turnId: string, allowSwitch = false): Promise<FollowState | undefined> {
    const state = this.state(sub);
    if (state.retired?.includes(turnId)) return undefined;
    if (state.turnId !== turnId) {
      if (state.turnId && !allowSwitch) return undefined;
      if (state.terminalPending) return undefined;
      const old = this.streams.get(sub.key)
        ?? (state.checkpoint?.messageId && !state.checkpoint.finished ? this.stream(sub) : undefined);
      if (old) { await old.finalize("已切换到新的任务轮次；上一轮结果可用 /history 查看。"); await old.suspend(); }
      this.streams.delete(sub.key);
      if (state.turnId) state.retired = [...(state.retired ?? []), state.turnId].slice(-200);
      state.turnId = turnId;
      state.checkpoint = undefined;
      state.delivered = [];
      this.save();
    }
    return state;
  }
  private async deliver(sub: ThreadSubscription, turnId: string, text: string): Promise<void> {
    const state = this.state(sub);
    if (state.completed.includes(turnId) || state.terminalPending) return;
    const clean = visibleText(text).trim();
    if (!clean) return;
    const id = crypto.createHash("sha256").update(turnId + "\n" + clean).digest("hex");
    if (state.delivered.includes(id)) return;
    if (!await this.selectTurn(sub, turnId)) return;
    state.baseline = state.baseline?.filter((id) => id !== turnId);
    const stream = this.stream(sub);
    await stream.progress(clean);
    state.delivered = [...state.delivered, id].slice(-500);
    state.sequence++;
    this.save();
  }
  private async finish(sub: ThreadSubscription, turnId: string, text: string, allowSwitch = false): Promise<void> {
    const state = this.state(sub);
    if (state.completed.includes(turnId)) return;
    if (!await this.selectTurn(sub, turnId, allowSwitch)) return;
    const clean = visibleText(text).trim() || "任务已结束。";
    state.terminalPending ??= { turnId, text: clean, fallbackSent: false };
    this.save();
    const stream = this.stream(sub);
    if (!await stream.finalize(clean)) {
      if (!state.terminalPending.fallbackSent) {
        await this.sendText(sub, clean);
        state.terminalPending.fallbackSent = true;
        this.save();
      }
      if (stream.checkpoint().messageId) return;
    }
    await stream.suspend();
    this.streams.delete(sub.key);
    state.completed = [...state.completed, turnId].slice(-200);
    delete state.terminalPending;
    state.sequence++;
    this.save();
  }

  private async sendText(sub: ThreadSubscription, text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      await sub.client.sendText({
        toUserId: sub.recipientId, text: chunk,
        ...(sub.contextToken ? { contextToken: sub.contextToken } : {})
      });
    }
  }
}

function visibleText(text: string): string {
  return parseActionBlocks(text).visibleText;
}
function report(error: unknown): void {
  console.warn("[codex-im-gateway] thread follow reconciliation failed: " + String(error));
}
