import crypto from "node:crypto";
import type { CodexBridgeBackend, CodexThreadSnapshot, CodexThreadState } from "../codex/backend.js";
import { codexFailureSummary } from "../codex/turn-failure.js";
import { codexRecoverySummary } from "../codex/turn-recovery.js";
import type { ChannelTextClient } from "../channels/types.js";
import type { ChannelStreamCheckpoint } from "../channels/progress.js";
import { completedCardForMentions } from "../channels/completion-mentions.js";
import type { TurnOutcome } from "../channels/turn-status.js";
import { ChannelTurnPresentation, nextTurnCheckpoint } from "../channels/turn-presentation.js";
import type { AcceptedPresentationInput } from "../bridge/input-presentation.js";
import type { TurnAudienceJournal } from "../bridge/turn-audience.js";
import { parseActionBlocks } from "../bridge/actions.js";
import { SessionControlQueue } from "../bridge/session-control.js";
import { followSyncFailure, type FollowSyncFailure, type SessionFollowStatus, type FollowSyncOptions } from "../bridge/session-follow.js";
import { readJsonObjectFile, isJsonObject, writeJsonFile } from "../state/json-store.js";
import { isLegacyCommunicationNotice } from "../codex/communication-error.js";
import { afterFollowBoundary, followBoundary, type FollowHistoryBoundary } from "./follow-history-boundary.js";

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
  provenanceVersion?: number;
  deliveryVersion?: number;
  eventVersion?: number;
  hostId: string;
  threadId: string;
  turnId?: string;
  sequence: number;
  delivered: string[];
  completed: string[];
  baseline?: string[];
  historyBoundary?: FollowHistoryBoundary;
  retired?: string[];
  startedAt?: string;
  checkpoint?: ChannelStreamCheckpoint;
  checkpointTurnId?: string;
  initialized: boolean;
  runtime?: CodexThreadState;
  runtimeRecovery?: NonNullable<SessionFollowStatus["runtimeRecovery"]> & { checkpoint?: ChannelStreamCheckpoint };
  observedAt?: string;
  syncStatus?: "pending" | "syncing" | "synced" | "unconfirmed" | "failed";
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  syncFailure?: FollowSyncFailure;
  presentation?: SessionFollowStatus["presentation"];
  terminalPending?: { turnId: string; text: string; fallbackSent: boolean; outcome?: TurnOutcome };
  /** Failed previous turns own their payload/card; never share a new turn's slot. */
  pendingTerminals?: Record<string, { text: string; checkpoint?: ChannelStreamCheckpoint; outcome?: TurnOutcome }>;
  /** Legacy observation notices are not model answers or completion receipts. */
  observationNotices?: Record<string, { text: string; checkpoint?: ChannelStreamCheckpoint }>;
  repairTurnId?: string;
  queueTerminalRepairs?: Record<string, { acknowledged: string[]; complete?: boolean }>;
  prematureQueueTerminal?: { turnId: string; checkpoint: ChannelStreamCheckpoint };
  presentationInputBaseline?: string[];
};
type Options = {
  decorateFinal?: (sub: ThreadSubscription, text: string) => string | Promise<string>;
  decorateProgress?: (sub: ThreadSubscription, text: string) => string;
  onThreadState?: (sub: ThreadSubscription, state: CodexThreadState) => void;
  onSystemError?: (sub: ThreadSubscription, snapshot: CodexThreadSnapshot) => void;
  onRecoveryObservation?: (sub: ThreadSubscription, snapshot: CodexThreadSnapshot) => void;
  onCapacityFailure?: (scope: { hostId: string; threadId: string; turnId: string }) => boolean;
  holdsCapacityStart?: (scope: { hostId: string; threadId: string; turnId: string }) => boolean;
  turnAudience?: TurnAudienceJournal;
  filePath: string;
  subscriptions: () => ThreadSubscription[];
  backend: () => Pick<CodexBridgeBackend, "readThreadSnapshot"> & Partial<Pick<CodexBridgeBackend, "readTurnLifecycle" | "readThreadProvenance">>;
  legacyQueueTerminal?: (sub: ThreadSubscription, turnId: string) => boolean;
  /** Recovery projection of existing native receipts, not an execution queue. */
  acceptedInputs?: () => readonly AcceptedPresentationInput[];
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
  private readonly streams = new Map<string, ChannelTurnPresentation>();
  private readonly streamOwners = new WeakMap<ChannelTurnPresentation, ThreadSubscription>();
  private readonly retiringStreams = new Map<string, Promise<void>>();
  private readonly closingPresentations = new WeakSet<ChannelTurnPresentation>();
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
  private readonly provenanceRepairs = new Map<string, Promise<void>>();
  private readonly provenanceRetryAt = new Map<string, number>();
  constructor(private readonly options: Options) {
    this.states = readJsonObjectFile(options.filePath, {});
    if (Object.values(this.states).some(state => !isJsonObject(state)))
      throw new Error("Invalid thread event journal; original file preserved");
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
      for (const [turnId, pending] of Object.entries(state.pendingTerminals ?? {})) {
        if (!isLegacyObservationNotice(pending.text)) continue;
        (state.observationNotices ??= {})[turnId] = pending;
        delete state.pendingTerminals![turnId];
      }
      const terminal = state.terminalPending;
      const checkpointTurn = state.checkpointTurnId ?? state.turnId;
      const notice = terminal?.text ?? state.checkpoint?.terminal?.text;
      if (checkpointTurn && notice && isLegacyObservationNotice(notice)) {
        (state.observationNotices ??= {})[checkpointTurn] = { text: notice, checkpoint: state.checkpoint };
        delete state.terminalPending;
        state.completed = state.completed.filter(id => id !== checkpointTurn);
        state.baseline = state.baseline?.filter(id => id !== checkpointTurn);
        state.retired = state.retired?.filter(id => id !== checkpointTurn);
        if (state.checkpoint) {
          const { terminal: _terminal, terminalNoticeSent: _notice, terminalPages: _pages, ...checkpoint } = state.checkpoint;
          state.checkpoint = { ...checkpoint, finished: false, answerPreview: "" };
        }
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
    await Promise.allSettled(this.provenanceRepairs.values());
    const cleanup = await Promise.allSettled([...this.streams.values()].map(stream => stream.suspend()).concat([...this.retiringStreams.values()]));
    for (const result of cleanup) if (result.status === "rejected") report(result.reason);
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
    if (sub?.enabled !== false && matching?.runtime?.persistence === "archived") status = "suspended";
    if (status === "synced" && matching?.lastSyncedAt
      && Date.now() - Date.parse(matching.lastSyncedAt) > 60_000) status = "stale";
    const pending = (matching?.terminalPending ? 1 : 0) + Object.keys(matching?.pendingTerminals ?? {}).length
      + (matching?.repairTurnId && matching.repairTurnId !== matching.terminalPending?.turnId ? 1 : 0);
    return { status, lastAttemptAt: matching?.lastAttemptAt, lastSyncedAt: matching?.lastSyncedAt,
      ...(matching?.runtimeRecovery ? { runtimeRecovery: { turnId: matching.runtimeRecovery.turnId, phase: matching.runtimeRecovery.phase,
        attempts: matching.runtimeRecovery.attempts, message: matching.runtimeRecovery.message, updatedAt: matching.runtimeRecovery.updatedAt } } : {}),
      snapshotAt: matching?.observedAt, runtime: matching?.runtime, failure: matching?.syncFailure,
      presentation: matching?.presentation,
      ...(matching?.checkpoint && !matching.checkpoint.finished && (matching.checkpoint.bootstrap
        || matching.checkpoint.messageId || matching.checkpoint.creationAttempted || matching.checkpoint.resultPresentation === "card") ? { progressDelivery: {
        stage: matching.checkpoint.bootstrap?.stage ?? (matching.checkpoint.messageId ? "delivered" as const : "legacy-unconfirmed" as const),
        requiresConfirmation: matching.checkpoint.bootstrap?.stage === "delivery-unconfirmed",
        failure: matching.checkpoint.presentationFailure ?? matching.checkpoint.bootstrap?.failure
      } } : {}),
      resultDelivery: { pending, deferred: Object.values(matching?.pendingTerminals ?? {})
        .filter(item => !hasDeliveredCard(item.checkpoint)).length,
        lastDeliveredTurnId: matching?.completed.at(-1) } };
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
        // Only this explicit neutral closure may update a retired binding's
        // existing card. It cannot publish a model result or create a new card.
        this.closingPresentations.add(stream);
        try { await stream.finalize(changed ? "已切换绑定的会话；原任务继续运行。" : "已停止跟随此会话；任务继续运行。", false, { outcome: "detached", existingOnly: true }); }
        finally { this.closingPresentations.delete(stream); }
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
      const prior = this.states[sub.key];
      if (prior?.hostId === sub.hostId && prior.threadId === sub.threadId && prior.runtime?.persistence === "archived"
        && prior.lastAttemptAt && Date.now() - Date.parse(prior.lastAttemptAt) < 5 * 60_000) return;
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
        this.requestProvenanceRepair(sub, snapshot);
        await this.repairQueueTerminals(sub);
        if (this.stopped || !this.isLive(sub) || this.readVersions.get(sub.key) !== version) return this.changedBinding();
        const observedActive = snapshot.state.activeTurnId;
        const observedTurn = snapshot.turns.find(turn => turn.id === observedActive && turn.status === "inProgress");
        if (snapshot.state.runtimeStatus === "active" && observedActive
          && (state.completed.includes(observedActive) || state.checkpointTurnId === observedActive && state.checkpoint?.finished
            || state.turnId && state.turnId !== observedActive && observedTurn?.startedAt && state.startedAt
              && Date.parse(state.startedAt) > Date.parse(observedTurn.startedAt))) {
          // Validate before selectTurn: otherwise the conflicting old slot is
          // closed as a supposed new turn before the proof can be checked.
          state.runtime = snapshot.state; state.observedAt = new Date().toISOString();
          const reason = state.completed.includes(observedActive) || state.checkpointTurnId === observedActive && state.checkpoint?.finished
            ? "旧展示已有完成回执，与原生状态相互冲突" : "旧展示时间线与原生当前轮次冲突";
          this.failSync(sub, { code: "unconfirmed", message: `${reason}；正在核对来源，未中断或重跑主任务。` }, "unconfirmed");
          return this.status(sub.key);
        }
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
        if (runtime.runtimeStatus === "systemError" && runtime.persistence === "active") {
          this.options.onSystemError?.(sub, snapshot);
          this.failSync(sub, { code: "unavailable", message: [this.options.onSystemError
            ? runtime.lastTurnFailure ? "会话处于系统错误状态（systemError）；已进入受控恢复检查，绑定保留，旧消息未重发。"
              : "会话处于系统错误状态（systemError）；缺少可信失败轮次，暂不能自动重载，绑定保留。"
            : "会话处于系统错误状态（systemError）；绑定已保留，未自动恢复或重发任务。",
            ...(runtime.lastTurnFailure ? [`上一轮失败原因：${codexFailureSummary(runtime.lastTurnFailure.code)}`] : []),
            ...(this.options.onSystemError ? [] : ["请在对应 Codex 后端原会话中查看并处理错误。"])
          ].join("\n") });
        } else if (["archived", "missing"].includes(runtime.persistence) || runtime.runtimeStatus === "systemError") {
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
        } else if (runtime.runtimeStatus === "idle" && state.turnId && !state.completed.includes(state.turnId)
          && !state.terminalPending && !snapshot.turns.some(turn => turn.id === state.turnId)) {
          this.failSync(sub, { code: "unconfirmed", message: "最近历史未包含原轮次，无法确认其结束或最终答复；保留绑定与原卡片，请用 /history 查询，不生成任务结束通知。" }, "unconfirmed");
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
        if (state.turnId && state.completed.includes(state.turnId)) void this.notifyParticipants(sub, state.turnId);
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
    // A failed read is not a failed task. Update only an already-owned card.
    if (failure.code !== "presentation") void this.streams.get(sub.key)?.setActivity("unconfirmed").catch(report);
    const lastLog = this.errorLogTimes.get(sub.key) ?? 0;
    if (changed || Date.now() - lastLog > (state.runtime?.persistence === "archived" ? 5 * 60_000 : 60_000)) {
      this.errorLogTimes.set(sub.key, Date.now());
      console.warn(`[codex-im-gateway] thread follow sync ${JSON.stringify({
        timestamp: new Date().toISOString(), hostId: sub.hostId, threadId: sub.threadId,
        operation: "follow-synchronize", status, code: failure.code, message: failure.message,
        snapshotRuntime: state.runtime?.runtimeStatus, snapshotPersistence: state.runtime?.persistence,
        snapshotAt: state.observedAt, lastSyncedAt: state.lastSyncedAt
      })}`);
    }
  }
  /** A loaded owner AND complete native source must agree before repairing
   * legacy child-output pollution. This scan never blocks /status or ingress. */
  private requestProvenanceRepair(sub: ThreadSubscription, snapshot: CodexThreadSnapshot): void {
    const state = this.state(sub), activeId = snapshot.state.activeTurnId;
    const read = this.options.backend().readThreadProvenance;
    if (!read || sub.managed || state.provenanceVersion === 3 || this.provenanceRepairs.has(sub.key)
      || Date.now() < (this.provenanceRetryAt.get(sub.key) ?? 0) || snapshot.state.executionOwner !== "desktop"
      || snapshot.state.runtimeStatus !== "active" || !activeId
      || !state.completed.length && !state.baseline?.length && !state.retired?.length && (!state.turnId || state.turnId === activeId)) return;
    const work = (async () => {
      const provenance = await boundedRead(read.call(this.options.backend(), sub.threadId, sub.hostId), this.options.readTimeoutMs ?? 25000);
      if (this.stopped || !this.isLive(sub) || !provenance?.complete || provenance.threadId !== sub.threadId
        || !provenance.turns.some(turn => turn.id === activeId && turn.status === "inProgress")) return;
      const fresh = await boundedRead(this.options.backend().readThreadSnapshot(sub.threadId, sub.hostId), this.options.readTimeoutMs ?? 25000);
      const active = fresh.turns.find(turn => turn.id === activeId && turn.status === "inProgress");
      if (fresh.state.threadId !== sub.threadId || fresh.state.persistence !== "active" || fresh.state.executionOwner !== "desktop"
        || fresh.state.runtimeStatus !== "active" || fresh.state.activeTurnId !== activeId || !active) return;
      await this.queue.run(sub.key, async () => {
        if (this.stopped || !this.isLive(sub) || state.provenanceVersion === 3
          || state.runtime?.activeTurnId && state.runtime.activeTurnId !== activeId) return;
        const known = new Set(provenance.turns.map(turn => turn.id));
        const repairPresentation = state.completed.includes(activeId) || state.checkpointTurnId === activeId && state.checkpoint?.finished
          || Boolean(state.turnId && !known.has(state.turnId));
        const foreignLedger = [...state.completed, ...(state.baseline ?? []), ...(state.retired ?? [])].some(id => !known.has(id));
        if (!repairPresentation && !foreignLedger) { state.provenanceVersion = 3; this.save(); return; }
        const correction = repairPresentation
          ? "此前进度混入了子任务结果，“已完成”不代表主任务结束。主任务仍在执行，已恢复主任务进展同步。"
          : "此前混入了子任务的完成记录，已校正来源；当前主任务仍在执行。";
        const oldTurn = state.turnId;
        if (repairPresentation) {
          delete state.terminalPending;
          if (state.pendingTerminals) { delete state.pendingTerminals[activeId]; if (oldTurn) delete state.pendingTerminals[oldTurn]; }
          if (state.checkpoint && !state.checkpoint.finished) {
            delete state.checkpoint.terminal;
            await this.stream(sub).invalidatePresentation(correction);
          }
          if (this.stopped || !this.isLive(sub)) return;
          this.rotateStream(sub);
          state.turnId = state.checkpointTurnId = activeId;
          state.presentationInputBaseline = this.presentationInputs(sub, activeId).map(input => input.id);
          state.checkpoint ??= { startedAt: Date.now(), progressEntries: [], thought: "正在恢复主任务进展…", answerPreview: "", finished: false };
        }
        state.completed = state.completed.filter(id => id !== activeId && known.has(id));
        state.baseline = state.baseline?.filter(id => id !== activeId && known.has(id));
        state.retired = state.retired?.filter(id => id !== activeId && known.has(id));
        state.startedAt = active.startedAt;
        state.historyBoundary = followBoundary(active);
        if (state.checkpoint && active.startedAt && Number.isFinite(Date.parse(active.startedAt))) state.checkpoint.startedAt = Date.parse(active.startedAt);
        state.provenanceVersion = 3; state.initialized = true; state.sequence++;
        state.runtime = fresh.state; state.syncStatus = "synced";
        state.observedAt = state.lastSyncedAt = new Date().toISOString(); delete state.syncFailure;
        this.save();
        if (sub.progressEnabled !== false) {
          await this.stream(sub).progress(correction);
          const latest = active.messages.filter(message => message.role === "assistant" && message.kind === "progress").at(-1)?.text;
          if (latest) await this.deliver(sub, activeId, latest);
          await this.stream(sub).flush();
        }
      });
    })().catch(report).finally(() => {
      this.provenanceRepairs.delete(sub.key); this.provenanceRetryAt.set(sub.key, Date.now() + 60000);
    });
    this.provenanceRepairs.set(sub.key, work);
  }
  /** Narrow migration for pre-v2 queue terminals. Known cards are updated in
   * place; only a confirmed still-running CURRENT turn gets a fresh stream. */
  async repairQueuedTerminal(key: string, turnId: string): Promise<boolean> {
    const sub = this.options.subscriptions().find(sub => sub.key === key && sub.enabled !== false);
    if (!sub || !this.options.legacyQueueTerminal?.(sub, turnId)) throw new Error("没有当前绑定对应的旧队列终态，未修改卡片。");
    return this.queue.run(key, async () => {
      await this.repairQueueTerminals(sub, turnId);
      return this.state(sub).queueTerminalRepairs?.[turnId]?.complete === true;
    });
  }
  private async repairQueueTerminals(sub: ThreadSubscription, requestedTurnId?: string): Promise<void> {
    const read = this.options.backend().readTurnLifecycle;
    if (!this.options.legacyQueueTerminal || !read || !sub.client.resumableTextStream || !sub.client.updateTextStream) return;
    const state = this.state(sub);
    const candidates = [
      ...(state.checkpoint && state.checkpointTurnId ? [{ id: state.checkpointTurnId, checkpoint: state.checkpoint, current: true }] : []),
      ...Object.entries(state.pendingTerminals ?? {}).map(([id, pending]) => ({ id, checkpoint: pending.checkpoint, current: false }))
    ].map(item => ({ ...item, explicit: false })).filter(item => item.checkpoint?.finished && item.checkpoint.terminal?.outcome === "interrupted"
      && !state.queueTerminalRepairs?.[item.id]?.complete && this.options.legacyQueueTerminal!(sub, item.id)).slice(0, 3);
    if (requestedTurnId && !candidates.some(item => item.id === requestedTurnId) && !state.queueTerminalRepairs?.[requestedTurnId]?.complete) {
      const scope = { bindingKey: sub.key, conversationId: sub.recipientId, hostId: sub.hostId, threadId: sub.threadId, turnId: requestedTurnId };
      // Explicit local recovery can target a known old card whose checkpoint
      // rotated out. IDs still come exclusively from acknowledged provenance.
      const messageId = this.options.turnAudience?.originalCorrectionCards(scope)[0];
      if (messageId && this.options.legacyQueueTerminal(sub, requestedTurnId)) candidates.push({ id: requestedTurnId, current: false, explicit: true,
        checkpoint: { messageId, startedAt: Date.now(), progressEntries: [], thought: "", answerPreview: "", finished: true,
          terminal: { text: "", error: true, outcome: "interrupted" } } });
    }
    for (const item of candidates) {
      const checkpoint = item.checkpoint!, originalId = checkpoint.messageId;
      if (!originalId) continue;
      try {
        const observed = await this.options.backend().readTurnLifecycle!(sub.threadId, item.id, sub.hostId);
        if (!this.isLive(sub) || observed.source === "unknown" || observed.status === "unknown" || observed.status === "interrupted") continue;
        if (item.current && state.checkpoint !== checkpoint || !item.current && !item.explicit && state.pendingTerminals?.[item.id]?.checkpoint !== checkpoint) continue;
        const scope = { bindingKey: sub.key, conversationId: sub.recipientId, hostId: sub.hostId, threadId: sub.threadId, turnId: item.id };
        const targets = [...new Set([originalId, ...this.options.turnAudience?.correctionTargets(scope, originalId) ?? []])];
        const repair = (state.queueTerminalRepairs ??= {})[item.id] ??= { acknowledged: [] };
        const text = observed.status === "inProgress"
          ? "状态更正：此前“已中断”是 Gateway 判断错误。已确认原任务仍在执行，后续进展继续同步；未重新提交任务。"
          : `状态更正：此前“已中断”是 Gateway 判断错误。原生任务已确认${observed.status === "completed" ? "完成" : "失败"}。\n\n${visibleText(observed.text ?? "").trim() || (observed.failureCode ? codexFailureSummary(observed.failureCode) : "请用 /history 查看原轮次结果。")}`;
        this.save();
        for (const messageId of targets) {
          if (repair.acknowledged.includes(messageId)) continue;
          if (!this.isLive(sub)) return;
          await sub.client.updateTextStream({ toUserId: sub.recipientId, messageId, text, finalize: true, error: false });
          if (!this.isLive(sub)) return;
          repair.acknowledged.push(messageId); this.save();
        }
        if (item.current && observed.status === "inProgress") {
          await this.streams.get(sub.key)?.suspend(); this.streams.delete(sub.key);
          state.prematureQueueTerminal = { turnId: item.id, checkpoint };
          state.checkpoint = undefined; state.delivered = [];
          state.completed = state.completed.filter(id => id !== item.id);
          state.baseline = state.baseline?.filter(id => id !== item.id);
          state.retired = state.retired?.filter(id => id !== item.id);
          delete state.terminalPending;
        } else if (observed.status !== "inProgress") {
          checkpoint.terminal = { text, error: observed.status === "failed", outcome: observed.status };
          if (!state.completed.includes(item.id)) state.completed = [...state.completed, item.id].slice(-200);
          if (!item.current && state.pendingTerminals) delete state.pendingTerminals[item.id];
        }
        repair.complete = true; state.sequence++; this.save();
      } catch { console.warn("[codex-im-gateway] queue terminal correction deferred; original input was not replayed"); }
    }
  }

  private async reconcile(sub: ThreadSubscription, snapshot: CodexThreadSnapshot, force = false, options: FollowSyncOptions = {}): Promise<void> {
    if (!this.isLive(sub)) return;
    const state = this.state(sub);
    state.runtime = snapshot.state;
    this.options.onThreadState?.(sub, snapshot.state);
    if (snapshot.state.runtimeStatus !== "systemError") this.options.onRecoveryObservation?.(sub, snapshot);
    if (snapshot.state.activeTurnId && this.options.holdsCapacityStart?.({ hostId: sub.hostId,
      threadId: sub.threadId, turnId: snapshot.state.activeTurnId })) return;
    state.observedAt = new Date().toISOString();
    // Runtime availability alone is never a terminal receipt. A system error
    // may nevertheless contain an explicit failure for our exact tracked turn.
    if (["archived", "missing"].includes(snapshot.state.persistence)) return;
    if (snapshot.state.runtimeStatus === "systemError") {
      await this.reconcileConfirmedFailure(sub, snapshot, force, options);
      return;
    }
    if (!state.historyBoundary && ["active", "idle"].includes(snapshot.state.runtimeStatus)) {
      // Migration must not trust an old cursor already moved backwards by the
      // replay bug. Freeze the newly visible history at its native tail. The
      // exact tracked result/pending receipts remain independently recoverable.
      const tail = snapshot.turns.at(-1);
      state.historyBoundary = tail ? followBoundary(tail)
        : followBoundary(state.turnId ? { id: state.turnId, startedAt: state.startedAt } : undefined);
      if (!sub.managed && snapshot.state.runtimeStatus === "idle" && tail && state.turnId && tail.id !== state.turnId
        && (state.terminalPending || state.checkpoint?.terminal && !state.checkpoint.finished)) {
        const retired = state.turnId;
        this.rotateStream(sub); // Keep this old result, but only recover an already delivered card.
        state.retired = [...(state.retired ?? []), retired].slice(-200);
        state.turnId = undefined;
      }
      this.save();
    }
    const boundary = state.historyBoundary ? { ...state.historyBoundary } : followBoundary();
    const currentTurn = snapshot.state.runtimeStatus === "active" ? snapshot.turns.filter(turn => turn.status === "inProgress"
      && (!snapshot.state.activeTurnId || turn.id === snapshot.state.activeTurnId)).at(-1) : undefined;
    if (!sub.managed && currentTurn && state.turnId && state.turnId !== currentTurn.id && !state.terminalPending) {
      const previous = snapshot.turns.find(turn => turn.id === state.turnId && turn.status !== "inProgress");
      const text = previous?.messages.filter(message => message.role === "assistant" && message.kind !== "progress").map(message => message.text).join("\n\n");
      if (text?.trim() && previous && previous.status !== "inProgress") state.terminalPending = {
        turnId: state.turnId, text: visibleText(text).trim(), fallbackSent: false, outcome: previous.status };
    }
    if (!sub.managed && currentTurn && state.turnId !== currentTurn.id) await this.selectTurn(sub, currentTurn.id, true);
    if (currentTurn?.id === state.turnId) {
      for (const input of this.presentationInputs(sub, state.turnId)) await this.segmentInput(sub, input);
    }
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
      if (repair && repair.status !== "inProgress" && text?.trim()) {
        if (repair.id === state.turnId) state.terminalPending = { turnId: repair.id, text: visibleText(text).trim(), fallbackSent: false, outcome: repair.status };
        else (state.pendingTerminals ??= {})[repair.id] = { text: visibleText(text).trim(), outcome: repair.status };
        delete state.repairTurnId;
        this.save();
      }
    }
    this.retryPreviousTerminals(sub, force);
    if (!this.isLive(sub)) return;
    if (state.terminalPending) {
      await this.finish(sub, state.terminalPending.turnId, state.terminalPending.text, false,
        { recoverBootstrap: force, confirmUncertainDelivery: options.confirmUncertainDelivery, outcome: state.terminalPending.outcome });
    }
    const { turns } = snapshot;
    if (!state.initialized && ["active", "idle"].includes(snapshot.state.runtimeStatus)) {
      // History replay handles past turns; only current and subsequent turns
      // are forwarded. This boundary is retained across service restarts.
      state.baseline = turns.filter((turn) => turn.status !== "inProgress" && turn.id !== state.turnId).map((turn) => turn.id);
      state.initialized = true;
      this.save();
    }
    // A bounded history window omitting a turn is not a completion event either.
    for (const turn of turns) {
      if (state.completed.includes(turn.id) || state.baseline?.includes(turn.id) || state.pendingTerminals?.[turn.id]) continue;
      if (sub.managed) {
        if (turn.status === "inProgress" && (!state.turnId || state.turnId === turn.id)) {
          state.turnId = turn.id; this.save();
        }
        // Managed Desktop runs are observed through owner snapshots too. A
        // native retry is presentation-only, never a second execution owner.
        if (turn.status === "inProgress" && snapshot.state.runtimeStatus === "active"
          && (!snapshot.state.activeTurnId || snapshot.state.activeTurnId === turn.id)
          && state.turnId === turn.id && snapshot.state.recovery?.threadId === sub.threadId
          && snapshot.state.recovery.turnId === turn.id && state.checkpoint
          && sub.progressEnabled !== false) {
          await this.stream(sub).waitForRecovery(codexRecoverySummary(snapshot.state.recovery));
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
        if (snapshot.state.recovery?.threadId === sub.threadId && snapshot.state.recovery.turnId === turn.id
          && sub.progressEnabled !== false) {
          await this.stream(sub).waitForRecovery(codexRecoverySummary(snapshot.state.recovery));
        }
      } else {
        // A private App Server reconstructs foreign, unloaded turns as
        // completed/interrupted even while Desktop is still executing them.
        // Only a loaded runtime or an explicit lifecycle event can end a card.
        if (snapshot.state.runtimeStatus === "notLoaded" || snapshot.state.runtimeStatus === "unknown") continue;
        if (turn.id !== state.turnId && !afterFollowBoundary(turn, turns, boundary)) continue;
        if (turn.status === "failed" && snapshot.state.lastTurnFailure?.turnId === turn.id
          && snapshot.state.lastTurnFailure.code === "model-capacity"
          && this.options.onCapacityFailure?.({ hostId: sub.hostId, threadId: sub.threadId, turnId: turn.id })) continue;
        const final = turn.messages.filter((message) => message.role === "assistant" && message.kind !== "progress")
          .map((message) => message.text).join("\n\n");
        const failure = snapshot.state.lastTurnFailure;
        await this.finish(sub, turn.id, final || (turn.status === "failed" && failure?.turnId === turn.id
          ? `${codexFailureSummary(failure.code)}\n原生轮次已确认失败；Gateway 未重新执行任务或切换模型。`
          : turn.status === "completed" ? "任务已完成。" : "任务已停止或执行失败。"),
          Boolean(state.turnId && state.completed.includes(state.turnId)), { outcome: turn.status });
      }
    }
    if (currentTurn && currentTurn.id === state.turnId && !state.terminalPending && state.checkpoint && sub.progressEnabled !== false) {
      const flags = snapshot.state.activeFlags;
      await this.stream(sub).setActivity(flags.includes("waitingOnApproval") ? "waiting-approval"
        : flags.includes("waitingOnUserInput") ? "waiting-input"
        : snapshot.state.recovery?.threadId === sub.threadId && snapshot.state.recovery.turnId === currentTurn.id ? "recovering" : "running");
    }
    // Advance only from the native ordered/timestamped window, not from an
    // arbitrary unseen ID. Preserve the cursor even when old pages appear later.
    const newest = turns.at(-1);
    if (["active", "idle"].includes(snapshot.state.runtimeStatus) && newest
      && (newest.id === state.turnId || afterFollowBoundary(newest, turns, boundary))) {
      state.historyBoundary = followBoundary({ ...newest,
        startedAt: newest.startedAt ?? (newest.id === boundary.turnId ? boundary.startedAt : undefined) });
      this.save();
    }
  }
  /** Settle only an already tracked native failure, not arbitrary history or
   * a systemError observation. Execution availability remains unchanged. */
  private async reconcileConfirmedFailure(sub: ThreadSubscription, snapshot: CodexThreadSnapshot,
    force: boolean, options: FollowSyncOptions): Promise<void> {
    const state = this.state(sub);
    const turnId = state.turnId;
    const failure = snapshot.state.lastTurnFailure;
    if (sub.managed || snapshot.state.persistence !== "active" || !turnId || failure?.turnId !== turnId
      || state.completed.includes(turnId) || state.baseline?.includes(turnId) || state.retired?.includes(turnId)
      || state.checkpointTurnId && state.checkpointTurnId !== turnId
      || state.terminalPending && (state.terminalPending.turnId !== turnId || state.terminalPending.outcome !== "failed")) return;
    const turn = snapshot.turns.find(item => item.id === turnId && item.status === "failed");
    if (!turn) return;
    // Do not replace a persisted card on a transport that cannot resume it.
    if (hasDeliveredCard(state.checkpoint) && !sub.client.resumableTextStream && !this.streams.has(sub.key)) return;
    if (failure.code === "model-capacity"
      && this.options.onCapacityFailure?.({ hostId: sub.hostId, threadId: sub.threadId, turnId })) return;
    const partial = visibleText(turn.messages.filter(message => message.role === "assistant" && message.kind !== "progress")
      .map(message => message.text).join("\n\n")).trim();
    const text = state.terminalPending?.text ?? [codexFailureSummary(failure.code),
      "原生轮次已确认失败；Gateway 未重新执行任务或切换模型。",
      ...(partial ? [`已生成的回复（本轮未成功完成）：\n\n${partial}`] : [])].join("\n\n");
    await this.finish(sub, turnId, text, false, { recoverBootstrap: force,
      confirmUncertainDelivery: options.confirmUncertainDelivery, outcome: "failed" });
  }

  /** Only an actual start event (or a loaded backend snapshot) may switch turns. */
  async started(hostId: string, threadId: string, turnId: string, startedAt: string): Promise<void> {
    if (this.options.holdsCapacityStart?.({ hostId, threadId, turnId })) return;
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
        state.historyBoundary = followBoundary({ id: turnId, startedAt });
        state.sequence++;
        this.save();
      })));
  }
  /** A notification is a hint, not authority to target a different host. */
  async activity(hostId: string, threadId: string, turnId: string, text: string): Promise<void> {
    if (this.options.holdsCapacityStart?.({ hostId, threadId, turnId })) return;
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
  async completion(hostId: string, threadId: string, turnId: string, text: string, outcome: TurnOutcome = "completed"): Promise<void> {
    if (this.options.holdsCapacityStart?.({ hostId, threadId, turnId })) return;
    await Promise.all(this.options.subscriptions().filter((sub) =>
      sub.enabled !== false && sub.hostId === hostId && sub.threadId === threadId && !sub.managed)
      .map((sub) => this.queue.run(sub.key, () => this.finish(sub, turnId, text, false, { outcome }))));
  }

  /** An explicitly accepted empty continuation changes native identity only;
   * presentation and audience stay attached to the same recovery operation. */
  async capacityAccepted(scope: { hostId: string; threadId: string; turnId: string }, acceptedTurnId: string): Promise<void> {
    await Promise.all(this.options.subscriptions().filter(sub => sub.enabled !== false
      && sub.hostId === scope.hostId && sub.threadId === scope.threadId).map(sub => this.queue.run(sub.key, async () => {
        if (!this.isLive(sub)) return;
        const state = this.state(sub);
        if (state.completed.includes(acceptedTurnId) || state.retired?.includes(acceptedTurnId)
          || state.turnId && state.turnId !== scope.turnId && !state.completed.includes(state.turnId)) return;
        // A user may request continuation after the failure result was already
        // delivered. Preserve that terminal card; only a confirmed new native
        // acceptance may create the next progress card.
        const newCard = Boolean(state.checkpoint?.terminal || state.turnId && state.completed.includes(state.turnId));
        if (newCard) this.rotateStream(sub);
        const oldScope = { ...scope, bindingKey: sub.key, conversationId: sub.recipientId };
        for (const participant of this.options.turnAudience?.participants(oldScope) ?? []) {
          this.options.turnAudience?.record({ ...oldScope, turnId: acceptedTurnId },
            { bindingKey: sub.key, conversationId: sub.recipientId, actorId: participant.actorId, mention: participant.mention }, participant.acceptedAt);
        }
        state.completed = [...state.completed, scope.turnId].slice(-200);
        state.turnId = acceptedTurnId; state.checkpointTurnId = acceptedTurnId;
        state.terminalPending = undefined;
        state.sequence++; this.save();
        await this.stream(sub).waitForRecovery(newCard
          ? "容量恢复已获 Codex 接收，正在原会话中继续执行。上一张卡保留失败记录，本卡跟随新接收的原生轮次。"
          : "容量自动恢复已获 Codex 接收，正在原会话中继续执行。沿用本张卡片，未重新发送原问题。");
      })));
  }

  async capacityNotice(scope: { hostId: string; threadId: string; turnId: string }, text: string): Promise<void> {
    await Promise.all(this.options.subscriptions().filter(sub => sub.enabled !== false && sub.progressEnabled !== false
      && sub.hostId === scope.hostId && sub.threadId === scope.threadId).map(sub => this.queue.run(sub.key, async () => {
        if (this.isLive(sub) && this.state(sub).turnId === scope.turnId) await this.stream(sub).waitForRecovery(text);
      })));
  }

  async systemRecoveryNotice(scope: { hostId: string; threadId: string; turnId: string },
    progress: NonNullable<SessionFollowStatus["runtimeRecovery"]>, verifiedState?: CodexThreadState, assertSource?: () => void): Promise<void> {
    await Promise.all(this.options.subscriptions().filter(sub => sub.enabled !== false && sub.hostId === scope.hostId
      && sub.threadId === scope.threadId).map(sub => this.queue.run(sub.key, async () => {
      if (this.stopped || !this.isLive(sub)) return;
      assertSource?.();
      const state = this.state(sub), previous = state.runtimeRecovery;
      const reuse = previous?.turnId === progress.turnId && !(progress.phase === "recovering" && previous.checkpoint?.finished);
      const record = { ...progress, ...(reuse ? { checkpoint: previous!.checkpoint } : {}) };
      state.runtimeRecovery = record;
      if (progress.phase === "recovered" && verifiedState?.threadId === scope.threadId && verifiedState.persistence === "active"
        && ["idle", "active"].includes(verifiedState.runtimeStatus)
        && (!state.runtime?.activeTurnId || state.runtime.activeTurnId === verifiedState.activeTurnId)
        && (state.runtime?.runtimeStatus !== "systemError" || state.runtime.lastTurnFailure?.turnId === scope.turnId)) {
        state.runtime = structuredClone(verifiedState); state.observedAt = state.lastSyncedAt = new Date().toISOString();
        state.syncStatus = "synced"; delete state.syncFailure;
      }
      this.save();
      if (sub.progressEnabled === false) return;
      const stream = new ChannelTurnPresentation(this.presentationClient(sub, undefined, undefined, assertSource), sub.recipientId, {
        restore: record.checkpoint, contextToken: sub.contextToken,
        decorateProgress: this.options.decorateProgress ? text => this.options.decorateProgress!(sub, text) : undefined,
        save: checkpoint => {
          assertSource?.();
          if (!this.isLive(sub) || state.runtimeRecovery !== record) throw Error("System recovery presentation owner changed");
          record.checkpoint = checkpoint; this.save();
        }
      });
      try {
        if (["recovering", "restoring", "waiting"].includes(progress.phase)) { await stream.progress(progress.message); await stream.flush(); }
        else {
          let text = progress.message;
          try { text = await this.options.decorateFinal?.(sub, text) ?? text; } catch { /* optional IDE metadata */ }
          await stream.finalize(text, progress.phase !== "recovered");
        }
      } finally { await stream.suspend(); }
    })));
  }

  /** Presentation-only repair for historical capacity cards accidentally
   * reopened by an older startup projector. Native outcome/binding stay intact. */
  async retireCapacityProjection(scope: { hostId: string; threadId: string; turnId: string }, text: string): Promise<void> {
    await Promise.all(this.options.subscriptions().filter(sub => sub.enabled !== false
      && sub.hostId === scope.hostId && sub.threadId === scope.threadId).map(sub => this.queue.run(sub.key, async () => {
        if (!this.isLive(sub)) return;
        const state = this.state(sub), checkpoint = state.checkpoint;
        if (state.turnId !== scope.turnId || state.checkpointTurnId !== scope.turnId || !checkpoint?.messageId
          || checkpoint.terminal || checkpoint.finished && !checkpoint.presentationCorrection
          || !checkpoint.presentationCorrection && (!state.historyBoundary?.turnId || state.historyBoundary.turnId === scope.turnId
            || !state.completed.includes(state.historyBoundary.turnId) || state.pendingTerminals?.[scope.turnId])) return;
        state.sequence++; this.save();
        await this.stream(sub).invalidatePresentation(text);
      })));
  }

  async capacityTerminal(scope: { hostId: string; threadId: string; turnId: string }, text: string, outcome: TurnOutcome = "completed"): Promise<void> {
    await Promise.all(this.options.subscriptions().filter(sub => sub.enabled !== false
      && sub.hostId === scope.hostId && sub.threadId === scope.threadId).map(sub => this.queue.run(sub.key, async () => {
        if (this.isLive(sub) && this.state(sub).turnId === scope.turnId) await this.finish(sub, scope.turnId, text, false, { outcome });
      })));
  }
  async recoverCompletion(hostId: string, threadId: string, turnId: string, text: string, outcome: TurnOutcome = "completed"): Promise<void> {
    await Promise.all(this.options.subscriptions().filter((sub) => sub.enabled !== false
      && sub.hostId === hostId && sub.threadId === threadId && !sub.managed
      && this.states[sub.key]?.turnId === turnId)
      .map((sub) => this.queue.run(sub.key, () => this.finish(sub, turnId, text, false, { outcome }))));
  }
  /** A confirmed native input splits presentation only. Never completes a turn. */
  async acceptedInput(input: AcceptedPresentationInput): Promise<void> {
    this.recordParticipant(input);
    await Promise.all(this.options.subscriptions().filter(sub => sub.enabled !== false
      && sub.hostId === input.hostId && sub.threadId === input.threadId)
      .map(sub => this.queue.run(sub.key, () => this.segmentInput(sub, input))));
  }
  private recordParticipant(input: AcceptedPresentationInput): void {
    if (!input.origin) return;
    this.options.turnAudience?.record({ bindingKey: input.origin.bindingKey, conversationId: input.origin.conversationId,
      hostId: input.hostId, threadId: input.threadId, turnId: input.turnId }, input.origin, input.acceptedAt);
  }
  private async notifyParticipants(sub: ThreadSubscription, turnId: string): Promise<void> {
    try {
      const isCurrent = () => {
        const current = this.currentSubscription(sub);
        return !this.stopped && current?.recipientId === sub.recipientId && current.client === sub.client
          && this.state(sub).turnId === turnId;
      };
      if (!this.options.turnAudience || !isCurrent() || this.state(sub).turnId !== turnId) return;
      for (const input of this.presentationInputs(sub, turnId)) this.recordParticipant(input);
      await this.options.turnAudience.notify({ bindingKey: sub.key, conversationId: sub.recipientId,
        hostId: sub.hostId, threadId: sub.threadId, turnId }, sub.client,
      { isCurrent, contextToken: sub.contextToken, onTextDelivered: sub.onTextDelivered,
        completedCard: completedCardForMentions(this.state(sub).checkpoint) });
    } catch { console.warn("[codex-im-gateway] turn mention journal unavailable; result delivery preserved"); }
  }
  private presentationInputs(sub: ThreadSubscription, turnId?: string): AcceptedPresentationInput[] {
    return (this.options.acceptedInputs?.() ?? []).filter(input => input.hostId === sub.hostId
      && input.threadId === sub.threadId && input.turnId === turnId).slice().sort((a, b) => a.acceptedAt - b.acceptedAt || a.id.localeCompare(b.id));
  }
  private async segmentInput(sub: ThreadSubscription, input: AcceptedPresentationInput): Promise<void> {
    if (this.stopped || !this.isLive(sub) || sub.progressEnabled === false) return;
    const state = this.state(sub);
    if (state.hostId !== input.hostId || state.threadId !== input.threadId || state.turnId !== input.turnId
      || state.completed.includes(input.turnId) || state.terminalPending || state.presentationInputBaseline?.includes(input.id)) return;
    if (await this.stream(sub).startSegment(input)) { state.sequence++; this.save(); }
  }
  /** Reuse the same persistent record for turns initiated from the IM channel. */
  async managedTurnStarted(sub: ThreadSubscription, turnId: string): Promise<void> {
    await this.queue.run(sub.key, async () => this.managedStarted(sub, turnId));
  }

  managedStarted(sub: ThreadSubscription, turnId: string): void {
    if (!this.isLive(sub)) return;
    const state = this.state(sub);
    if (state.turnId !== turnId && !this.preparedStreams.has(sub.key)) this.rotateStream(sub);
    if (state.turnId !== turnId) state.presentationInputBaseline = this.presentationInputs(sub, turnId).map(input => input.id);
    state.turnId = turnId;
    state.checkpointTurnId = turnId;
    this.preparedStreams.delete(sub.key);
    state.sequence++;
    this.save();
  }

  managedStream(sub: ThreadSubscription): ChannelTurnPresentation {
    const state = this.state(sub);
    this.rotateStream(sub);
    state.turnId = undefined;
    state.sequence++;
    this.preparedStreams.add(sub.key);
    this.save();
    return this.stream(sub);
  }
  /** Serialize presentation rotation with in-flight completion acknowledgements. */
  async prepareManagedStream(sub: ThreadSubscription, acceptedTurnId?: string): Promise<ChannelTurnPresentation> {
    return this.queue.run(sub.key, async () => {
      if (acceptedTurnId) {
        if (!await this.selectTurn(sub, acceptedTurnId, true)) throw new Error("Accepted queue binding changed");
        return this.stream(sub);
      }
      return this.managedStream(sub);
    });
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
        outcome: pending?.outcome ?? state.checkpoint?.terminal?.outcome,
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
    state.checkpoint = nextTurnCheckpoint(state.checkpoint);
    state.checkpointTurnId = undefined;
    state.presentationInputBaseline = undefined;
    state.delivered = [];
    this.save();
  }

  private retryPreviousTerminals(sub: ThreadSubscription, force = false): void {
    const state = this.state(sub);
    // Independent records: a failed old card cannot block a current turn.
    for (const [turnId, pending] of Object.entries(state.pendingTerminals ?? {})
      .filter(([, item]) => hasDeliveredCard(item.checkpoint)).slice(0, 5)) {
      if (!this.isLive(sub)) return;
      // Do not burst old uncreated answers into a chat after restart/routing
      // repair. They remain durable and discoverable through /status /history.
      // Current-turn delivery still uses finish(), with its original lifecycle.
      const recoveryKey = JSON.stringify([sub.key, sub.hostId, sub.threadId, turnId]);
      if (this.previousRecoveries.has(recoveryKey) || !force && Date.now() < (this.previousRetryAt.get(recoveryKey) ?? 0)) continue;
      if (pending.checkpoint?.messageId && !sub.client.resumableTextStream) continue;
      const work = (async () => {
      const stream = new ChannelTurnPresentation(this.presentationClient(sub), sub.recipientId, {
        restore: pending.checkpoint, contextToken: sub.contextToken, onTextDelivered: sub.onTextDelivered, progressEnabled: sub.progressEnabled,
        save: checkpoint => {
          if (this.stopped || !this.isLive(sub) || state.pendingTerminals?.[turnId] !== pending) throw new Error("Old result binding changed");
          pending.checkpoint = checkpoint; this.save();
        }
      });
      try {
        const delivered = await stream.finalize(pending.text, pending.outcome === "failed" || pending.outcome === "interrupted",
          { recoverBootstrap: force, existingOnly: true, outcome: pending.outcome });
        if (delivered && this.isLive(sub) && state.pendingTerminals?.[turnId] === pending) {
          delete state.pendingTerminals![turnId];
          state.completed = [...state.completed, turnId].slice(-200);
          if (state.repairTurnId === turnId) delete state.repairTurnId;
          this.logDelivery(sub, turnId, "delivered");
        }
      } finally { await stream.suspend(); this.save(); }
      })().catch(() => { /* Preserve the old record independently of current progress. */ }).finally(() => {
        this.previousRecoveries.delete(recoveryKey); this.previousRetryAt.set(recoveryKey, Date.now() + 60_000);
      });
      this.previousRecoveries.set(recoveryKey, work);
    }
  }
  private stream(sub: ThreadSubscription): ChannelTurnPresentation {
    let stream = this.streams.get(sub.key);
    const owner = stream && this.streamOwners.get(stream);
    if (stream && owner && (owner.client !== sub.client || owner.recipientId !== sub.recipientId
      || owner.hostId !== sub.hostId || owner.threadId !== sub.threadId)) {
      const previous = stream;
      const retiring = (this.retiringStreams.get(sub.key) ?? Promise.resolve()).then(() => previous.suspend()).catch(report);
      this.retiringStreams.set(sub.key, retiring);
      void retiring.finally(() => { if (this.retiringStreams.get(sub.key) === retiring) this.retiringStreams.delete(sub.key); });
      this.streams.delete(sub.key);
      stream = undefined;
    }
    if (stream) return stream;
    const state = this.state(sub);
    const saved = state.checkpoint;
    // Only transports explicitly supporting persisted handles may resume.
    const restore = saved && (sub.client.resumableTextStream || !saved.messageId)
      ? saved : undefined;
    const captured = { ...sub }, barrier = this.retiringStreams.get(sub.key) ?? Promise.resolve();
    const client = this.presentationClient(captured, barrier, (method, args) => method === "updateTextStream"
      && this.closingPresentations.has(stream!) && Boolean((args[0] as { finalize?: boolean } | undefined)?.finalize));
    stream = new ChannelTurnPresentation(client, sub.recipientId, {
      restore, contextToken: sub.contextToken, onTextDelivered: sub.onTextDelivered, progressEnabled: sub.progressEnabled,
      ...(this.options.decorateProgress ? { decorateProgress: (text: string) => this.isLive(sub) ? this.options.decorateProgress!(sub, text) : text } : {}),
      save: (checkpoint) => {
        if (!this.isLive(captured) && !this.closingPresentations.has(stream!)) return;
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
    this.streamOwners.set(stream, captured);
    return stream;
  }
  private presentationClient(sub: ThreadSubscription, barrier = Promise.resolve(), closing?: (method: string, args: unknown[]) => boolean,
    assertCurrent?: () => void): ThreadSubscription["client"] {
    const client = Object.create(sub.client) as ThreadSubscription["client"];
    for (const method of ["sendText", "sendProgressText", "startTextStream", "updateTextStream"] as const) {
      if (typeof sub.client[method] !== "function") continue;
      Object.defineProperty(client, method, { value: async (...args: unknown[]) => {
        await barrier;
        if (!closing?.(method, args) && (this.stopped || !this.isLive(sub))) throw new Error("Channel presentation owner changed; no write attempted");
        assertCurrent?.();
        const send = Reflect.get(sub.client, method);
        if (typeof send !== "function") throw new Error("Channel presentation transport is unavailable");
        return Reflect.apply(send, sub.client, args);
      } });
    }
    return client;
  }
  private async selectTurn(sub: ThreadSubscription, turnId: string, allowSwitch = false): Promise<FollowState | undefined> {
    const state = this.state(sub);
    if (state.retired?.includes(turnId)) return undefined;
    if (!state.turnId && this.preparedStreams.has(sub.key)) {
      state.presentationInputBaseline = this.presentationInputs(sub, turnId).map(input => input.id);
      state.turnId = turnId;
      state.checkpointTurnId = turnId;
      this.preparedStreams.delete(sub.key);
      this.save();
      return state;
    }
    if (state.turnId !== turnId) {
      if (state.turnId && !allowSwitch) return undefined;
      const old = this.streams.get(sub.key)
        ?? (state.checkpoint && !state.checkpoint.finished && (state.checkpoint.messageId || state.checkpoint.creationAttempted || state.checkpoint.bootstrap)
          ? this.stream(sub) : undefined);
      const hadResult = Boolean(state.terminalPending || state.checkpoint?.terminal);
      this.archiveTerminal(state, hadResult);
      if (old) {
        if (hadResult) { void old.suspend().catch(report); this.streams.delete(sub.key); }
        else await old.nextTurn(turnId);
      }
      // A synthetic "switched turns" closure is not a model's final result.
      if (state.turnId) state.retired = [...(state.retired ?? []), state.turnId].slice(-200);
      state.turnId = turnId;
      state.checkpointTurnId = turnId;
      if (!old || hadResult) state.checkpoint = nextTurnCheckpoint(state.checkpoint);
      state.presentationInputBaseline = this.presentationInputs(sub, turnId).map(input => input.id);
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
    recovery: { recoverBootstrap?: boolean; confirmUncertainDelivery?: boolean; outcome?: TurnOutcome } = {}): Promise<void> {
    const current = this.currentSubscription(sub);
    if (!current) return;
    sub = current;
    const state = this.state(sub);
    if (state.completed.includes(turnId)) { void this.notifyParticipants(sub, turnId); return; }
    if (!await this.selectTurn(sub, turnId, allowSwitch)) return;
    const visible = visibleText(text).trim() || "任务已结束。";
    let clean = visible;
    try { clean = await this.options.decorateFinal?.(sub, visible) ?? visible; }
    catch { /* Optional IDE metadata must never prevent result delivery. */ }
    // Optional native context reads can outlive a detach, a replacement turn,
    // or another completion delivery. Never publish into that newer binding.
    if (!this.isLive(sub) || state.turnId !== turnId || state.completed.includes(turnId)) return;
    state.terminalPending ??= { turnId, text: clean, fallbackSent: false, outcome: recovery.outcome };
    this.save();
    const stream = this.stream(sub);
    const outcome = state.terminalPending.outcome ?? recovery.outcome;
    if (!await stream.finalize(clean, outcome === "failed" || outcome === "interrupted", { ...recovery, outcome })) {
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
    // An ancillary reminder must not hold the progress/control serial queue.
    void this.notifyParticipants(sub, turnId);
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
      && current.hostId === sub.hostId && current.threadId === sub.threadId
      && current.recipientId === sub.recipientId && current.client === sub.client);
  }

  private async sendText(sub: ThreadSubscription, text: string): Promise<void> {
      if (this.stopped || !this.isLive(sub)) throw new Error("Channel presentation owner changed; no write attempted");
      await sub.client.sendText({
        toUserId: sub.recipientId, text,
        ...(sub.contextToken ? { contextToken: sub.contextToken } : {})
      });
  }
}

function visibleText(text: string): string {
  return parseActionBlocks(text, { strict: false }).visibleText;
}
function hasDeliveredCard(checkpoint?: ChannelStreamCheckpoint): boolean {
  return Boolean(checkpoint?.messageId || checkpoint?.bootstrap?.stage === "delivered" && checkpoint.bootstrap.messageId);
}
function isLegacyObservationNotice(text: string): boolean {
  return ["会话已归档、不可用或发生系统错误；请在 Codex 中检查。", "原任务已不在最近记录中。请用 /history 查看结果。"].includes(text.trim());
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
