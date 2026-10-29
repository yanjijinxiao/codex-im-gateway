import fs from "node:fs";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelMessage } from "../channels/message.js";
import { writeAtomicTextFile } from "../state/json-store.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { CodexBackendCapabilityError, CodexQueueAdmissionError } from "../codex/backend.js";

export type InboundReceipt = {
  phase: "received" | "submitting" | "accepted" | "handled" | "unconfirmed";
  clientUserMessageId: string;
  conversationId?: string; actorId?: string;
  sessionId?: string; hostId?: string; threadId?: string; turnId?: string;
  queuedSubmissionId?: string;
};
type Receipt = InboundReceipt;
const identity = (id: string) => crypto.createHash("sha256").update(id.trim()).digest("hex");

/** Source receipts only: no bodies, execution backlog, timers or automatic resubmission.
 * A redelivery may reclaim preparation after a crash, never an attempted mutation.
 * One account owner injects this instance into every submission entry point.
 */
export class InboundReceiptJournal {
  private readonly context = new AsyncLocalStorage<Receipt>();
  private readonly claimed = new Set<string>();
  private readonly processing = new Set<string>();
  private readonly receipts: Record<string, Receipt>;
  private writes = 0;
  private appendUnavailable = false;
  constructor(private readonly filePath: string, legacyIds: readonly string[] = [],
    private readonly options: { onAccepted?: (receipt: Readonly<InboundReceipt>) => void } = {}) {
    this.receipts = {};
    let raw: Buffer | undefined;
    try { raw = fs.readFileSync(filePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!raw) {
      for (const id of legacyIds) this.receipts[identity(id)] = { phase: "handled", clientUserMessageId: `gateway-${identity(id)}` };
      this.compact();
      return;
    }
    const end = raw.lastIndexOf(10) + 1;
    if (!end) throw Error("Invalid inbound receipt journal header");
    const lines = raw.subarray(0, end).toString("utf8").trimEnd().split("\n");
    if (JSON.parse(lines.shift()!).version !== 1) throw Error("Invalid inbound receipt journal version");
    for (const line of lines) {
      const { id, receipt } = JSON.parse(line);
      if (!/^[a-f0-9]{64}$/.test(id) || !receipt || receipt.clientUserMessageId !== `gateway-${id}`
        || !["received", "submitting", "accepted", "handled", "unconfirmed"].includes(receipt.phase)) throw Error("Invalid inbound receipt");
      this.receipts[id] = receipt;
    }
    // An incomplete last append cannot authorize a native write: submitting is
    // fsynced before dispatch. Earlier accepted/submitting evidence is retained.
    if (end < raw.length) {
      const fd = fs.openSync(filePath, "r+");
      try { fs.ftruncateSync(fd, end); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    // A code rollback may have handled newer messages using the old store.
    // Import only missing tombstones; never weaken an existing receipt phase.
    for (const messageId of legacyIds) {
      const id = identity(messageId);
      if (!this.receipts[id]) {
        const receipt: Receipt = { phase: "handled", clientUserMessageId: `gateway-${id}` };
        this.receipts[id] = receipt; this.save(receipt);
      }
    }
  }
  private compact(): void {
    const text = JSON.stringify({ version: 1 }) + "\n" + Object.entries(this.receipts)
      .map(([id, receipt]) => JSON.stringify({ id, receipt }) + "\n").join("");
    writeAtomicTextFile(this.filePath, text, { durable: true });
  }
  private save(receipt: Receipt): void {
    // Append only the changed fact; do not rewrite an ever-growing ID history
    // for every incoming message. No ID is evicted by message count.
    if (this.appendUnavailable) throw Error("Inbound receipt journal needs restart recovery; no further append attempted");
    const id = receipt.clientUserMessageId.slice("gateway-".length);
    const fd = fs.openSync(this.filePath, "r+");
    let position: number | undefined;
    try {
      position = fs.fstatSync(fd).size;
      const body = Buffer.from(JSON.stringify({ id, receipt }) + "\n");
      let offset = 0;
      while (offset < body.length) {
        const written = fs.writeSync(fd, body, offset, body.length - offset, position + offset);
        if (!written) throw Error("Inbound receipt append incomplete");
        offset += written;
      }
      fs.fsyncSync(fd);
    } catch (error) {
      // A failed append must not become a broken middle line when the next
      // message arrives. If repair fails, stop all appends until restart recovery.
      try { if (position !== undefined) { fs.ftruncateSync(fd, position); fs.fsyncSync(fd); } }
      catch { this.appendUnavailable = true; }
      throw error;
    } finally { fs.closeSync(fd); }
    if (++this.writes >= 1024) { this.writes = 0; if (fs.statSync(this.filePath).size > 1024 * 1024) this.compact(); }
  }
  private transition(receipt: Receipt, patch: Partial<Receipt>): void {
    const previous = structuredClone(receipt); Object.assign(receipt, patch);
    try { this.save(receipt); }
    catch (error) {
      for (const key of Object.keys(receipt)) delete (receipt as Record<string, unknown>)[key];
      Object.assign(receipt, previous); throw error;
    }
  }
  claim(message: Pick<ChannelMessage, "id" | "senderId" | "replyTargetId">): boolean {
    if (!message.id.trim()) return false;
    const key = identity(message.id), prior = this.receipts[key];
    if (this.claimed.has(key) || this.processing.has(key) || prior && prior.phase !== "received") return false;
    if (prior && (prior.actorId !== message.senderId || prior.conversationId !== (message.replyTargetId ?? message.senderId))) return false;
    this.receipts[key] ??= { phase: "received", clientUserMessageId: `gateway-${key}`,
      actorId: message.senderId, conversationId: message.replyTargetId ?? message.senderId };
    this.save(this.receipts[key]); // Failure prevents dispatch, rather than weakening deduplication.
    this.claimed.add(key);
    return true;
  }
  async handle(message: Pick<ChannelMessage, "id" | "senderId" | "replyTargetId">, action: () => Promise<void>): Promise<void> {
    const key = identity(message.id);
    if (this.processing.has(key)) return;
    if (!this.claimed.has(key) && !this.claim(message)) return;
    const receipt = this.receipts[key];
    if (receipt.actorId !== message.senderId || receipt.conversationId !== (message.replyTargetId ?? message.senderId)) {
      this.claimed.delete(key); throw Error("入站对话身份已改变，消息未提交。");
    }
    this.claimed.delete(key); this.processing.add(key);
    try {
      await this.context.run(receipt, action);
      this.transition(receipt, { phase: "handled" });
    } catch (error) {
      if (receipt.phase === "submitting") {
        this.transition(receipt, { phase: error instanceof CodexCommunicationError && error.submission === "not-submitted"
          || error instanceof CodexBackendCapabilityError || error instanceof CodexQueueAdmissionError ? "received" : "unconfirmed" });
      }
      throw error;
    } finally { this.processing.delete(key); }
  }
  currentId(): string | undefined { return this.context.getStore()?.clientUserMessageId; }
  /** Native RPC events may arrive outside the dispatch AsyncLocalStorage context. */
  capture() {
    const receipt = this.context.getStore();
    if (!receipt) return undefined;
    return {
      currentId: () => receipt.clientUserMessageId,
      submitting: (scope: Pick<Receipt, "sessionId" | "hostId" | "threadId">) => {
        this.transition(receipt, { ...scope, ...(receipt.phase === "received" ? { phase: "submitting" } : {}) });
      },
      accepted: (threadId: string, turnId: string) => {
        this.transition(receipt, { phase: "accepted", threadId, turnId });
        try { this.options.onAccepted?.(structuredClone(receipt)); }
        catch { console.warn("[codex-im-gateway] accepted input cleanup deferred; durable native receipt retained"); }
      }
    };
  }
  releasePreparation(messageId: string): void {
    const key = identity(messageId);
    if (!this.processing.has(key) && this.receipts[key]?.phase === "received") this.claimed.delete(key);
  }
  submitting(scope: Pick<Receipt, "sessionId" | "hostId" | "threadId"> = {}): void { this.capture()?.submitting(scope); }
  accepted(threadId: string, turnId: string): void { this.capture()?.accepted(threadId, turnId); }
  queued(threadId: string, queuedSubmissionId: string, turnId?: string): void {
    const receipt = this.context.getStore(); if (!receipt) return;
    this.transition(receipt, { phase: "accepted", threadId, queuedSubmissionId, ...(turnId ? { turnId } : {}) });
    try { this.options.onAccepted?.(structuredClone(receipt)); }
    catch { console.warn("[codex-im-gateway] queued input cleanup deferred; durable native receipt retained"); }
  }
  abandon(messageId: string): boolean {
    const key = identity(messageId), receipt = this.receipts[key];
    if (!receipt || receipt.phase !== "received" || this.processing.has(key)) return false;
    this.transition(receipt, { phase: "handled" });
    this.claimed.delete(key); return true;
  }
  snapshot(): Readonly<Record<string, Receipt>> { return structuredClone(this.receipts); }
  receipt(messageId: string): Readonly<Receipt> | undefined {
    const receipt = this.receipts[identity(messageId)]; return receipt && structuredClone(receipt);
  }
}
