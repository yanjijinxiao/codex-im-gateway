import crypto from "node:crypto";
import type { CodexBridgeBackend, CodexThreadSnapshot, CodexThreadState } from "../codex/backend.js";
import type { ChannelTextClient } from "../channels/types.js";
import { ChannelTurnTextStream, type ChannelStreamCheckpoint } from "../channels/progress.js";
import { parseActionBlocks } from "../bridge/actions.js";
import { SessionControlQueue } from "../bridge/session-control.js";
import { followSyncFailure, type FollowSyncFailure, type SessionFollowStatus, type FollowSyncOptions } from "../bridge/session-follow.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { isLegacyCommunicationNotice } from "../codex/communication-error.js";

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
  deliveryVersion?: number;
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
  checkpointTurnId?: string;
  initialized: boolean;
  runtime?: CodexThreadState;
  observedAt?: string;
  syncStatus?: "pending" | "syncing" | "synced" | "unconfirmed" | "failed";
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  syncFailure?: FollowSyncFailure;
  presentation?: SessionFollowStatus["presentation"];
  terminalPending?: { turnId: string; text: string; fallbackSent: boolean };
  /** Failed previous turns own their payload/card; never share a new turn's slot. */
  pendingTerminals?: Record<string, { text: string; checkpoint?: ChannelStreamCheckpoint }>;
  repairTurnId?: string;
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
  private readonly preparedStreams = new Set<string>();
  private readonly previousRecoveries = new Map<string, Promise<void>>();
  private readonly previousRetryAt = new Map<string, number>();
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
      if (state.deliveryVersion !== 1) {
        // The old hub could mark an undelivered final as completed and attach
        // that stale payload to later turns. Never replay the saved text: only
        // the exact latest turn may be repaired from a loaded backend snapshot.
        if (state.turnId && state.completed.includes(state.turnId)
          && state.checkpoint?.terminal && !state.checkpoint.finished) {
          state.repairTurnId = state.turnId;
          state.completed = state.completed.filter(id => id !== state.turnId);
          state.baseline = state.baseline?.filter(id => id !== state.turnId);
          state.checkpoint = undefined;
          state.terminalPending = undefined;
          state.delivered = [];
        } else if (state.checkpoint) state.checkpointTurnId = state.turnId;
        state.deliveryVersion = 1;
      }
    }
  }
  private save(): void { writeJsonFile(this.options.filePath, this.states); }
  private state(sub: ThreadSubscription): FollowState {
    let state = this.states[sub.key];
    if (state && !state.threadId && state.hostId === sub.hostId) state.threadId = sub.threadId;
    if (!state || state.hostId !== sub.hostId || state.threadId !== sub.threadId) {
      state = { eventVersion: 2, deliveryVersion: 1, hostId: sub.hostId, threadId: sub.threadId, sequence: 0,
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
    await Promise.allSettled(this.previousRecoveries.values());
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
    const pending = (matching?.terminalPending ? 1 : 0) + Object.keys(matching?.pendingTerminals ?? {}).length
      + (matching?.repairTurnId && matching.repairTurnId !== matching.terminalPending?.turnId ? 1 : 0);
    return { status, lastAttemptAt: matching?.lastAttemptAt, lastSyncedAt: matching?.lastSyncedAt,
      snapshotAt: matching?.observedAt, runtime: matching?.runtime, failure: matching?.syncFailure,
      presentation: matching?.presentation,
      ...(matching?.checkpoint && !matching.checkpoint.finished && (matching.checkpoint.bootstrap
        || matching.checkpoint.messageId || matching.checkpoint.creationAttempted || matching.checkpoint.resultPresentation === "card") ? { progressDelivery: {
        stage: matching.checkpoint.bootstrap?.stage ?? (matching.checkpoint.messageId ? "delivered" as const : "legacy-unconfirmed" as const),
        requiresConfirmation: matching.checkpoint.bootstrap?.stage === "delivery-unconfirmed",
        failure: matching.checkpoint.presentationFailure ?? matching.checkpoint.bootstrap?.failure
      } } : {}),
      resultDelivery: { pending, lastDeliveredTurnId: matching?.completed.at(-1) } };
  }

  /** Targeted read-only synchronization; never waits for unrelated polling reads. */
  async synchronize(key: string, options: FollowSyncOptions = {}): Promise<SessionFollowStatus> {
    const existing = this.manualSyncs.get(key);
    if (existing) return existing;
    const sub = this.options.subscriptions().find(item => item.key === key);
    if (!sub || sub.enabled === false || !sub.threadId) return this.status(key);
    if (this.stopped) return { ...this.status(key), status: "failed",
      failure: { code: "unavailable", message: "Gateway 正在停止，未执行同步；请在服务恢复后重试。" } };
    const work = this.observe(sub, () => this.options.backend().readThreadSnapshot(sub.threadId, sub.hostId), true, options);
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

  private async observe(sub: ThreadSubscription, read: () => Promise<CodexThreadSnapshot>, force = false, options: FollowSyncOptions = {}): Promise<SessionFollowStatus> {
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
        // Pre-upgrade Gateway shutdown could poison a suspended card with a
        // local transport error. Only a loaded writer confirming the SAME
        // still-running turn may recover an unacknowledged presentation error.
        const activeId = snapshot.state.activeTurnId;
        const checkpointTurn = state.checkpointTurnId ?? state.turnId;
        const legacyCommunication = state.checkpoint?.terminal?.error
          && isLegacyCommunicationNotice(state.checkpoint.terminal.text);
        const matchingTurn = snapshot.turns.find(turn => turn.id === checkpointTurn);
        const recoverLegacy = legacyCommunication && state.checkpoint?.messageId && !state.terminalPending
          && state.turnId === checkpointTurn && !["notLoaded", "unknown", "systemError"].includes(snapshot.state.runtimeStatus)
          && (matchingTurn?.status === "inProgress" && activeId === checkpointTurn
            || matchingTurn?.status === "completed" && matchingTurn.messages.some(message => message.role === "assistant" && message.kind !== "progress" && message.text.trim()));
        if (recoverLegacy || snapshot.state.runtimeStatus === "active" && activeId && state.turnId === activeId
          && snapshot.turns.some(turn => turn.id === activeId && turn.status === "inProgress")
          && state.checkpoint?.terminal?.error && !state.checkpoint.finished
          && !state.completed.includes(activeId) && !state.terminalPending) {
          await this.streams.get(sub.key)?.suspend();
          if (this.stopped || !this.isLive(sub)) return this.changedBinding();
          this.streams.delete(sub.key);
          const { terminal: _terminal, terminalNoticeSent: _notice, terminalPages: _pages, ...checkpoint } = state.checkpoint!;
          state.checkpoint = { ...checkpoint, finished: false, answerPreview: "" };
          if (recoverLegacy) {
            state.completed = state.completed.filter(id => id !== checkpointTurn);
            state.baseline = state.baseline?.filter(id => id !== checkpointTurn);
            state.retired = state.retired?.filter(id => id !== checkpointTurn);
            state.delivered = [];
          }
          this.save();
        }
        const restoreCard = !this.streams.has(sub.key) && Boolean(state.checkpoint?.messageId && !state.checkpoint.finished);
        await this.reconcile(sub, snapshot, force, options);
        if (this.stopped || !this.isLive(sub)) return this.changedBinding();
        const runtime = snapshot.state;
        if (runtime.runtimeStatus === "active" && runtime.activeTurnId === state.turnId
          && snapshot.turns.some(turn => turn.id === state.turnId && turn.status === "inProgress")
          && state.checkpoint?.communicationNotice && sub.progressEnabled !== false) {
          await this.stream(sub).progress("已确认原任务仍在执行，继续同步原卡片。");
          await this.stream(sub).flush();
        }
        if (["archived", "missing"].includes(runtime.persistence) || runtime.runtimeStatus === "systemError") {
          this.failSync(sub, { code: "unavailable", message: "会话已归档、不存在或发生系统错误；请在对应 Codex 后端检查。" });
        } else if (runtime.pendingTurnWithoutId && runtime.runtimeStatus !== "active") {
          this.failSync(sub, { code: "orphan-turn", message: "Codex App 有未确认的界面轮次，不能当成正在执行的任务；请重新加载 App。" }, "unconfirmed");
        } else if (["notLoaded", "unknown"].includes(runtime.runtimeStatus) || runtime.persistence !== "active") {
          this.failSync(sub, { code: "unconfirmed", message: runtime.runtimeStatus === "notLoaded"
            ? "会话未加载或暂无实时持有者；绑定已保留，跟随继续等待。发送新消息会尝试继续同一会话；同步命令不会启动任务。"
            : "已读取记录，但实际持有者无法确认；绑定已保留，未将其当成空闲或已结束。" }, "unconfirmed");
        } else if (runtime.runtimeStatus === "active" && !snapshot.turns.some(turn => turn.status === "inProgress"
          && (!runtime.activeTurnId || turn.id === runtime.activeTurnId))) {
          this.failSync(sub, { code: "unconfirmed", message: "后端报告正在执行，但没有可确认的当前轮次；未创建占位卡片。" }, "unconfirmed");
        } else if (runtime.runtimeStatus === "active" && runtime.activeTurnId
          && (state.completed.includes(runtime.activeTurnId)
            || state.checkpointTurnId === runtime.activeTurnId && state.checkpoint?.finished)) {
          // A stale owner snapshot or a reused turn ID can conflict with an
          // acknowledged completion. That is NOT an IM permission failure.
          // Do not reopen a completed card or replay its answer on this evidence.
          this.failSync(sub, { code: "unconfirmed", message: "Codex 后端报告正在执行，但同一轮次已有完成回执，状态相互冲突；保留原卡片与绑定，等待新的可信轮次状态，不重发结果或重建卡片。" }, "unconfirmed");
        } else {
          let presentation: SessionFollowStatus["presentation"] = sub.progressEnabled === false ? "off"
            : runtime.runtimeStatus === "active" ? state.presentation : "idle";
          if (runtime.runtimeStatus === "active" && (!sub.managed || this.streams.has(sub.key))
            && sub.progressEnabled !== false && (force || restoreCard)) {
            const result = await this.stream(sub).synchronize(options);
            if (result === "unavailable" || result === "finished") {
              this.failSync(sub, { code: "presentation", message: this.presentationFailure(sub) });
              return this.status(sub.key);
            }
            presentation = result;
          }
          if (this.stopped || !this.isLive(sub)) return this.changedBinding();
          if (runtime.runtimeStatus === "active" && sub.progressEnabled !== false
            && ["unavailable", "finished"].includes(this.streams.get(sub.key)?.deliveryState() ?? "active")) {
            this.failSync(sub, { code: "presentation", message: this.presentationFailure(sub) });
            return this.status(sub.key);
          }
          if (state.terminalPending && runtime.runtimeStatus !== "active") {
            this.failSync(sub, { code: "presentation", message: "当前轮次已结束，但最终答复尚未确认送达；后端状态读取成功不表示这一轮同步完成。" });
            return this.status(sub.key);
          }
          {
            // Current follow health and previous final-result delivery are
            // independent; a pending old result must not fail a current sync.
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

  private presentationFailure(sub: ThreadSubscription): string {
    const checkpoint = this.state(sub).checkpoint;
    const stage = checkpoint?.bootstrap?.stage;
    if (stage === "delivery-unconfirmed") return "已读取当前任务，原卡实例已创建但投递结果未知；保留原实例，未自动重复投递。";
    if (stage === "created" || stage === "delivery-rejected") return "已读取当前任务，原卡实例已创建但未确认投递；仅恢复原实例的投递，具体渠道错误见卡片投递状态。";
    if (stage === "create-unconfirmed" || checkpoint?.creationAttempted && !checkpoint.messageId && !checkpoint.bootstrap) return "已读取当前任务，但卡片创建结果未确认；缺少可靠实例回执，未重复创建。";
    if (stage === "create-rejected") return "已读取当前任务，但尚未建立卡片：请核对明确的创建错误或在原对话发消息确认路由。";
    return "已读取当前任务，但原卡更新未确认成功；绑定已保留，具体渠道错误见卡片投递状态。";
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
        operation: "follow-synchronize", status, code: failure.code, message: failure.message,
        snapshotRuntime: state.runtime?.runtimeStatus, snapshotPersistence: state.runtime?.persistence,
        snapshotAt: state.observedAt, lastSyncedAt: state.lastSyncedAt
      })}`);
    }
  }
  private async reconcile(sub: ThreadSubscription, snapshot: CodexThreadSnapshot, force = false, options: FollowSyncOptions = {}): Promise<void> {
    if (!this.isLive(sub)) return;
    const state = this.state(sub);
    state.runtime = snapshot.state;
    state.observedAt = new Date().toISOString();
    const currentTurn = snapshot.state.runtimeStatus === "active" ? snapshot.turns.filter(turn => turn.status === "inProgress"
      && (!snapshot.state.activeTurnId || turn.id === snapshot.state.activeTurnId)).at(-1) : undefined;
    if (!sub.managed && currentTurn && state.turnId && state.turnId !== currentTurn.id && !state.terminalPending) {
      const previous = snapshot.turns.find(turn => turn.id === state.turnId && turn.status !== "inProgress");
      const text = previous?.messages.filter(message => message.role === "assistant" && message.kind !== "progress").map(message => message.text).join("\n\n");
      if (text?.trim()) state.terminalPending = { turnId: state.turnId, text: visibleText(text).trim(), fallbackSent: false };
    }
    if (!sub.managed && currentTurn && state.turnId !== currentTurn.id) await this.selectTurn(sub, currentTurn.id, true);
    const nativeText = sub.client.capabilities
      ? sub.client.capabilities.progress === "unsupported"
      : !sub.client.startTextStream && !sub.client.updateTextStream;
    if (state.repairTurnId && nativeText) {
      // The legacy text path did acknowledge its answer before marking the
      // turn completed. Its handle-less checkpoint is not the card-path bug.
      state.completed = [...state.completed, state.repairTurnId].slice(-200);
      delete state.repairTurnId;
      this.save();
    }
    if (state.repairTurnId && !["notLoaded", "unknown", "systemError"].includes(snapshot.state.runtimeStatus)
      && snapshot.state.persistence === "active") {
      const repair = snapshot.turns.find(turn => turn.id === state.repairTurnId && turn.status !== "inProgress");
      const text = repair?.messages.filter(message => message.role === "assistant" && message.kind !== "progress")
        .map(message => message.text).join("\n\n");
      if (repair && text?.trim()) {
        (state.pendingTerminals ??= {})[repair.id] = { text: visibleText(text).trim() };
        delete state.repairTurnId;
        this.save();
      }
    }
    this.retryPreviousTerminals(sub, force);
    if (!this.isLive(sub)) return;
    if (state.terminalPending) {
      await this.finish(sub, state.terminalPending.turnId, state.terminalPending.text, false,
        { recoverBootstrap: force, confirmUncertainDelivery: options.confirmUncertainDelivery });
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
      if (state.completed.includes(turn.id) || state.baseline?.includes(turn.id) || state.pendingTerminals?.[turn.id]) continue;
      if (sub.managed) {
        if (turn.status === "inProgress" && (!state.turnId || state.turnId === turn.id)) {
          state.turnId = turn.id; this.save();
        }
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
  async managedTurnStarted(sub: ThreadSubscription, turnId: string): Promise<void> {
    await this.queue.run(sub.key, async () => this.managedStarted(sub, turnId));
  }

  managedStarted(sub: ThreadSubscription, turnId: string): void {
    if (!this.isLive(sub)) return;
    const state = this.state(sub);
    if (state.turnId !== turnId && !this.preparedStreams.has(sub.key)) this.rotateStream(sub);
    state.turnId = turnId;
    state.checkpointTurnId = turnId;
    this.preparedStreams.delete(sub.key);
    state.sequence++;
    this.save();
  }

  managedStream(sub: ThreadSubscription): ChannelTurnTextStream {
    const state = this.state(sub);
    this.rotateStream(sub);
    state.turnId = undefined;
    state.sequence++;
    this.preparedStreams.add(sub.key);
    this.save();
    return this.stream(sub);
  }
  /** Serialize presentation rotation with in-flight completion acknowledgements. */
  async prepareManagedStream(sub: ThreadSubscription): Promise<ChannelTurnTextStream> {
    return this.queue.run(sub.key, async () => this.managedStream(sub));
  }
  /** Execution and following use the same acknowledged delivery journal. */
  async managedCompletion(sub: ThreadSubscription, turnId: string, text: string): Promise<boolean> {
    return this.queue.run(sub.key, async () => {
      if (!this.isLive(sub)) return false;
      try { await this.finish(sub, turnId, text); }
      catch { /* A failed transport acknowledgement is not an execution failure. */ }
      const state = this.state(sub);
      const delivered = state.completed.includes(turnId);
      if (!delivered) this.failSync(sub, { code: "presentation", message: "Codex 已完成，但最终答复尚未确认送达；保留原轮次结果重试，不会重新提交任务。" });
      return delivered;
    });
  }

  private archiveTerminal(state: FollowState, archiveCheckpoint = true): void {
    const pending = state.terminalPending;
    const turnId = pending?.turnId ?? state.checkpointTurnId;
    if (turnId && !state.completed.includes(turnId) && (pending || archiveCheckpoint && state.checkpoint?.terminal)) {
      (state.pendingTerminals ??= {})[turnId] = {
        text: pending?.text ?? state.checkpoint!.terminal!.text,
        checkpoint: state.checkpoint
      };
    }
    delete state.terminalPending;
  }

  private rotateStream(sub: ThreadSubscription): void {
    const state = this.state(sub);
    this.archiveTerminal(state);
    const old = this.streams.get(sub.key);
    this.streams.delete(sub.key);
    if (old) void old.suspend().catch(report);
    state.checkpoint = undefined;
    state.checkpointTurnId = undefined;
    state.delivered = [];
    this.save();
  }

  private retryPreviousTerminals(sub: ThreadSubscription, force = false): void {
    const state = this.state(sub);
    // Independent records: a failed old card cannot block a current turn.
    for (const [turnId, pending] of Object.entries(state.pendingTerminals ?? {}).slice(0, 5)) {
      if (!this.isLive(sub)) return;
      const recoveryKey = JSON.stringify([sub.key, sub.hostId, sub.threadId, turnId]);
      if (this.previousRecoveries.has(recoveryKey) || !force && Date.now() < (this.previousRetryAt.get(recoveryKey) ?? 0)) continue;
      if (pending.checkpoint?.messageId && !sub.client.resumableTextStream) continue;
      const work = (async () => {
      const stream = new ChannelTurnTextStream(sub.client, sub.recipientId, {
        restore: pending.checkpoint, contextToken: sub.contextToken, onTextDelivered: sub.onTextDelivered, progressEnabled: sub.progressEnabled,
        save: checkpoint => {
          if (this.stopped || !this.isLive(sub) || state.pendingTerminals?.[turnId] !== pending) throw new Error("Old result binding changed");
          pending.checkpoint = checkpoint; this.save();
        }
      });
      try {
        let delivered = await stream.finalize(pending.text, false, { recoverBootstrap: force });
        if (!stream.supported && !stream.checkpoint().terminalPages?.length) { await this.sendText(sub, pending.text); delivered = true; }
        if (delivered && this.isLive(sub) && state.pendingTerminals?.[turnId] === pending) {
          delete state.pendingTerminals![turnId];
          state.completed = [...state.completed, turnId].slice(-200);
          if (state.repairTurnId === turnId) delete state.repairTurnId;
          this.logDelivery(sub, turnId, "delivered");
        } else {
          await stream.reportTerminalFailure().catch(() => false);
        }
      } finally { await stream.suspend(); this.save(); }
      })().catch(() => { /* Preserve the old record independently of current progress. */ }).finally(() => {
        this.previousRecoveries.delete(recoveryKey); this.previousRetryAt.set(recoveryKey, Date.now() + 60_000);
      });
      this.previousRecoveries.set(recoveryKey, work);
    }
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
      restore, contextToken: sub.contextToken, onTextDelivered: sub.onTextDelivered, progressEnabled: sub.progressEnabled,
      save: (checkpoint) => {
        // A retired stream's late HTTP acknowledgement cannot poison the new
        // turn. The streamId is the transport-neutral presentation identity.
        if (this.streams.get(sub.key) !== stream) {
          const pending = Object.values(state.pendingTerminals ?? {}).find(item => item.checkpoint?.streamId === checkpoint.streamId);
          if (pending) { pending.checkpoint = checkpoint; this.save(); }
          return;
        }
        state.checkpoint = checkpoint; this.save();
      }
    });
    this.streams.set(sub.key, stream);
    return stream;
  }
  private async selectTurn(sub: ThreadSubscription, turnId: string, allowSwitch = false): Promise<FollowState | undefined> {
    const state = this.state(sub);
    if (state.retired?.includes(turnId)) return undefined;
    if (!state.turnId && this.preparedStreams.has(sub.key)) {
      state.turnId = turnId;
      state.checkpointTurnId = turnId;
      this.preparedStreams.delete(sub.key);
      this.save();
      return state;
    }
    if (state.turnId !== turnId) {
      if (state.turnId && !allowSwitch) return undefined;
      const old = this.streams.get(sub.key)
        ?? (state.checkpoint?.messageId && !state.checkpoint.finished ? this.stream(sub) : undefined);
      const hadResult = Boolean(state.terminalPending || state.checkpoint?.terminal);
      if (old) {
        if (state.terminalPending || old.checkpoint().terminal) void old.suspend().catch(report);
        else { await old.finalize("已切换到新的任务轮次；上一轮结果可用 /history 查看。"); await old.suspend(); }
      }
      this.streams.delete(sub.key);
      // A synthetic "switched turns" closure is not a model's final result.
      this.archiveTerminal(state, hadResult);
      if (state.turnId) state.retired = [...(state.retired ?? []), state.turnId].slice(-200);
      state.turnId = turnId;
      state.checkpointTurnId = turnId;
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
  private async finish(sub: ThreadSubscription, turnId: string, text: string, allowSwitch = false,
    recovery: { recoverBootstrap?: boolean; confirmUncertainDelivery?: boolean } = {}): Promise<void> {
    const current = this.currentSubscription(sub);
    if (!current) return;
    sub = current;
    const state = this.state(sub);
    if (state.completed.includes(turnId)) return;
    if (!await this.selectTurn(sub, turnId, allowSwitch)) return;
    const clean = visibleText(text).trim() || "任务已结束。";
    state.terminalPending ??= { turnId, text: clean, fallbackSent: false };
    this.save();
    const stream = this.stream(sub);
    if (!await stream.finalize(clean, false, recovery)) {
      if (!state.terminalPending.fallbackSent) {
        if (stream.supported || stream.checkpoint().terminalPages?.length) {
          try { await stream.reportTerminalFailure(); }
          catch { console.warn("[codex-im-gateway] terminal delivery notice unavailable"); }
        } else if (!stream.checkpoint().terminalPages?.length) await this.sendText(sub, clean);
        state.terminalPending.fallbackSent = true;
        this.save();
      }
      // A notice is not an answer receipt, including when card creation
      // failed before returning a handle. Keep the final pending in both cases.
      if (stream.supported || stream.checkpoint().terminalPages?.length) { this.logDelivery(sub, turnId, "pending"); return; }
    }
    await stream.suspend();
    this.streams.delete(sub.key);
    state.completed = [...state.completed, turnId].slice(-200);
    if (state.repairTurnId === turnId) delete state.repairTurnId;
    delete state.terminalPending;
    state.sequence++;
    this.logDelivery(sub, turnId, "delivered");
    this.save();
  }

  private logDelivery(sub: ThreadSubscription, turnId: string, status: "pending" | "delivered"): void {
    const key = `${sub.key}:${turnId}:${status}`;
    if (Date.now() - (this.errorLogTimes.get(key) ?? 0) < 60_000) return;
    this.errorLogTimes.set(key, Date.now());
    console.info(`[codex-im-gateway] result delivery ${JSON.stringify({ timestamp: new Date().toISOString(),
      operation: "final-result-delivery", hostId: sub.hostId, threadId: sub.threadId, turnId, status })}`);
  }

  private isLive(sub: ThreadSubscription): boolean {
    return Boolean(this.currentSubscription(sub));
  }

  private currentSubscription(sub: ThreadSubscription): ThreadSubscription | undefined {
    return this.options.subscriptions().find(current => current.enabled !== false && current.key === sub.key
      && current.hostId === sub.hostId && current.threadId === sub.threadId);
  }

  private async sendText(sub: ThreadSubscription, text: string): Promise<void> {
      await sub.client.sendText({
        toUserId: sub.recipientId, text,
        ...(sub.contextToken ? { contextToken: sub.contextToken } : {})
      });
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
