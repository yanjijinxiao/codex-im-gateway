import crypto from "node:crypto";
import type { CodexBridgeBackend, CodexThreadSnapshot, CodexThreadState } from "../codex/backend.js";
import type { ChannelTextClient } from "../channels/types.js";
import { ChannelTurnTextStream, type ChannelStreamCheckpoint } from "../channels/progress.js";
import { parseActionBlocks } from "../bridge/actions.js";
import { chunkText } from "../bridge/format.js";
import { SessionControlQueue } from "../bridge/session-control.js";
import { followSyncFailure, type FollowSyncFailure, type SessionFollowStatus } from "../bridge/session-follow.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";

export type ThreadSubscription = {
  key: string;
  hostId: string;
  threadId: string;
  recipientId: string;
  client: ChannelTextClient;
  managed: boolean;
  enabled?: boolean;
  /** /stream controls progress presentation, not the binding or final answer. */
  progressEnabled?: boolean;
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
  syncStatus?: "pending" | "syncing" | "synced" | "unconfirmed" | "failed";
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  syncFailure?: FollowSyncFailure;
  presentation?: SessionFollowStatus["presentation"];
  terminalPending?: { turnId: string; text: string; fallbackSent: boolean };
};
type Options = {
  filePath: string;
  subscriptions: () => ThreadSubscription[];
  backend: () => Pick<CodexBridgeBackend, "readThreadSnapshot">;
  intervalMs?: number;
  readTimeoutMs?: number;
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
  private readSequence = 0;
  private readonly readVersions = new Map<string, number>();
  private readonly manualSyncs = new Map<string, Promise<SessionFollowStatus>>();
  private readonly errorLogTimes = new Map<string, number>();
  constructor(private readonly options: Options) {
    this.states = readJsonFile(options.filePath, {});
    for (const state of Object.values(this.states)) {
      if (state.syncStatus === "syncing") state.syncStatus = "pending";
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
    await Promise.allSettled(this.manualSyncs.values());
    await Promise.all([...this.streams.values()].map((stream) => stream.suspend()));
    this.streams.clear();
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.scan) return this.scan;
    this.scan = this.scanSubscriptions();
    try { await this.scan; } finally { this.scan = undefined; }
  }

  status(key: string): SessionFollowStatus {
    const sub = this.options.subscriptions().find(item => item.key === key);
    const state = this.states[key];
    const matching = sub && state && sub.hostId === state.hostId && sub.threadId === state.threadId ? state : undefined;
    let status: SessionFollowStatus["status"] = sub?.enabled === false || !sub ? "disabled" : matching?.syncStatus ?? "pending";
    if (status === "synced" && matching?.lastSyncedAt
      && Date.now() - Date.parse(matching.lastSyncedAt) > 60_000) status = "stale";
    return { status, lastAttemptAt: matching?.lastAttemptAt, lastSyncedAt: matching?.lastSyncedAt,
      snapshotAt: matching?.observedAt, runtime: matching?.runtime, failure: matching?.syncFailure,
      presentation: matching?.presentation };
  }

  /** Targeted read-only synchronization; never waits for unrelated polling reads. */
  async synchronize(key: string): Promise<SessionFollowStatus> {
    const existing = this.manualSyncs.get(key);
    if (existing) return existing;
    const sub = this.options.subscriptions().find(item => item.key === key);
    if (!sub || sub.enabled === false || !sub.threadId) return this.status(key);
    if (this.stopped) return { ...this.status(key), status: "failed",
      failure: { code: "unavailable", message: "Gateway 正在停止，未执行同步；请在服务恢复后重试。" } };
    const work = this.observe(sub, () => this.options.backend().readThreadSnapshot(sub.threadId, sub.hostId), true);
    this.manualSyncs.set(key, work);
    try { return await work; }
    finally { if (this.manualSyncs.get(key) === work) this.manualSyncs.delete(key); }
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
      const sub = subscriptions.find(item => item.key === key);
      const state = this.states[key];
      const changed = sub && state && (sub.hostId !== state.hostId || sub.threadId !== state.threadId);
      if (!live.has(key) || changed) {
        await stream.finalize(changed ? "已切换绑定的会话；原任务继续运行。" : "已停止跟随此会话；任务继续运行。");
        await stream.suspend();
        this.streams.delete(key);
      } else if (sub?.progressEnabled === false) {
        await stream.suspend();
        this.streams.delete(key);
      }
    }
    for (const key of Object.keys(this.states)) {
      if (!live.has(key)) {
        // Disabled bindings above can restore their cards. Deleted accounts no
        // longer provide a client, so only their local cursor can be retired.
        delete this.states[key];
        this.readVersions.delete(key);
        this.errorLogTimes.delete(key);
      }
    }
    const snapshots = new Map<string, Promise<CodexThreadSnapshot>>();
    await Promise.all(subscriptions.map(async (sub) => {
      if (!sub.threadId || typeof this.options.backend().readThreadSnapshot !== "function") return;
      const manual = this.manualSyncs.get(sub.key);
      if (manual) { await manual; return; }
      const key = JSON.stringify([sub.hostId, sub.threadId]);
      if (!snapshots.has(key)) snapshots.set(key, Promise.resolve().then(() =>
        this.options.backend().readThreadSnapshot(sub.threadId, sub.hostId)));
      await this.observe(sub, () => snapshots.get(key)!);
    }));
    this.save();
  }

  private async observe(sub: ThreadSubscription, read: () => Promise<CodexThreadSnapshot>, force = false): Promise<SessionFollowStatus> {
    const state = this.state(sub);
    const sequenceBeforeRead = state.sequence;
    const version = ++this.readSequence;
    this.readVersions.set(sub.key, version);
    state.lastAttemptAt = new Date().toISOString();
    state.syncStatus = "syncing";
    this.save();
    try {
      const snapshot = await boundedRead(read(), this.options.readTimeoutMs ?? 25_000);
      return await this.queue.run(sub.key, async () => {
        const current = this.currentSubscription(sub);
        if (this.stopped || !current) return this.changedBinding();
        // Settings/ownership may change while a backend read is in flight.
        sub = current;
        if (this.readVersions.get(sub.key) !== version) return this.status(sub.key);
        if (state.sequence !== sequenceBeforeRead && snapshot.state.activeTurnId !== state.turnId) {
          this.failSync(sub, { code: "unconfirmed", message: "读取期间任务轮次发生变化；未覆盖较新的进展，请重试同步。" }, "unconfirmed");
          return this.status(sub.key);
        }
        // Reject a mismatched response before any progress or cursor can be updated.
        if (snapshot.state.threadId !== sub.threadId) throw new Error("Backend returned another thread snapshot");
        const restoreCard = !this.streams.has(sub.key) && Boolean(state.checkpoint?.messageId && !state.checkpoint.finished);
        await this.reconcile(sub, snapshot);
        if (this.stopped || !this.isLive(sub)) return this.changedBinding();
        const runtime = snapshot.state;
        if (["archived", "missing"].includes(runtime.persistence) || runtime.runtimeStatus === "systemError") {
          this.failSync(sub, { code: "unavailable", message: "会话已归档、不存在或发生系统错误；请在对应 Codex 后端检查。" });
        } else if (runtime.pendingTurnWithoutId && runtime.runtimeStatus !== "active") {
          this.failSync(sub, { code: "orphan-turn", message: "Codex App 有未确认的界面轮次，不能当成正在执行的任务；请重新加载 App。" }, "unconfirmed");
        } else if (["notLoaded", "unknown"].includes(runtime.runtimeStatus) || runtime.persistence !== "active") {
          this.failSync(sub, { code: "unconfirmed", message: "已读取记录，但会话未加载或实际持有者无法确认；未将其当成空闲或已结束。" }, "unconfirmed");
        } else if (runtime.runtimeStatus === "active" && !snapshot.turns.some(turn => turn.status === "inProgress"
          && (!runtime.activeTurnId || turn.id === runtime.activeTurnId))) {
          this.failSync(sub, { code: "unconfirmed", message: "后端报告正在执行，但没有可确认的当前轮次；未创建占位卡片。" }, "unconfirmed");
        } else {
          let presentation: SessionFollowStatus["presentation"] = sub.progressEnabled === false ? "off"
            : runtime.runtimeStatus === "active" ? state.presentation : "idle";
          if (runtime.runtimeStatus === "active" && (!sub.managed || this.streams.has(sub.key))
            && sub.progressEnabled !== false && (force || restoreCard)) {
            const result = await this.stream(sub).synchronize();
            if (result === "unavailable" || result === "finished") {
              this.failSync(sub, { code: "presentation", message: "后端状态已读取，但原进度卡片未能更新；请检查渠道权限和连接后重试。" });
              return this.status(sub.key);
            }
            presentation = result;
          }
          if (this.stopped || !this.isLive(sub)) return this.changedBinding();
          if (runtime.runtimeStatus === "active" && sub.progressEnabled !== false
            && this.streams.get(sub.key)?.deliveryState() === "unavailable") {
            this.failSync(sub, { code: "presentation", message: "后端状态已读取，但当前进度卡片仍不可用；请检查渠道权限和连接后重试。" });
            return this.status(sub.key);
          }
          if (state.terminalPending) {
            this.failSync(sub, { code: "presentation", message: "任务已经结束，但原卡片的最终结果尚未送达；将保留原卡片并重试。" });
          } else {
            state.syncStatus = "synced";
            state.lastSyncedAt = new Date().toISOString();
            state.presentation = presentation;
            delete state.syncFailure;
            this.save();
          }
        }
        return this.status(sub.key);
      });
    } catch (error) {
      if (this.stopped || !this.isLive(sub)) return this.changedBinding();
      if (this.readVersions.get(sub.key) === version) this.failSync(sub, followSyncFailure(error));
      return this.status(sub.key);
    }
  }

  private changedBinding(): SessionFollowStatus {
    return { status: "failed", failure: { code: "binding-changed", message: "同步期间绑定已切换或跟随已关闭；未向原对话补发进展。" } };
  }

  private failSync(sub: ThreadSubscription, failure: FollowSyncFailure, status: "failed" | "unconfirmed" = "failed"): void {
    const state = this.state(sub);
    const changed = state.syncFailure?.code !== failure.code;
    state.syncStatus = status;
    state.syncFailure = failure;
    this.save();
    const lastLog = this.errorLogTimes.get(sub.key) ?? 0;
    if (changed || Date.now() - lastLog > 60_000) {
      this.errorLogTimes.set(sub.key, Date.now());
      console.warn(`[codex-im-gateway] thread follow sync ${JSON.stringify({
        timestamp: new Date().toISOString(), hostId: sub.hostId, threadId: sub.threadId,
        status, code: failure.code, lastSyncedAt: state.lastSyncedAt
      })}`);
    }
  }
  private async reconcile(sub: ThreadSubscription, snapshot: CodexThreadSnapshot): Promise<void> {
    if (!this.isLive(sub)) return;
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
        if (snapshot.state.runtimeStatus !== "active") continue;
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
        if (!this.isLive(sub)) return;
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
        if (!this.isLive(sub)) return;
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
    if (!this.isLive(sub)) return;
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
    const current = this.currentSubscription(sub);
    if (!current || current.progressEnabled === false) return;
    sub = current;
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
    const current = this.currentSubscription(sub);
    if (!current) return;
    sub = current;
    const state = this.state(sub);
    if (state.completed.includes(turnId)) return;
    if (!await this.selectTurn(sub, turnId, allowSwitch)) return;
    const clean = visibleText(text).trim() || "任务已结束。";
    state.terminalPending ??= { turnId, text: clean, fallbackSent: false };
    this.save();
    if (sub.progressEnabled === false && !state.checkpoint?.messageId) {
      await this.sendText(sub, clean);
      state.completed = [...state.completed, turnId].slice(-200);
      delete state.terminalPending;
      state.sequence++;
      this.save();
      return;
    }
    const stream = this.stream(sub);
    if (!await stream.finalize(clean)) {
      if (!state.terminalPending.fallbackSent) {
        if (stream.supported) await stream.reportTerminalFailure();
        else await this.sendText(sub, clean);
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

  private isLive(sub: ThreadSubscription): boolean {
    return Boolean(this.currentSubscription(sub));
  }

  private currentSubscription(sub: ThreadSubscription): ThreadSubscription | undefined {
    return this.options.subscriptions().find(current => current.enabled !== false && current.key === sub.key
      && current.hostId === sub.hostId && current.threadId === sub.threadId);
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
  console.warn("[codex-im-gateway] thread follow reconciliation failed: " + followSyncFailure(error).code);
}

async function boundedRead<T>(read: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Follow snapshot read timed out")), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
