import crypto from "node:crypto";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { assertCapacityResume, CodexTurnExecutionError, type CodexThreadSnapshot, type CodexBridgeBackend, type CodexCapacityResumeInput } from "../codex/backend.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { codexRecoverySummary } from "../codex/turn-recovery.js";
import { userFacingMessageHandlingError } from "../bridge/errors.js";

export type CapacityFailure = { hostId: string; threadId: string; turnId: string };
type RecordState = CapacityFailure & {
  backend: string;
  turns: string[];
  attempts: number;
  status: "waiting" | "submitting" | "running" | "uncertain" | "finished" | "cancelled";
  nextAt: number;
  clientId?: string;
  acceptedTurnId?: string;
  cancelFuture?: boolean;
  retiredTurns?: string[];
  closedBy?: { turnId: string; status: string; at: number };
  previousClosure?: { turnId: string; status: string; at: number };
};
type Options = {
  filePath: string;
  backend: () => CodexBridgeBackend;
  eligible: (scope: CapacityFailure) => boolean;
  notice: (scope: CapacityFailure, text: string) => Promise<void>;
  accepted: (scope: CapacityFailure, turnId: string) => Promise<void>;
  progress: (scope: CapacityFailure, text: string) => Promise<void>;
  terminal: (scope: CapacityFailure, text: string, outcome?: "completed" | "failed" | "interrupted") => Promise<void>;
  handlers?: (scope: CapacityFailure) => Pick<CodexCapacityResumeInput, "onApproval" | "onApprovalResult" | "onUserInput" | "onUserInputResult">;
  delaysMs?: readonly number[];
  now?: () => number;
  reconcileTimeoutMs?: number;
  reconcileIntervalMs?: number;
};
const keyOf = (scope: CapacityFailure) => JSON.stringify([scope.hostId, scope.threadId]);
class CapacityObservationError extends Error {
  constructor(readonly code: "timeout" | "identity-mismatch") { super(`Capacity observation ${code}`); }
}

/** One execution coordinator per Gateway, not per IM binding. It owns the
 * explicit continuation policy; the follow hub remains a read-only observer.
 * Write-ahead claims are never replayed after an uncertain acknowledgement. */
export class CapacityRecoveryCoordinator {
  private readonly records: Record<string, RecordState>;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly executing = new Set<string>();
  private readonly checking = new Map<string, { previous: RecordState; scopes: Map<string, CapacityFailure> }>();
  private readonly settling = new Map<string, symbol>();
  private reconciliationTimer?: NodeJS.Timeout;
  private readonly delays: readonly number[];
  private readonly now: () => number;
  private stopped = false;
  private generation = 0;

  constructor(private readonly options: Options) {
    this.records = readJsonFile(options.filePath, { records: {} as Record<string, RecordState> }).records;
    this.delays = options.delaysMs ?? [10_000, 30_000, 120_000, 300_000];
    this.now = options.now ?? Date.now;
    for (const record of Object.values(this.records)) {
      if (record.status === "submitting" || record.status === "running") record.status = "uncertain";
      if (record.acceptedTurnId) record.turnId = record.acceptedTurnId;
    }
    this.save();
  }
  private save(): void { writeJsonFile(this.options.filePath, { records: this.records }); }
  private announce(scope: CapacityFailure, text: string): void {
    void this.options.notice(scope, text).catch(() => console.warn("[codex-im-gateway] capacity recovery notice unavailable"));
  }
  start(): void {
    this.stopped = false;
    if (!this.reconciliationTimer) {
      this.reconciliationTimer = setInterval(() => this.reconcileUncertain(), this.options.reconcileIntervalMs ?? 30_000);
      this.reconciliationTimer.unref();
    }
    this.reconcileUncertain();
    for (const record of Object.values(this.records)) {
      void (async () => {
        for (let i = 1; i < record.turns.length; i++) {
          await this.options.accepted({ ...record, turnId: record.turns[i - 1] }, record.turns[i]);
        }
        if (record.status === "uncertain") this.announce(record, "重启前的自动恢复接收或执行结果尚未确认。保留原卡并只读核对，不重复提交；可用 /status、/history 查看。");
      })().catch(() => console.warn("[codex-im-gateway] capacity recovery projection pending"));
      if (record.status === "waiting") this.schedule(record);
    }
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    for (const record of Object.values(this.records)) {
      if (record.status === "submitting" || record.status === "running") record.status = "uncertain";
    }
    this.save();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.checking.clear();
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = undefined;
    this.settling.clear();
  }
  holdsStart(scope: CapacityFailure): boolean {
    if (this.checking.get(keyOf(scope))?.scopes.has(scope.turnId)) return true;
    const record = this.records[keyOf(scope)];
    return Boolean(record && (record.status === "submitting" || record.acceptedTurnId === scope.turnId
      && record.turnId !== scope.turnId && record.status === "running"
      || record.turnId === scope.turnId && (record.status === "waiting" || record.status === "uncertain" && !record.acceptedTurnId)));
  }
  hasPending(threadId: string, hostId: string): boolean {
    const key = keyOf({ threadId, hostId, turnId: "" }), record = this.records[key];
    return this.checking.has(key) || Boolean(record && !["finished", "cancelled"].includes(record.status));
  }
  private cancelled(record: RecordState): boolean { return this.stopped || this.records[keyOf(record)] !== record || record.status === "cancelled"; }
  cancel(threadId: string, hostId = "local"): void {
    const key = keyOf({ threadId, hostId, turnId: "" });
    this.checking.delete(key);
    const record = this.records[key];
    if (!record || record.status === "finished" || record.status === "cancelled") return;
    if (record.acceptedTurnId && (record.status === "running" || record.status === "uncertain")) {
      // New user input cancels future retries, not observation/delivery of an
      // already accepted native execution (e.g. answering its question).
      record.cancelFuture = true; this.save(); return;
    }
    record.status = "cancelled"; this.save();
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  /** Called only for a confirmed native capacity failure. No historical scan
   * or arbitrary error string can authorize a write through this boundary. */
  offer(scope: CapacityFailure): boolean {
    if (this.stopped || !this.options.eligible(scope)) return false;
    const backend = this.options.backend(), backendId = backend.backendInfo(scope.hostId).id;
    if (backendId === "exec" || !backend.resumeAfterCapacity) return false;
    const key = keyOf(scope), previous = this.records[key];
    if (previous?.retiredTurns?.includes(scope.turnId)) return true;
    const checking = this.checking.get(key);
    if (checking) { checking.scopes.set(scope.turnId, { ...scope }); return true; }
    if (previous?.backend === backendId && previous.turns.includes(scope.turnId)) {
      if (previous.turnId !== scope.turnId) return true; // Superseded native failure, never a final result.
      if (previous.status === "finished" || previous.status === "cancelled") return false;
      if (previous.status === "uncertain" && previous.acceptedTurnId === scope.turnId && !this.executing.has(key)) {
        // The accepted identity is known and this NEW failed receipt proves
        // execution ended. This is not replaying the interrupted submission.
        previous.acceptedTurnId = undefined;
        return this.defer(previous);
      }
      return true;
    }
    if ((previous && ["submitting", "running"].includes(previous.status)) || this.executing.has(key)) return false;
    if (previous) {
      const check = { previous, scopes: new Map([[scope.turnId, { ...scope }]]) };
      this.checking.set(key, check);
      this.announce(scope, "所选模型容量不足，正在只读核对旧恢复轮次与当前失败轮次；尚未提交新的恢复任务。");
      void this.reconcile(key, check).catch(() => console.warn("[codex-im-gateway] capacity reconciliation presentation pending"));
      return true;
    }
    return this.begin(scope, backendId);
  }

  private begin(scope: CapacityFailure, backendId: string, previous?: RecordState): boolean {
    const key = keyOf(scope), timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    const record: RecordState = { ...scope, backend: backendId, turns: [scope.turnId], attempts: 0,
      status: "waiting", nextAt: this.now(), ...(previous ? {
        retiredTurns: [...new Set([...(previous.retiredTurns ?? []), ...previous.turns])].slice(-2000),
        ...(previous.closedBy ? { previousClosure: previous.closedBy } : {})
      } : {}) };
    this.records[key] = record;
    return this.defer(record);
  }

  private async snapshot(record: CapacityFailure): Promise<CodexThreadSnapshot> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const snapshot = await Promise.race([this.options.backend().readThreadSnapshot(record.threadId, record.hostId),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CapacityObservationError("timeout")), this.options.reconcileTimeoutMs ?? 25_000); })]);
      if (snapshot.state.threadId !== record.threadId || snapshot.state.internal) throw new CapacityObservationError("identity-mismatch");
      return snapshot;
    } finally { if (timer) clearTimeout(timer); }
  }
  private acceptedTurn(record: RecordState, snapshot: CodexThreadSnapshot) {
    const matches = record.acceptedTurnId
      ? snapshot.turns.filter(turn => turn.id === record.acceptedTurnId)
      : record.clientId ? snapshot.turns.filter(turn => turn.messages.some(message => message.role === "user" && message.clientUserMessageId === record.clientId)) : [];
    return matches.length === 1 ? matches[0] : undefined;
  }
  private terminal(turn: CodexThreadSnapshot["turns"][number] | undefined): boolean {
    return Boolean(turn && ["completed", "failed", "interrupted"].includes(turn.status));
  }
  /** A restart may retire a proved-ended chain, but cannot discover a new
   * failure from history and authorize execution by itself. */
  private reconcileUncertain(): void {
    if (this.stopped) return;
    for (const record of Object.values(this.records)) {
      const key = keyOf(record);
      // Native reconciliation is independent of card delivery. Coalesce slow
      // observations, and leave replacement/execution decisions to offer().
      if (record.status === "uncertain" && !this.settling.has(key) && !this.checking.has(key) && !this.executing.has(key)) {
        void this.settleKnownCompletion(record);
      }
    }
  }
  private async settleKnownCompletion(record: RecordState): Promise<void> {
    const generation = this.generation, key = keyOf(record), token = Symbol(), started = this.now();
    this.settling.set(key, token);
    try {
      const snapshot = await this.snapshot(record), accepted = this.acceptedTurn(record, snapshot);
      if (this.stopped || generation !== this.generation || this.records[key] !== record || this.checking.has(key)
        || this.executing.has(key) || record.status !== "uncertain") return;
      const reason = this.options.backend().backendInfo(record.hostId).id !== record.backend ? "backend-changed"
        : snapshot.state.persistence !== "active" ? "persistence-unconfirmed"
          : !["idle", "systemError"].includes(snapshot.state.runtimeStatus) || snapshot.state.activeFlags.length || snapshot.state.pendingTurnWithoutId ? "runtime-unconfirmed"
            : !this.terminal(accepted) ? "acceptance-unconfirmed" : undefined;
      if (reason) { this.reconciliationDiagnostic(record, "protected", reason); return; }
      if (!record.cancelFuture && snapshot.turns.at(-1)?.id === accepted!.id && snapshot.state.lastTurnFailure?.turnId === accepted!.id
        && snapshot.state.lastTurnFailure.code === "model-capacity") return;
      record.status = "finished"; record.closedBy = { turnId: accepted!.id, status: accepted!.status, at: this.now() }; this.save();
      this.reconciliationDiagnostic(record, "closed");
    } catch (error) {
      if (!this.stopped && generation === this.generation && this.records[key] === record) this.reconciliationDiagnostic(record, "protected",
        error instanceof CodexCommunicationError || error instanceof CapacityObservationError ? error.code : "observation-unavailable",
        { elapsedMs: this.now() - started, errorType: error instanceof Error
          && ["Error", "TypeError", "RangeError", "SyntaxError", "CodexCommunicationError"].includes(error.name) ? error.name : "unknown" });
    } finally {
      if (this.settling.get(key) === token) this.settling.delete(key);
    }
  }
  private reconciliationDiagnostic(record: RecordState, status: "closed" | "protected", reason?: string, detail?: { elapsedMs: number; errorType: string }): void {
    console.info(`[codex-im-gateway] capacity reconciliation ${JSON.stringify({ timestamp: new Date().toISOString(),
      hostId: record.hostId, threadId: record.threadId, turnId: record.turnId, status, ...(reason ? { reason } : {}), ...detail })}`);
  }
  private async reconcile(key: string, check: { previous: RecordState; scopes: Map<string, CapacityFailure> }): Promise<void> {
    const generation = this.generation, previous = check.previous;
    const current = () => !this.stopped && generation === this.generation && this.checking.get(key) === check
      && this.records[key] === previous && !this.executing.has(key);
    let scope = [...check.scopes.values()].at(-1)!;
    try {
      const snapshot = await this.snapshot(scope);
      if (!current()) return;
      const tail = snapshot.turns.at(-1), candidate = tail && check.scopes.get(tail.id);
      if (!candidate) throw Error("Observed capacity failure is no longer the current tail");
      scope = candidate;
      assertCapacityResume(snapshot, scope.turnId);
      if (snapshot.turns.some(turn => turn.status === "inProgress")) throw Error("Native history still contains an active turn");
      if (!this.options.eligible(scope) || this.options.backend().backendInfo(scope.hostId).id !== previous.backend) throw Error("Capacity route changed");
      if (previous.status === "uncertain") {
        const accepted = this.acceptedTurn(previous, snapshot);
        if (!this.terminal(accepted) || snapshot.turns.indexOf(accepted!) >= snapshot.turns.length - 1) throw Error("Old native acceptance is still uncertain");
        previous.closedBy = { turnId: accepted!.id, status: accepted!.status, at: this.now() };
      }
      this.checking.delete(key);
      this.begin(scope, previous.backend, previous);
    } catch {
      if (!current()) return;
      this.checking.delete(key);
      // A stale offered failure must not consume an already-authorized older
      // waiting plan. Its backend still rechecks the exact tail before writing.
      if (previous.status === "waiting" && this.options.eligible(previous)
        && this.options.backend().backendInfo(previous.hostId).id === previous.backend) this.schedule(previous);
      await this.options.terminal(scope, "上游报告所选模型当前容量不足。当前失败轮次或旧恢复的结束状态尚未核对清楚，未安排自动恢复；保留原记录，未重复提交任务。可用 /status、/history 查看。", "failed");
    } finally { if (this.checking.get(key) === check) this.checking.delete(key); }
  }

  private defer(record: RecordState): boolean {
    const delay = this.delays[record.attempts];
    if (record.cancelFuture || delay === undefined) { record.status = "finished"; this.save(); return false; }
    record.status = "waiting"; record.nextAt = this.now() + delay; this.save();
    this.announce(record, `所选模型容量不足。已安排第 ${record.attempts + 1}/${this.delays.length} 次自动恢复，等待约 ${Math.ceil(delay / 1000)} 秒后重新核对原会话。\n继续使用本卡；不会重新发送原问题或自动切换模型。`);
    this.schedule(record);
    return true;
  }
  private schedule(record: RecordState): void {
    const key = keyOf(record);
    if (this.stopped || this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.attempt(record).catch(() => console.warn("[codex-im-gateway] capacity recovery processing failed"));
    }, Math.max(0, record.nextAt - this.now()));
    timer.unref(); this.timers.set(key, timer);
  }
  private current(record: RecordState): void {
    if (this.stopped || this.records[keyOf(record)] !== record || record.status === "cancelled"
      || !this.options.eligible(record) || this.options.backend().backendInfo(record.hostId).id !== record.backend) {
      throw new Error("Capacity recovery cancelled or binding/backend changed");
    }
  }
  private async attempt(record: RecordState): Promise<void> {
    const key = keyOf(record);
    if (record.status !== "waiting" || this.executing.has(key) || this.checking.has(key)) return;
    this.executing.add(key);
    const generation = this.generation;
    let accepted: string | undefined;
    let executionFinished = false;
    try {
      this.current(record);
      record.attempts++; record.status = "submitting";
      record.clientId = `capacity-${crypto.randomUUID()}`; this.save(); // Before external write.
      const result = await this.options.backend().resumeAfterCapacity!({ hostId: record.hostId, threadId: record.threadId,
        ...this.options.handlers?.(record),
        failedTurnId: record.turnId, clientUserMessageId: record.clientId, assertCurrent: () => {
          if (generation !== this.generation) throw new Error("Recovery lifecycle changed");
          this.current(record);
        },
        onTurnStarted: async event => {
          if (generation !== this.generation || this.records[key] !== record) throw new Error("Recovery lifecycle changed after receipt");
          accepted = event.turnId;
          record.acceptedTurnId = event.turnId; record.turns.push(event.turnId);
          if (record.status !== "cancelled") record.status = "running";
          this.save();
          await this.options.accepted(record, event.turnId);
          record.turnId = event.turnId; this.save();
        },
        onProgress: text => generation === this.generation && this.records[key] === record ? this.options.progress(record, text) : undefined,
        onRecovery: event => generation === this.generation && this.records[key] === record ? this.options.notice(record, codexRecoverySummary(event)) : undefined
      });
      if (this.cancelled(record) || generation !== this.generation) return;
      record.status = "finished"; this.save();
      executionFinished = true;
      await this.options.terminal({ ...record, turnId: result.turnId! }, result.text, "completed");
    } catch (error) {
      if (this.cancelled(record) || generation !== this.generation) return;
      if (executionFinished) {
        console.warn("[codex-im-gateway] recovered turn result presentation pending; execution is complete");
        return; // Channel delivery failure never authorizes another execution.
      }
      if (accepted && error instanceof CodexTurnExecutionError && error.status === "failed" && error.failureCode === "model-capacity") {
        record.acceptedTurnId = undefined;
        if (this.defer(record)) return;
      } else if (accepted && !(error instanceof CodexTurnExecutionError)
        || error instanceof CodexCommunicationError && error.submission !== "not-submitted") {
        record.status = "uncertain"; this.save();
        this.announce(record, "自动恢复的接收或执行结果尚未确认，已停止继续提交。保留原卡并只读核对；可用 /status、/history 查看。");
        return;
      } else record.status = "finished";
      this.save();
      await this.options.terminal(record, error instanceof CodexTurnExecutionError
        ? `${record.attempts >= this.delays.length && error.failureCode === "model-capacity" ? `已达到 ${record.attempts} 次容量自动恢复上限。\n` : ""}${userFacingMessageHandlingError(error).replace(/^\[codex-im-gateway\]\s*/, "")}`
        : "容量自动恢复未继续执行：会话状态、原生队列或执行者条件已变化，或当前接口不可用。未重发原问题、未切换执行者；请查看 /status。",
        error instanceof CodexTurnExecutionError && error.status === "interrupted" ? "interrupted" : "failed");
    } finally { this.executing.delete(key); }
  }
}
