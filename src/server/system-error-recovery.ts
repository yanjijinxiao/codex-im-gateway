import { z } from "zod";
import type { CodexBridgeBackend, CodexThreadSnapshot, CodexThreadState } from "../codex/backend.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { codexFailureSummary } from "../codex/turn-failure.js";

export type SystemRecoveryScope = { hostId: string; threadId: string; turnId: string };
const recordSchema = z.object({
  hostId: z.string(), threadId: z.string(), turnId: z.string(), attempts: z.number().int().min(0).max(3),
  phase: z.enum(["recovering", "waiting", "recovered", "deferred", "unsupported", "failed", "cancelled"]),
  updatedAt: z.number().finite(), nextAt: z.number().finite(), message: z.string(),
});
export type SystemRecoveryStatus = z.infer<typeof recordSchema>;
type Options = {
  filePath: string;
  backend: () => CodexBridgeBackend;
  /** Capture an exact live binding lease; returning undefined prohibits mutation. */
  lease: (scope: SystemRecoveryScope) => (() => void) | undefined;
  blocked?: (scope: SystemRecoveryScope) => boolean;
  notice: (scope: SystemRecoveryScope, status: SystemRecoveryStatus, state?: CodexThreadState, assertSource?: () => void) => Promise<void>;
  now?: () => number;
  cooldownMs?: number;
  noticeTimeoutMs?: number;
};
const key = (s: SystemRecoveryScope) => JSON.stringify([s.hostId, s.threadId, s.turnId]);

/** A recovery ledger, never an input or execution queue. Only the native owner
 * may rehydrate its existing thread; an explicit native read proves recovery. */
export class SystemErrorRecoveryCoordinator {
  private records: Record<string, SystemRecoveryStatus>;
  private readonly pending = new Map<string, Promise<CodexThreadState | undefined>>();
  private readonly cancelled = new Set<string>();
  private readonly sourceTokens = new Map<string, object>();
  private stopped = false;
  private available = true;
  private readonly notifications = new Set<Promise<void>>();
  constructor(private readonly options: Options) {
    this.records = {};
    try {
      const records = z.record(z.string(), recordSchema).parse(readJsonFile(options.filePath, {}));
      if (Object.entries(records).some(([id, row]) => id !== key(row))) throw Error("Invalid system recovery identity");
      this.records = records;
    } catch {
      this.available = false;
      console.warn("[codex-im-gateway] system recovery ledger unavailable; feature disabled, original file preserved");
    }
  }
  status(scope: SystemRecoveryScope): SystemRecoveryStatus | undefined {
    const row = this.records[key(scope)]; return row && structuredClone(row);
  }
  offer(snapshot: CodexThreadSnapshot, hostId: string): void {
    const scope = this.scope(snapshot, hostId);
    const scopes = scope ? [scope] : Object.values(this.records).filter(row => row.hostId === hostId && row.threadId === snapshot.state.threadId
      && (["recovering", "waiting"].includes(row.phase)
        || ["failed", "deferred"].includes(row.phase) && snapshot.state.lastTurnFailure?.turnId === row.turnId));
    for (const target of scopes) void this.request(target).catch(() => console.warn("[codex-im-gateway] system recovery ledger unavailable; native inputs unchanged"));
  }
  private scope(snapshot: CodexThreadSnapshot, hostId: string): SystemRecoveryScope | undefined {
    const s = snapshot.state, failure = s.lastTurnFailure;
    if (s.persistence !== "active" || s.runtimeStatus !== "systemError" || s.internal || !failure
      || failure.code === "model-capacity") return;
    return { hostId, threadId: s.threadId, turnId: failure.turnId };
  }
  request(scope: SystemRecoveryScope, callerGuard?: () => void): Promise<CodexThreadState | undefined> {
    const id = key(scope), prior = this.pending.get(id);
    if (prior) return prior.then(state => { callerGuard?.(); return state; });
    if (!this.available || this.stopped || this.cancelled.has(id)) return Promise.resolve(undefined);
    const previous = this.records[id], now = this.now();
    const reconcileOnly = previous?.phase === "recovering";
    if (previous && !reconcileOnly && previous.nextAt > now)
      return Promise.resolve(undefined);
    const lease = this.options.lease(scope);
    if (!lease || this.options.blocked?.(scope)) return Promise.resolve(undefined);
    const sourceKey = JSON.stringify([scope.hostId, scope.threadId]), token = {};
    this.sourceTokens.set(sourceKey, token);
    // Eviction invalidates old leases rather than allowing an old value to
    // become current again. This also bounds notification-only ownership.
    if (this.sourceTokens.size > 1000) this.sourceTokens.delete(this.sourceTokens.keys().next().value!);
    const sourceGuard = () => {
      if (this.stopped || this.sourceTokens.get(sourceKey) !== token) throw Error("System recovery source changed");
      lease(); callerGuard?.();
    };
    const guard = () => {
      if (this.stopped || this.cancelled.has(id) || this.options.blocked?.(scope)) throw Error("System recovery source changed");
      sourceGuard();
    };
    const work = (reconcileOnly ? this.reconcile(scope, guard, sourceGuard) : this.recover(scope, guard, sourceGuard)).finally(() => { if (this.pending.get(id) === work) this.pending.delete(id); this.cancelled.delete(id); });
    this.pending.set(id, work); return work;
  }
  private async recover(scope: SystemRecoveryScope, guard: () => void, sourceGuard: () => void): Promise<CodexThreadState | undefined> {
    const backend = this.options.backend();
    guard();
    const previous = this.records[key(scope)];
    if (previous?.phase === "waiting") {
      this.save({ ...previous, updatedAt: this.now(), nextAt: this.now() + (this.options.cooldownMs ?? 60_000) });
      let snapshot: CodexThreadSnapshot | undefined;
      try { snapshot = await backend.readThreadSnapshot?.(scope.threadId, scope.hostId); }
      catch {
        guard();
        const message = "等待安全卸载期间暂时无法核对原生状态；保留原会话，继续只读检查，未重发消息。";
        if (previous.message !== message) {
          const waiting = { ...this.records[key(scope)], message };
          this.save(waiting); this.publish(waiting, undefined, sourceGuard);
        }
        return;
      }
      guard();
      if (snapshot && (snapshot.state.threadId !== scope.threadId || snapshot.state.persistence !== "active"
        || snapshot.state.lastTurnFailure?.turnId !== scope.turnId && !["idle", "active"].includes(snapshot.state.runtimeStatus))) {
        const cancelled = { ...previous, phase: "cancelled" as const, updatedAt: this.now(),
          message: "原生会话或失败轮次已改变，旧恢复检查已结束；未重载其他轮次。" };
        this.save(cancelled); this.publish(cancelled, undefined, sourceGuard); return;
      }
      if (snapshot?.state.runtimeStatus === "systemError") {
        return; // Read-only wait must not resume again and restart the idle-unload clock.
      }
    }
    const attempts = previous?.attempts === 3 ? 1 : (previous?.attempts ?? 0) + 1;
    const row: SystemRecoveryStatus = { ...scope, attempts, phase: "recovering", updatedAt: this.now(),
      nextAt: this.now() + (attempts === 3 ? 15 * 60_000 : this.options.cooldownMs ?? 60_000),
      message: "检测到 systemError，正在核对原生状态并尝试原会话重载；历史和绑定保留，旧消息未重发。" };
    this.save(row);
    this.publish(row, undefined, sourceGuard);
    let state: CodexThreadState | undefined;
    try {
      const before = await backend.readThreadSnapshot?.(scope.threadId, scope.hostId);
      guard();
      const s = before?.state;
      if (s?.threadId === scope.threadId && s.persistence === "active" && ["idle", "active"].includes(s.runtimeStatus)) {
        row.phase = "recovered"; row.message = "原生核对已确认系统状态恢复；旧消息未重发。";
        row.updatedAt = this.now(); this.save(row); this.publish(row, s, sourceGuard); return s;
      }
      const reloadUnloaded = s?.runtimeStatus === "notLoaded"
        && s.lastTurnFailure?.turnId === scope.turnId;
      if (!s || !reloadUnloaded && key(this.scope(before!, scope.hostId) ?? { hostId: "", threadId: "", turnId: "" }) !== key(scope)
        || s.activeTurnId || s.activeFlags.length || s.pendingTurnWithoutId || before!.turns.some(turn => turn.status === "inProgress")) {
        row.phase = "deferred"; row.message = "核对期间原生状态已改变或仍有待确认执行，恢复已暂缓；未重发消息。";
        row.updatedAt = this.now(); this.save(row); this.publish(row, undefined, sourceGuard); return;
      }
      row.message = `检测到 systemError：${codexFailureSummary(s.lastTurnFailure!.code)}\n正在原生重载同一会话；历史和绑定保留，旧消息未重发。`;
      this.save(row); this.publish(row, undefined, sourceGuard);
      const result = backend.recoverSystemError ? await backend.recoverSystemError({ threadId: scope.threadId,
        failedTurnId: scope.turnId, assertCurrent: guard }, scope.hostId) : { status: "unsupported" as const };
      guard();
      // Independently verify; a transport acknowledgement is not proof that
      // the owner cleared its failure, including adapters returning stale data.
      const observed = await backend.readThreadSnapshot?.(scope.threadId, scope.hostId);
      guard();
      const actual = observed?.state;
      const recovered = actual?.threadId === scope.threadId && actual.persistence === "active"
        && ["idle", "active"].includes(actual.runtimeStatus);
      if (recovered) {
        row.phase = "recovered"; state = actual;
        row.message = `原生已确认系统状态恢复为${actual!.runtimeStatus === "active" ? "运行中" : "空闲"}；原 session、历史和绑定保留，旧消息未重发。`;
      } else {
        row.phase = result.reason === "awaiting-unload" ? "waiting" : result.status === "recovered" ? "failed" : result.status;
        if (row.phase === "waiting") row.nextAt = this.now() + (this.options.cooldownMs ?? 60_000);
        if (row.phase === "unsupported") row.nextAt = this.now() + 60 * 60_000;
        row.message = row.phase === "waiting" ? "原生仍为 systemError，正在等待安全卸载后自动重载同一会话；不会中断其他任务或重发旧消息。"
          : row.phase === "unsupported" ? "当前原生执行者未提供可用的无执行重载接口；系统错误保留，未切换后端或重发消息。"
          : row.phase === "deferred" ? "恢复已暂缓：原生执行或提交状态仍需核对，未重发消息。"
          : "本次重载后尚未确认恢复；系统错误保留，将限次等待重试，未重发消息。";
      }
    } catch {
      row.phase = this.stopped || this.cancelled.has(key(scope)) ? "cancelled" : "failed";
      row.message = row.phase === "cancelled" ? "恢复期间来源或任务已改变，已停止本次恢复，交由当前会话处理。"
        : "恢复请求或状态核对未确认成功；保留原会话及错误，未重发消息。";
    }
    row.updatedAt = this.now(); this.save(row); this.publish(row, state, sourceGuard); return state;
  }
  private async reconcile(scope: SystemRecoveryScope, guard: () => void, sourceGuard: () => void): Promise<CodexThreadState | undefined> {
    const row = structuredClone(this.records[key(scope)]);
    let state: CodexThreadState | undefined;
    try {
      const snapshot = await this.options.backend().readThreadSnapshot?.(scope.threadId, scope.hostId);
      guard();
      const actual = snapshot?.state;
      if (actual?.threadId === scope.threadId && actual.persistence === "active" && ["idle", "active"].includes(actual.runtimeStatus)) {
        row.phase = "recovered"; state = actual;
        row.message = "重启后的原生状态核对已确认会话恢复；未重复重载或重发消息。";
      } else { row.phase = "failed"; row.message = "上次重载未能确认恢复，保留原错误并等待冷却重试；未重发消息。"; }
    } catch { row.phase = "failed"; row.message = "上次恢复的状态仍无法确认；保留会话，未重发消息。"; }
    row.updatedAt = this.now(); row.nextAt = Math.max(row.nextAt, this.now() + (this.options.cooldownMs ?? 60_000));
    this.save(row); this.publish(row, state, sourceGuard); return state;
  }
  private publish(row: SystemRecoveryStatus, state?: CodexThreadState, sourceGuard?: () => void): void {
    const work = this.notice(structuredClone(row), state, sourceGuard).finally(() => this.notifications.delete(work));
    this.notifications.add(work);
  }
  private async notice(row: SystemRecoveryStatus, state?: CodexThreadState, sourceGuard?: () => void): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try { sourceGuard?.(); await Promise.race([this.options.notice(row, structuredClone(row), state, sourceGuard), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("System recovery notice deadline")), this.options.noticeTimeoutMs ?? 5_000);
    })]); }
    catch { console.warn("[codex-im-gateway] system recovery progress unavailable; native state unchanged"); }
    finally { if (timer) clearTimeout(timer); }
  }
  private save(row: SystemRecoveryStatus): void {
    const next = { ...this.records, [key(row)]: structuredClone(row) };
    // Bounded terminal metadata; an in-flight operation is never evicted.
    const old = Object.entries(next).filter(([id, item]) => !this.pending.has(id) && !["recovering", "waiting"].includes(item.phase))
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    while (Object.keys(next).length > 1000 && old.length) delete next[old.shift()![0]];
    if (Object.keys(next).length > 1000) throw Error("System recovery metadata capacity exceeded");
    writeJsonFile(this.options.filePath, next, { durable: true }); this.records = next;
  }
  cancel(threadId: string, hostId = "local"): void {
    this.sourceTokens.delete(JSON.stringify([hostId, threadId]));
    for (const id of this.pending.keys()) { const [host, thread] = JSON.parse(id); if (thread === threadId && host === hostId) this.cancelled.add(id); }
  }
  hasInFlightWork(): boolean { return this.pending.size > 0; }
  async stop(): Promise<void> { this.stopped = true; await Promise.allSettled(this.pending.values()); await Promise.allSettled(this.notifications); }
  private now(): number { return (this.options.now ?? Date.now)(); }
}
