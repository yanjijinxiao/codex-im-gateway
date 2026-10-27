import crypto from "node:crypto";
import { readJsonFile, isJsonObject as record, writeJsonFile } from "../state/json-store.js";
import type { CodexInputReceipt } from "../codex/backend.js";
import { CodexInterventionError } from "../codex/backend.js";
import type { PromptBufferItem } from "./prompt-buffer.js";
import type { AcceptedPresentationInput } from "./input-presentation.js";
import type { TurnParticipantOrigin } from "./turn-audience.js";
import { copyBlock } from "../channels/copyable.js";

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
type Receipt = { status: "sending" | "accepted" | "uncertain"; result?: CodexInputReceipt;
  origin?: TurnParticipantOrigin;
  presentation?: AcceptedPresentationInput };

/** Write-ahead receipts: an unknown transport outcome is never automatically resubmitted. */
export class SessionControlJournal {
  readonly queue = new SessionControlQueue();
  private state: { receipts: Record<string, Receipt>; choices: Record<string, PendingIntervention> };
  constructor(private readonly filePath: string) {
    const data = readJsonFile<unknown>(filePath, { receipts: {}, choices: {} });
    if (!record(data) || !record(data.receipts) || !record(data.choices)
      || Object.values(data.receipts).some(value => !record(value) || !["sending", "accepted", "uncertain"].includes(String(value.status)))
      || Object.values(data.choices).some(value => !record(value) || !["pending", "submitted", "cancelled"].includes(String(value.status))
        || typeof value.id !== "string" || typeof value.expiresAt !== "number"))
      throw new Error("Invalid session control journal; original file preserved");
    this.state = data as typeof this.state;
  }
  private save(): void { writeJsonFile(this.filePath, this.state, { durable: true }); }

  steer(key: string, messageId: string, action: () => Promise<CodexInputReceipt>, hostId?: string, origin?: TurnParticipantOrigin): Promise<CodexInputReceipt> {
    return this.submit(key, messageId, action, hostId, origin);
  }

  acceptedPresentationInputs(): AcceptedPresentationInput[] {
    return Object.values(this.state.receipts).flatMap(receipt => receipt.status === "accepted" && receipt.presentation
      && receipt.result?.threadId === receipt.presentation.threadId && receipt.result.turnId === receipt.presentation.turnId
      ? [receipt.presentation] : []);
  }

  async submit(key: string, messageId: string, action: () => Promise<CodexInputReceipt>, presentationHostId?: string, origin?: TurnParticipantOrigin): Promise<CodexInputReceipt> {
    const receiptId = crypto.createHash("sha256").update(JSON.stringify([key, messageId])).digest("hex");
    return this.queue.run(key, async () => {
      const receipt = this.state.receipts[receiptId];
      if (receipt?.status === "accepted" && receipt.result) return receipt.result;
      if (receipt) throw new CodexInterventionError(`该条消息已尝试提交，但结果尚未确认；请先核对历史，避免重复执行。\n\n${copyBlock("/history")}`);
      this.state.receipts[receiptId] = { status: "sending", ...(origin ? { origin } : {}) };
      this.save();
      try {
        const result = await action();
        this.state.receipts[receiptId] = { status: "accepted", result,
          ...(presentationHostId && key === JSON.stringify([presentationHostId, result.threadId])
            && result.status === "accepted" && result.turnId && result.threadId ? { presentation: {
            id: `steer:${receiptId}`, kind: "steer" as const, hostId: presentationHostId,
            threadId: result.threadId, turnId: result.turnId, acceptedAt: Date.now(), ...(origin ? { origin } : {})
          } } : {}) };
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
