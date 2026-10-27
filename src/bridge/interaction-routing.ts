import { writeJsonFile } from "../state/json-store.js";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "../state/json-store.js";
import type { ManagedSession } from "../state/runtime-state.js";
import { copyBlock } from "../channels/copyable.js";

/** Native interaction ownership is separate from multi-destination progress following. */
export type InteractionDestination = {
  accountId: string; sessionId: string; recipientId: string; hostId: string; threadId: string;
};
export type InteractionRouteStatus = {
  status: "primary" | "origin" | "unique" | "ambiguous" | "unavailable";
  bindingCount: number; current: boolean; destination?: InteractionDestination;
};
export type SessionInteractionPort = {
  status(session: ManagedSession): InteractionRouteStatus;
  setPrimary(session: ManagedSession): InteractionRouteStatus;
};
type NoticeReceipt = { state: "sending" | "delivered" | "unconfirmed"; attempts: number; at: number };
type Journal = { version: 1; primary: Record<string, { destination: InteractionDestination; explicit: boolean; inactive?: boolean }>;
  origins: Record<string, InteractionDestination>; routeNotices?: Record<string, number | NoticeReceipt>;
  unsupported?: Array<{ hostId: string; threadId: string; turnId: string; requestId: string | number;
    method: string; reason: string; delivered: boolean; at: number }> };
const scope = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId]);
const turnScope = (hostId: string, threadId: string, turnId: string) => JSON.stringify([hostId, threadId, turnId]);
const same = (a: InteractionDestination, b: InteractionDestination) =>
  a.accountId === b.accountId && a.sessionId === b.sessionId && a.recipientId === b.recipientId
  && a.hostId === b.hostId && a.threadId === b.threadId;

/** IDs only: never stores prompts, answers, credentials or provider payloads. */
export class InteractionRoutingJournal {
  private readonly state: Journal;
  constructor(private readonly filePath: string) {
    this.state = readJsonFile(filePath, { version: 1, primary: {}, origins: {} } as Journal);
    if (!this.state || this.state.version !== 1 || typeof this.state.primary !== "object" || !this.state.primary
      || typeof this.state.origins !== "object" || !this.state.origins
      || Array.isArray(this.state.primary) || Array.isArray(this.state.origins)) throw new Error("Invalid interaction routing journal");
  }
  setPrimary(destination: InteractionDestination): void {
    this.state.primary[scope(destination.hostId, destination.threadId)] = { destination: { ...destination }, explicit: true };
    this.save();
  }
  /** Reconcile only configured accounts, never transport availability. A
   * reconnect must not revoke ownership. Keep invalid owners as tombstones so
   * an outstanding request can never drift to another chat. */
  reconcileBindings(bindings: readonly InteractionDestination[], accountIds: readonly string[]): void {
    let changed = false;
    for (const primary of Object.values(this.state.primary)) {
      if (!accountIds.includes(primary.destination.accountId)) continue;
      const inactive = !bindings.some(binding => same(binding, primary.destination));
      if (inactive !== Boolean(primary.inactive)) { primary.inactive = inactive; changed = true; }
    }
    if (changed) this.save();
  }
  rememberTurn(destination: InteractionDestination, turnId: string): void {
    this.retainTurn(destination, turnId, true);
  }
  pinInteraction(destination: InteractionDestination, turnId: string): void {
    this.retainTurn(destination, turnId, false);
  }
  inheritTurn(hostId: string, threadId: string, fromTurnId: string, toTurnId: string): void {
    const destination = this.state.origins[turnScope(hostId, threadId, fromTurnId)];
    if (destination) this.retainTurn(destination, toTurnId, false);
  }
  private retainTurn(destination: InteractionDestination, turnId: string, promoteDefault: boolean): void {
    const key = turnScope(destination.hostId, destination.threadId, turnId);
    // A turn already owns its interaction destination. Primary changes affect
    // future App turns, not an already-delivered question or approval.
    this.state.origins[key] ??= { ...destination };
    const primaryKey = scope(destination.hostId, destination.threadId);
    if (!this.state.primary[primaryKey] || promoteDefault && (!this.state.primary[primaryKey].explicit || this.state.primary[primaryKey].inactive)) {
      this.state.primary[primaryKey] = { destination: { ...destination }, explicit: false };
    }
    while (Object.keys(this.state.origins).length > 2_000) delete this.state.origins[Object.keys(this.state.origins)[0]];
    this.save();
  }
  resolve(hostId: string, threadId: string, bindings: readonly InteractionDestination[], turnId?: string): InteractionRouteStatus {
    const candidates = bindings.filter(binding => binding.hostId === hostId && binding.threadId === threadId);
    const count = new Set(candidates.map(binding => JSON.stringify([binding.accountId, binding.recipientId]))).size;
    const origin = turnId ? this.state.origins[turnScope(hostId, threadId, turnId)] : undefined;
    const primary = this.state.primary[scope(hostId, threadId)]?.destination;
    const selected = origin ?? primary;
    if (selected) {
      const destination = candidates.find(binding => same(binding, selected));
      // Never silently redirect an interaction after its owner is unbound.
      return { status: destination ? origin ? "origin" : "primary" : "unavailable", bindingCount: count,
        current: false, ...(destination ? { destination: { ...destination } } : {}) };
    }
    return count === 1 ? { status: "unique", bindingCount: count, current: false, destination: { ...candidates[0] } }
      : { status: count ? "ambiguous" : "unavailable", bindingCount: count, current: false };
  }
  /** Bounded retries concern neutral configuration notices, NEVER questions,
   * answers or approval decisions. Legacy claims had no delivery receipt. */
  claimRouteNotice(destination: InteractionDestination, status: "ambiguous" | "unavailable"): boolean {
    const key = JSON.stringify([destination.accountId, destination.sessionId, destination.recipientId,
      destination.hostId, destination.threadId, status]);
    const notices = this.state.routeNotices ??= {};
    const prior = notices[key], now = Date.now();
    if (typeof prior === "object" && (prior.state === "delivered" || prior.attempts >= 3
      || now - prior.at < 60_000)) return false;
    notices[key] = { state: "sending", attempts: typeof prior === "object" ? prior.attempts + 1 : 1, at: now };
    while (Object.keys(notices).length > 1_000) delete notices[Object.keys(notices)[0]];
    this.save();
    return true;
  }
  reportRouteNotice(destination: InteractionDestination, status: "ambiguous" | "unavailable", delivered: boolean): void {
    const key = JSON.stringify([destination.accountId, destination.sessionId, destination.recipientId,
      destination.hostId, destination.threadId, status]);
    const receipt = this.state.routeNotices?.[key];
    if (receipt && typeof receipt === "object") { receipt.state = delivered ? "delivered" : "unconfirmed"; this.save(); }
  }
  recordUnsupported(input: { hostId: string; threadId: string; turnId: string; requestId: string | number; method: string; reason?: string }, delivered = false): void {
    const records = this.state.unsupported ??= [];
    const existing = records.find(r => r.hostId === input.hostId && r.threadId === input.threadId
      && r.turnId === input.turnId && r.requestId === input.requestId);
    if (existing) { existing.delivered ||= delivered; existing.at = Date.now(); }
    else records.push({ hostId: input.hostId, threadId: input.threadId, turnId: input.turnId, requestId: input.requestId,
      method: /^[A-Za-z0-9_\/-]{1,120}$/.test(input.method) ? input.method : "unknown",
      reason: ["authentication", "schema-unsupported"].includes(input.reason ?? "") ? input.reason! : "request-unsupported", delivered, at: Date.now() });
    this.state.unsupported = records.slice(-200); this.save();
  }
  diagnostics(): NonNullable<Journal["unsupported"]> { return structuredClone(this.state.unsupported ?? []); }
  private save(): void {
    writeJsonFile(this.filePath, this.state, { durable: true });
  }
}

export function formatInteractionRoute(status: InteractionRouteStatus): string {
  return status.destination
    ? `提问/审批路由：${status.current ? "当前对话" : `账号 ${status.destination.accountId} · 对话 ${status.destination.recipientId}`}（${status.status === "unique" ? "唯一绑定" : status.status === "origin" ? "原轮次发起方" : "持久化主交互对话"}）。`
    : `提问/审批路由：${status.status === "ambiguous" ? `${status.bindingCount} 个对话跟随，尚未选择主交互对话` : "原交互目标不可用"}。控制者可在希望接收交互的目标对话发送以下命令；不会改变其他跟随绑定。\n\n${copyBlock("/follow primary")}`;
}
