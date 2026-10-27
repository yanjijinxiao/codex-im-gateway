import crypto from "node:crypto";
import { readJsonFile, isJsonObject as record, writeJsonFile } from "../state/json-store.js";
import { SessionControlQueue } from "./session-control.js";
import { CodexBackendCapabilityError, CodexQueueAdmissionError, type CodexBridgeBackend, type CodexQueuedSubmission, type CodexQueueAddInput } from "../codex/backend.js";

export type QueueOrigin = {
  mention?: import("../channels/types.js").ChannelMention;
  accountId: string; conversationId: string; actorId: string; messageId: string;
  sessionId: string; hostId: string; backend: string; threadId: string;
};
export type QueueReceipt = QueueOrigin & {
  id: string; clientUserMessageId: string; queuedSubmissionId?: string; turnId?: string;
  status: "submitting" | "queued" | "starting" | "running" | "completed" | "uncertain" | "cancelled" | "rejected";
  updatedAt: string; reason?: string;
  delivered?: boolean;
  deliveryUnconfirmed?: boolean;
  /** v2 terminal status was verified against an owner or native lifecycle event. */
  lifecycleVersion?: 2;
};
const unsettled = new Set<QueueReceipt["status"]>(["submitting", "queued", "starting", "running", "uncertain"]);
const threadKey = (r: QueueOrigin) => JSON.stringify([r.backend, r.hostId, r.threadId]);

/** A submission journal, NOT an execution backlog: prompts/order live only in Codex.
 * After an uncertain acknowledgement we query exact ids; we never call add again.
 * Shared by accounts so two IM frontends cannot dispatch the same native head.
 */
export class NativeQueueCoordinator {
  private readonly reconciling = new WeakMap<CodexBridgeBackend, Map<string, Promise<void>>>();
  private receipts: Record<string, QueueReceipt>;
  private readonly controls = new SessionControlQueue();
  private readonly dispatching = new Set<string>();
  constructor(private readonly filePath: string, private readonly options: { observationTimeoutMs?: number } = {}) {
    const data = readJsonFile<unknown>(filePath, { receipts: {} });
    if (!record(data) || !record(data.receipts) || Object.entries(data.receipts).some(([id, value]) =>
      !record(value) || !/^[a-f0-9]{64}$/.test(id) || value.id !== id || value.clientUserMessageId !== `gateway-${id}`
      || !["submitting", "queued", "starting", "running", "completed", "uncertain", "cancelled", "rejected"].includes(String(value.status))
      || !["app-server", "exec"].includes(String(value.backend))
      || ["accountId", "conversationId", "actorId", "messageId", "sessionId", "hostId", "threadId", "updatedAt"].some(key => typeof value[key] !== "string" || !value[key])))
      throw new Error("Invalid native queue receipt journal; original file preserved");
    this.receipts = data.receipts as Record<string, QueueReceipt>;
  }
  private save(): void { writeJsonFile(this.filePath, { receipts: this.receipts }, { durable: true }); }
  private update(r: QueueReceipt, changes: Partial<QueueReceipt>): void {
    if (Object.entries(changes).every(([key, value]) => r[key as keyof QueueReceipt] === value)) return;
    Object.assign(r, changes, { updatedAt: new Date().toISOString() }); this.save();
  }
  list(accountId: string, conversationId?: string): QueueReceipt[] {
    return Object.values(this.receipts).filter(r => r.accountId === accountId
      && (!conversationId || r.conversationId === conversationId)).map(r => structuredClone(r));
  }
  hasUnsettledThread(threadId: string, hostId: string): boolean {
    return Object.values(this.receipts).some(r => r.threadId === threadId && r.hostId === hostId
      && (unsettled.has(r.status) || r.status === "completed" && !r.delivered));
  }
  hasLegacyTerminal(scope: { accountId: string; sessionId: string; hostId: string; threadId: string; turnId: string }): boolean {
    return Object.values(this.receipts).some(r => r.accountId === scope.accountId && r.sessionId === scope.sessionId
      && r.hostId === scope.hostId && r.threadId === scope.threadId && r.turnId === scope.turnId
      && r.status === "completed" && r.lifecycleVersion !== 2);
  }
  async enqueue(origin: QueueOrigin, prompt: string, backend: CodexBridgeBackend,
    handlers: Pick<CodexQueueAddInput, "onApproval" | "onApprovalResult" | "onUserInput" | "onUserInputResult" | "assertCurrent"> = {}): Promise<QueueReceipt> {
    if (!backend.addQueuedSubmission || backend.backendInfo(origin.hostId).capabilities.nativeQueue === false) {
      throw new CodexBackendCapabilityError("nativeQueue", backend.backendInfo(origin.hostId).id);
    }
    // Identity includes the IM account/actor, not just a sender id or text hash.
    const id = crypto.createHash("sha256").update(JSON.stringify([
      origin.accountId, origin.conversationId, origin.actorId, origin.messageId
    ])).digest("hex");
    return this.controls.run(threadKey(origin), async () => {
      const existing = this.receipts[id];
      if (existing) {
        if (existing.threadId !== origin.threadId || existing.hostId !== origin.hostId || existing.backend !== origin.backend) {
          throw new Error("这条 IM 消息已归属于原会话，不能在切换绑定后重新提交。");
        }
        // Accepted and ambiguous submissions alike must never be replayed.
        return structuredClone(existing);
      }
      handlers.assertCurrent?.();
      const r: QueueReceipt = { ...origin, id, clientUserMessageId: `gateway-${id}`,
        status: "submitting", updatedAt: new Date().toISOString() };
      this.receipts[id] = r; this.save(); // Durable BEFORE the external write.
      try {
        const item = await backend.addQueuedSubmission!({ threadId: origin.threadId, prompt,
          clientUserMessageId: r.clientUserMessageId, ...handlers,
          onAccepted: turnId => this.update(r, { status: "running", turnId }) }, origin.hostId);
        this.update(r, { status: r.turnId ? "running" : "queued", queuedSubmissionId: item.id, reason: undefined });
      } catch (error) {
        this.update(r, { status: error instanceof CodexBackendCapabilityError || error instanceof CodexQueueAdmissionError ? "rejected" : "uncertain",
          reason: error instanceof CodexQueueAdmissionError ? error.message : error instanceof CodexBackendCapabilityError ? "后端不支持原生队列，消息未提交。" : "提交结果未确认，恢复时只核对，不自动重发。" });
        throw error;
      }
      return structuredClone(r);
    });
  }
  private async readObservation<T>(read: () => Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Native queue observation timed out; receipts preserved");
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Native queue observation timed out; receipts preserved")), remaining);
    })]); } finally { if (timer) clearTimeout(timer); }
  }
  private observationDeadline(): number { return Date.now() + (this.options.observationTimeoutMs ?? 3_000); }
  private async nativeItems(r: QueueOrigin, backend: CodexBridgeBackend, deadline = this.observationDeadline()): Promise<CodexQueuedSubmission[]> {
    if (!backend.listQueuedSubmissions) throw new CodexBackendCapabilityError("nativeQueue", backend.backendInfo(r.hostId).id);
    const items: CodexQueuedSubmission[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursors.size >= 100) throw new Error("Native queue observation page budget exceeded; receipts preserved");
      const page = await this.readObservation(() => backend.listQueuedSubmissions!(r.threadId, cursor, r.hostId), deadline);
      items.push(...page.data); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Native queue pagination repeated a cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return items;
  }
  reconcile(accountId: string, backend: CodexBridgeBackend, scope?: { conversationId: string }): Promise<void> {
    const key = JSON.stringify([accountId, scope?.conversationId]);
    const reads = this.reconciling.get(backend) ?? new Map<string, Promise<void>>();
    this.reconciling.set(backend, reads);
    const pending = reads.get(key); if (pending) return pending;
    const work = this.reconcileScope(accountId, backend, scope).finally(() => {
      if (reads.get(key) === work) reads.delete(key);
    });
    reads.set(key, work); return work;
  }
  private async reconcileScope(accountId: string, backend: CodexBridgeBackend, scope?: { conversationId: string }): Promise<void> {
    const groups = new Map<string, QueueReceipt[]>();
    for (const r of Object.values(this.receipts)) {
      if (r.accountId !== accountId || scope && r.conversationId !== scope.conversationId || !unsettled.has(r.status)) continue;
      const key = threadKey(r); groups.set(key, [...groups.get(key) ?? [], r]);
    }
    const results = await Promise.allSettled([...groups].map(([key, receipts]) => {
      // Observations never own the mutation lane. A delayed catalog/history
      // read must not block /queue or cancellation, nor overwrite a newer write.
      const versions = new Map(receipts.map(r => [r, JSON.stringify(r)]));
      const update = (r: QueueReceipt, changes: Partial<QueueReceipt>) => {
        if (JSON.stringify(r) !== versions.get(r)) return;
        this.update(r, changes); versions.set(r, JSON.stringify(r));
      };
      return (async () => {
      const deadline = this.observationDeadline();
      const origin = receipts[0];
      if (backend.backendInfo(origin.hostId).id !== origin.backend) return;
      const items = await this.nativeItems(origin, backend, deadline);
      const missing: QueueReceipt[] = [];
      for (const r of receipts) {
        if (this.dispatching.has(key) && (r.status === "starting" || r.status === "running")) continue;
        const item = items.find(x => x.clientUserMessageId === r.clientUserMessageId);
        if (item) update(r, { status: "queued", queuedSubmissionId: item.id, reason: undefined });
        else missing.push(r);
      }
      if (!missing.length) return;
      // Search history by server-supplied client ids, including older pages.
      // Missing queue entries may already have started: absence is NOT rejection.
      let cursor: string | undefined; const cursors = new Set<string>();
      do {
        if (cursors.size >= 100) throw new Error("History observation page budget exceeded; receipts preserved");
        const page = await this.readObservation(() => backend.getHistoryPage(origin.threadId, { cursor, limit: 100 }, origin.hostId), deadline);
        for (const r of missing.slice()) {
          const user = page.messages.find(m => m.role === "user"
            && (m.clientUserMessageId === r.clientUserMessageId || (r.turnId && m.turnId === r.turnId)));
          if (!user?.turnId) continue;
          // History locates identity only. A foreign unloaded reader can report
          // interrupted while the actual owner is still executing this turn.
          const observed = backend.readTurnLifecycle ? await this.readObservation(() => backend.readTurnLifecycle!(r.threadId, user.turnId!, r.hostId), deadline) : undefined;
          const confirmed = observed && observed.source !== "unknown" && observed.status !== "unknown";
          update(r, { turnId: user.turnId,
            status: confirmed ? observed.status === "inProgress" ? "running" : "completed" : "uncertain",
            ...(confirmed ? { lifecycleVersion: 2 as const } : {}),
            reason: confirmed ? undefined : "已定位原生轮次，执行终态仍待实际持有者或原生结束事件确认；未重发输入。" });
          missing.splice(missing.indexOf(r), 1);
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("History pagination repeated a cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor && missing.length);
      for (const r of missing) update(r, { status: "uncertain",
        reason: "原生队列和历史未能确认接收状态，未自动重发；请核对 Codex 历史。" });
    })().catch(error => {
      for (const r of receipts) if (!r.delivered) update(r, {
        reason: "无法读取原生队列或历史；回执已保留，未重发消息，等待后端恢复。"
      });
      throw error;
    }); }));
    rethrowFailures(results);
  }
  async dispatch(accountId: string, backend: CodexBridgeBackend, execute: (receipt: QueueReceipt,
    starting: () => void, started: (turnId: string) => void, item?: CodexQueuedSubmission) => Promise<void>): Promise<void> {
    const groups = new Map<string, QueueReceipt[]>();
    for (const r of Object.values(this.receipts)) {
      if (r.accountId !== accountId || !["queued", "running", "completed"].includes(r.status)
        || r.delivered || r.deliveryUnconfirmed || (!r.queuedSubmissionId && !r.turnId)) continue;
      const key = threadKey(r); groups.set(key, [...groups.get(key) ?? [], r]);
    }
    const results = await Promise.allSettled([...groups].map(async ([key, receipts]) => {
      if (this.dispatching.has(key)) return;
      this.dispatching.add(key);
      try {
        for (const r of receipts) {
        if (r.delivered || r.deliveryUnconfirmed) continue;
        if (backend.backendInfo(r.hostId).id !== r.backend) continue;
        const items = await this.nativeItems(r, backend);
        // Do not consume other writers' submissions or skip native FIFO order.
        const observing = Boolean(r.turnId);
        if (!observing && (items[0]?.id !== r.queuedSubmissionId || items[0]?.clientUserMessageId !== r.clientUserMessageId)) continue;
        const state = await backend.inspectThread(r.threadId, r.hostId);
        const terminalObservation = r.status === "completed" && observing;
        if (terminalObservation && (state.activeTurnId === r.turnId && state.runtimeStatus === "active" || r.lifecycleVersion !== 2)) continue;
        if (!terminalObservation && (state.executionOwner === "desktop" || (!observing && state.runtimeStatus === "active") || state.pendingTurnWithoutId
          || state.runtimeStatus === "unknown" || state.runtimeStatus === "systemError" || state.persistence !== "active")) continue;
        await execute(structuredClone(r), () => {
          if (r.status !== "queued") throw new Error("Queued receipt changed before dispatch");
          this.update(r, { status: "starting" });
        },
          turnId => this.update(r, { status: "running", turnId }), items.find(item => item.clientUserMessageId === r.clientUserMessageId));
        this.update(r, { status: "completed", delivered: true, reason: undefined });
        }
      } catch (error) {
        // A failure before queue/start leaves the native item pending. After
        // submission it is ambiguous; only reconciliation can decide its fate.
        for (const r of receipts) if (["starting", "running"].includes(r.status) && !r.delivered) this.update(r, {
          status: "uncertain", ...(r.turnId ? { deliveryUnconfirmed: true } : {}),
          reason: "队列执行或结果投递回执未确认；只核对原任务，不重复提交。结果可用 /history 查看。"
        });
        throw error;
      } finally { this.dispatching.delete(key); }
    }));
    rethrowFailures(results);
  }
  async cancel(accountId: string, conversationId: string, actorId: string, queueId: string,
    backend: CodexBridgeBackend, controller = false, assertCurrent?: () => void): Promise<boolean> {
    const r = Object.values(this.receipts).find(x => x.accountId === accountId
      && x.conversationId === conversationId && x.queuedSubmissionId === queueId && (controller || x.actorId === actorId));
    if (!r || !backend.deleteQueuedSubmission) throw new Error("这条队列记录不属于当前账号、聊天或用户。");
    return this.controls.run(threadKey(r), async () => {
      if (r.status !== "queued") throw new Error("该消息已开始或接收状态未确认，不能按待执行消息取消。");
      const items = await this.nativeItems(r, backend);
      if (!items.some(x => x.id === queueId && x.clientUserMessageId === r.clientUserMessageId)) return false;
      assertCurrent?.();
      const deleted = await backend.deleteQueuedSubmission!(r.threadId, queueId, r.hostId, assertCurrent);
      if (deleted) this.update(r, { status: "cancelled", reason: undefined });
      return deleted;
    });
  }
}

function rethrowFailures(results: PromiseSettledResult<unknown>[]): void {
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Native queue recovery failed for some threads; other threads were processed");
}
