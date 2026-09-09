import crypto from "node:crypto";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { CodexSteerResult } from "../codex/backend.js";
import { CodexInterventionError } from "../codex/backend.js";
import type { PromptBufferItem } from "./prompt-buffer.js";

/** Serializes controls for one host/thread, without blocking controls on a running turn. */
export class SessionControlQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.tails.set(key, current);
    try { return await current; }
    finally { if (this.tails.get(key) === current) this.tails.delete(key); }
  }
}

export type PendingIntervention = {
  id: string;
  actorId: string;
  conversationId: string;
  sessionId: string;
  threadId: string;
  hostId: string;
  turnId: string;
  prompt: string;
  items: PromptBufferItem[];
  expiresAt: number;
  status: "pending" | "submitted" | "cancelled";
};
type Receipt = { status: "sending" | "accepted" | "uncertain"; result?: CodexSteerResult };

/** Write-ahead receipts: an unknown transport outcome is never automatically resubmitted. */
export class SessionControlJournal {
  readonly queue = new SessionControlQueue();
  private state: { receipts: Record<string, Receipt>; choices: Record<string, PendingIntervention> };
  constructor(private readonly filePath: string) {
    this.state = readJsonFile(filePath, { receipts: {}, choices: {} });
  }
  private save(): void { writeJsonFile(this.filePath, this.state); }

  async steer(key: string, messageId: string, action: () => Promise<CodexSteerResult>): Promise<CodexSteerResult> {
    const receiptId = crypto.createHash("sha256").update(JSON.stringify([key, messageId])).digest("hex");
    return this.queue.run(key, async () => {
      const receipt = this.state.receipts[receiptId];
      if (receipt?.status === "accepted" && receipt.result) return receipt.result;
      if (receipt) throw new CodexInterventionError("该条介入消息已提交，但结果尚未确认；请查看 /history，避免重复执行。");
      this.state.receipts[receiptId] = { status: "sending" };
      this.save();
      try {
        const result = await action();
        this.state.receipts[receiptId] = { status: "accepted", result };
        this.save();
        return result;
      } catch (error) {
        this.state.receipts[receiptId] = { status: "uncertain" };
        this.save();
        throw error;
      }
    });
  }

  createChoice(input: Omit<PendingIntervention, "id" | "expiresAt" | "status">): PendingIntervention {
    const choice: PendingIntervention = {
      ...input, id: crypto.randomUUID(), status: "pending", expiresAt: Date.now() + 24 * 60 * 60_000
    };
    for (const [id, item] of Object.entries(this.state.choices)) {
      if (item.expiresAt < Date.now()) delete this.state.choices[id];
    }
    this.state.choices[choice.id] = choice;
    this.save();
    return choice;
  }

  claimChoice(id: string, actorId: string, conversationId: string, cancel: boolean): PendingIntervention {
    const item = this.state.choices[id];
    if (!item || item.actorId !== actorId || item.conversationId !== conversationId) {
      throw new CodexInterventionError("这条待处理消息不属于当前用户和聊天。");
    }
    if (item.status !== "pending" || item.expiresAt < Date.now()) {
      throw new CodexInterventionError("这条选择已处理或已过期，请勿重复提交。");
    }
    item.status = cancel ? "cancelled" : "submitted";
    this.save();
    return structuredClone(item);
  }
}
