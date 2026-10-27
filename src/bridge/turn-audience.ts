import crypto from "node:crypto";
import { readJsonObjectFile, isJsonObject, writeJsonFile } from "../state/json-store.js";
import type { ChannelCompletedCard, ChannelMention, ChannelTextClient } from "../channels/types.js";
import { isDirectedMentionId } from "../channels/mentions.js";

/** Transport-confirmed identity, scoped to the binding that received the input.
 * No prompt, answer, phone number, credential or inferred display-name lookup. */
export type TurnParticipantOrigin = {
  bindingKey: string;
  conversationId: string;
  actorId: string;
  mention?: ChannelMention;
};
export type TurnAudienceScope = {
  bindingKey: string;
  conversationId: string;
  hostId: string;
  threadId: string;
  turnId: string;
};
type Participant = { actorId: string; mention?: ChannelMention; acceptedAt: number };
type Notice = { status: "pending" | "attempted" | "delivered" | "unconfirmed"; mentions: ChannelMention[]; messageId?: string;
  /** Freeze the presentation choice and source identity, but not the answer body. */
  completedCardId?: string };
type Audience = TurnAudienceScope & {
  participants: Participant[];
  /** Frozen at completion; every batch is attempted at most once, including after a crash. */
  notices?: Notice[];
  unavailable?: boolean;
};
const keyOf = (scope: TurnAudienceScope) => crypto.createHash("sha256").update(JSON.stringify([
  scope.bindingKey, scope.conversationId, scope.hostId, scope.threadId, scope.turnId
])).digest("hex");

/** A provenance/notification journal, never a task queue. It cannot submit input. */
export class TurnAudienceJournal {
  private readonly records: Record<string, Audience>;
  /** Local in-flight receipt observations, not durable input or execution work. */
  private readonly observations = new Map<string, number>();
  private readonly deferred = new Map<string, () => Promise<void>>();
  constructor(private readonly filePath: string) {
    const loaded = readJsonObjectFile(filePath, { records: {} as Record<string, Audience> });
    if (!isJsonObject(loaded.records) || Object.values(loaded.records).some(value => !isJsonObject(value)))
      throw new Error("Invalid turn audience journal; original file preserved");
    this.records = loaded.records;
  }
  private save(): void { writeJsonFile(this.filePath, { records: this.records }, { durable: true }); }

  correctionTargets(scope: TurnAudienceScope, originalMessageId: string): string[] {
    return (this.records[keyOf(scope)]?.notices ?? []).filter(n => n.status === "delivered"
      && n.completedCardId === originalMessageId && n.messageId).map(n => n.messageId!);
  }
  originalCorrectionCards(scope: TurnAudienceScope): string[] {
    return [...new Set((this.records[keyOf(scope)]?.notices ?? []).filter(n => n.status === "delivered"
      && n.completedCardId).map(n => n.completedCardId!))];
  }

  hold(scope: TurnAudienceScope): () => void {
    const key = keyOf(scope);
    this.observations.set(key, (this.observations.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const remaining = (this.observations.get(key) ?? 1) - 1;
      if (remaining) { this.observations.set(key, remaining); return; }
      this.observations.delete(key);
      const notify = this.deferred.get(key); this.deferred.delete(key);
      if (notify) void notify().catch(() => console.warn("[codex-im-gateway] deferred turn mention unavailable"));
    };
  }

  record(scope: TurnAudienceScope, origin: TurnParticipantOrigin, acceptedAt = Date.now()): void {
    if (scope.bindingKey !== origin.bindingKey || scope.conversationId !== origin.conversationId
      || !scope.threadId || !scope.turnId || !origin.actorId) return;
    const key = keyOf(scope);
    const record = this.records[key] ??= { ...scope, participants: [] };
    // An already attempted completion cannot acquire new recipients from late events.
    if (record.notices || record.unavailable) return;
    const existing = record.participants.find(item => item.actorId === origin.actorId);
    if (existing) {
      const at = Math.min(existing.acceptedAt, acceptedAt);
      if (at === existing.acceptedAt && (existing.mention || !origin.mention)) return;
      existing.acceptedAt = at;
      existing.mention ??= origin.mention && { ...origin.mention };
    } else record.participants.push({ actorId: origin.actorId, acceptedAt, ...(origin.mention ? { mention: { ...origin.mention } } : {}) });
    record.participants.sort((a, b) => a.acceptedAt - b.acceptedAt);
    this.save();
  }

  participants(scope: TurnAudienceScope): readonly Participant[] {
    return structuredClone(this.records[keyOf(scope)]?.participants ?? []);
  }

  /** One trusted roster for questions and completion, scoped to this binding.
   * Native questions do not identify a particular human answerer. */
  mentions(scope: TurnAudienceScope): ChannelMention[] {
    return this.participants(scope).flatMap(item => item.mention && isDirectedMentionId(item.mention.userId) ? [item.mention] : [])
      .filter((item, index, all) => all.findIndex(other => other.userId === item.userId) === index);
  }

  async notify(scope: TurnAudienceScope, client: ChannelTextClient, options: {
    isCurrent: () => boolean;
    contextToken?: string;
    completedCard?: ChannelCompletedCard;
    onTextDelivered?: (part: { messageId: string; text: string }) => void;
  }): Promise<void> {
    const key = keyOf(scope), record = this.records[key];
    if (!options.isCurrent()) return;
    if (this.observations.has(key)) {
      this.deferred.set(key, () => this.notify(scope, client, options)); return;
    }
    if (!record || record.unavailable) return;
    if (!record.notices) {
      const mentions = this.mentions(scope);
      if (!mentions.length || client.capabilities?.mentions !== "available" || !client.sendMentionNotification) {
        record.unavailable = true; this.save(); return;
      }
      const limit = client.capabilities.mentionBatchSize ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid mention batch size");
      const combine = mentions.length <= limit && client.capabilities.completionMentionCard === "available" && options.completedCard
        && (client.canCombineCompletionMentionCard?.({ completedCard: options.completedCard, mentions }) ?? true);
      record.notices = [];
      for (let index = 0; index < mentions.length; index += limit) {
        record.notices.push({ status: "pending", mentions: mentions.slice(index, index + limit),
          ...(combine && options.completedCard
            ? { completedCardId: options.completedCard.messageId } : {}) });
      }
      this.save();
    }
    for (const notice of record.notices) {
      if (!options.isCurrent()) break;
      if (notice.status !== "pending") continue;
      // A restart must not substitute another segment or silently downgrade a
      // planned result card to the former extra reminder. Wait for exact context.
      if (notice.completedCardId && (options.completedCard?.messageId !== notice.completedCardId
        || client.capabilities?.completionMentionCard !== "available")) continue;
      // Write ahead of the external send. A crash here is unknown, never a retry.
      notice.status = "attempted"; this.save();
      const text = notice.completedCardId ? options.completedCard!.text : "本轮最终答复已更新，请查看上方完整结果。";
      try {
        const receipt = await client.sendMentionNotification!({ toUserId: scope.conversationId, text,
          mentions: notice.mentions, contextToken: options.contextToken,
          ...(notice.completedCardId ? { completedCard: options.completedCard } : {}) });
        if (!receipt?.messageId?.trim()) throw new Error("Missing mention receipt");
        notice.status = "delivered"; notice.messageId = receipt.messageId; this.save();
      } catch {
        notice.status = "unconfirmed"; this.save();
        console.warn("[codex-im-gateway] turn mention receipt unconfirmed; notification not replayed");
      }
      if (notice.status === "delivered") {
        try { options.onTextDelivered?.({ messageId: notice.messageId!, text }); }
        catch { /* Observability cannot invalidate an acknowledged notification. */ }
      }
    }
    // Existing attempts (also interrupted writes) are never automatically resent.
  }
}
