import fs from "node:fs";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelMessage } from "../channels/message.js";
import { writeAtomicTextFile } from "../state/json-store.js";

type Receipt = {
  phase: "received" | "submitting" | "accepted" | "handled" | "unconfirmed";
  clientUserMessageId: string;
  conversationId?: string; actorId?: string;
  sessionId?: string; hostId?: string; threadId?: string; turnId?: string;
};
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
  constructor(private readonly filePath: string, legacyIds: readonly string[] = []) {
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
    const id = receipt.clientUserMessageId.slice("gateway-".length);
    const fd = fs.openSync(this.filePath, "r+");
    try {
      const body = Buffer.from(JSON.stringify({ id, receipt }) + "\n");
      let offset = 0, position = fs.fstatSync(fd).size;
      while (offset < body.length) {
        const written = fs.writeSync(fd, body, offset, body.length - offset, position + offset);
        if (!written) throw Error("Inbound receipt append incomplete");
        offset += written;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (++this.writes >= 1024) { this.writes = 0; if (fs.statSync(this.filePath).size > 1024 * 1024) this.compact(); }
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
      receipt.phase = "handled"; this.save(receipt);
    } catch (error) {
      if (receipt.phase === "submitting") { receipt.phase = "unconfirmed"; this.save(receipt); }
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
        Object.assign(receipt, scope); if (receipt.phase === "received") receipt.phase = "submitting"; this.save(receipt);
      },
      accepted: (threadId: string, turnId: string) => {
        Object.assign(receipt, { phase: "accepted", threadId, turnId }); this.save(receipt);
      }
    };
  }
  releasePreparation(messageId: string): void {
    const key = identity(messageId);
    if (!this.processing.has(key) && this.receipts[key]?.phase === "received") this.claimed.delete(key);
  }
  submitting(scope: Pick<Receipt, "sessionId" | "hostId" | "threadId"> = {}): void { this.capture()?.submitting(scope); }
  accepted(threadId: string, turnId: string): void { this.capture()?.accepted(threadId, turnId); }
  snapshot(): Readonly<Record<string, Receipt>> { return structuredClone(this.receipts); }
}
