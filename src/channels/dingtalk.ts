import crypto from "node:crypto";
import { turnStatusHeading } from "./turn-status.js";
import type { TurnActivity } from "./turn-status.js";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

import DingTalk from "@alicloud/dingtalk";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";
import {
  TOPIC_ROBOT,
  type DWClientDownStream,
  type RobotMessage
} from "dingtalk-stream";

import type { DingTalkAccount } from "../weixin/accounts.js";
import { sanitizeFileName } from "../weixin/media.js";
import type { ChannelMessage } from "./message.js";
import type { ChannelAdapter, ChannelClient, ChannelConnectionStatus, ChannelMonitorOptions, ChannelTextClient, ChannelReceipt, ChannelDeliveryPart, ChannelMediaInput, ChannelMentionInput } from "./types.js";
import type { ChannelActionCard } from "./action-card.js";
import { renderMarkdownTable, escapeTableMarkdown } from "./table.js";
import { ChannelCapabilityError, ChannelDeliveryError, ChannelPartialDeliveryError, ChannelProgressError, channelProgressError } from "./errors.js";
import { DingTalkFileClient, type DingTalkFileTarget, type DingTalkProactiveFileTarget } from "./dingtalk-files.js";
import { DiagnosticDingTalkStreamClient } from "./dingtalk-stream-diagnostics.js";
import { decodeDingTalkInbound } from "./dingtalk-inbound.js";
import { responseBytes } from "./inbound-bytes.js";
import { InboundMediaTooLargeError } from "./errors.js";
import { assertDingTalkCardMutationSucceeded, DingTalkCardMutationError } from "./dingtalk-card-response.js";
export { assertDingTalkCardMutationSucceeded } from "./dingtalk-card-response.js";
import { createChannelClient, TEXT_CAPABILITIES, NO_MEDIA } from "./client.js";
import type { ChannelStreamBootstrap, ChannelStreamFailure, ChannelStreamStartInput, ChannelStreamResumeInput } from "./stream-bootstrap.js";
import { DingTalkCardRouting } from "./dingtalk-card-routing.js";
import { dingTalkLoadingBody, dingTalkPlainText, normalizeDingTalkCardContent } from "./dingtalk-markdown.js";
// Keep the existing adapter export stable for embedders and transport tests.
export { normalizeDingTalkCardContent } from "./dingtalk-markdown.js";
import { dingTalkMentionCard, dingTalkCardAtParameters } from "./dingtalk-mentions.js";
import { DEFAULT_RESULT_PAGE_BYTES, resultPages } from "./result-pages.js";
import {
  PinnedNetworkLifecycleTransport,
  type NetworkFamilyPolicy
} from "./network-family.js";

type DingTalkStreamClient = {
  readonly connected?: boolean;
  connectionStatus?(): ChannelConnectionStatus;
  registerCallbackListener(topic: string, listener: (message: DWClientDownStream) => void): unknown;
  connect(): Promise<void>;
  disconnect(): void;
  getAccessToken(): Promise<unknown>;
  off(topic: string, listener: (message: DWClientDownStream) => void): unknown;
  socketCallBackResponse(messageId: string, result: unknown): void;
};

type DingTalkWebhookSender = (input: {
  url: string;
  text: string;
  accessToken: string;
  lifecycleId: string;
  atUserIds?: readonly string[];
}) => Promise<{ messageId?: string } | void>;

export type DingTalkAICardTarget =
  | { readonly type: "group"; readonly conversationId: string }
  | { readonly type: "user"; readonly staffId: string };

type DingTalkCardActivity = { activity?: TurnActivity };
export type DingTalkAICardCreateInput = DingTalkCardActivity & {
  /** One-shot replies/questions are static from their very first paint. */
  finalize?: boolean;
  accessToken: string;
  cardTemplateId: string;
  contentKey: string;
  outTrackId: string;
  robotCode: string;
  target: DingTalkAICardTarget;
  atUserIds?: Record<string, string>;
  text: string;
  lifecycleId?: string;
  onStage?: (stage: "created" | "delivery-pending" | "delivered") => void;
};
export type DingTalkAICardUpdateInput = DingTalkCardActivity & {
  /** A one-shot card uses only the static component, never opens a stream. */
  presentation?: "static";
  accessToken: string;
  contentKey: string;
  outTrackId: string;
  text: string;
  finalize: boolean;
  error: boolean;
};
export type DingTalkAICardClient = {
  create(input: DingTalkAICardCreateInput): Promise<void>;
  /** Reuses a created outTrackId; never calls createCard. */
  deliver?(input: { accessToken: string; outTrackId: string; robotCode: string; target: DingTalkAICardTarget; atUserIds?: Record<string, string> }): Promise<void>;
  update(input: DingTalkAICardUpdateInput): Promise<void>;
};

export type DingTalkEmotionClient = {
  reply(input: DingTalkEmotionInput): Promise<void>;
  recall(input: DingTalkEmotionInput): Promise<void>;
};

export type DingTalkEmotionInput = {
  readonly accessToken: string;
  readonly robotCode: string;
  readonly openMsgId: string;
  readonly openConversationId: string;
};

export type DingTalkInboundMediaClient = {
  download(input: {
    readonly accessToken: string;
    readonly robotCode: string;
    readonly downloadCode?: string;
    readonly downloadUrl?: string;
    readonly maxBytes: number;
    readonly lifecycleId?: string;
  }): Promise<{ readonly buffer: Buffer; readonly contentType?: string }>;
};

type DingTalkAdapterOptions = {
  readonly streamClient?: DingTalkStreamClient;
  readonly webhookSender?: DingTalkWebhookSender;
  readonly cardClient?: DingTalkAICardClient;
  readonly emotionClient?: DingTalkEmotionClient;
  readonly mediaClient?: DingTalkInboundMediaClient;
  readonly inboundDir?: string;
  readonly maxInboundBytes?: number;
  readonly now?: () => number;
  readonly apiTransport?: PinnedNetworkLifecycleTransport;
  readonly cardRouting?: DingTalkCardRouting;
};

type DingTalkRobotMessage = Omit<RobotMessage, "msgtype" | "text"> & {
  readonly msgtype: string;
  readonly text?: { readonly content?: unknown };
  readonly content?: unknown;
  readonly conversationTitle?: string;
};

type ReplyTarget = {
  readonly webhookUrl: string;
  readonly expiresAt?: number;
  readonly conversationId: string;
  readonly conversationType: string;
  readonly actorId: string;
  readonly staffId?: string;
  readonly robotCode: string;
  readonly messageId: string;
};

type CardTargetContext = {
  readonly conversationId: string;
  readonly conversationType: string;
  readonly actorId: string;
  readonly robotCode: string;
  readonly messageId?: string;
};

export class DingTalkChannelAdapter implements ChannelAdapter, ChannelTextClient {
  readonly client: ChannelClient;
  private readonly maxInboundBytes: number;
  private readonly streamClient: DingTalkStreamClient;
  private readonly webhookSender: DingTalkWebhookSender;
  private readonly cardClient: DingTalkAICardClient;
  private readonly emotionClient: DingTalkEmotionClient;
  private readonly mediaClient: DingTalkInboundMediaClient;
  private readonly fileClient: DingTalkFileClient;
  private readonly apiTransport: PinnedNetworkLifecycleTransport;
  private readonly inboundDir: string;
  private readonly now: () => number;
  private readonly replyTargets = new Map<string, ReplyTarget>();
  private readonly replyContext = new AsyncLocalStorage<ReplyTarget>();
  private readonly activeNetworkLifecycles = new Set<string>();
  private readonly cardRouting: DingTalkCardRouting;

  constructor(private readonly account: DingTalkAccount, options: DingTalkAdapterOptions = {}) {
    this.streamClient = options.streamClient ?? new DiagnosticDingTalkStreamClient(account.accountId, {
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      keepAlive: true
    });
    this.apiTransport = options.apiTransport
      ?? new PinnedNetworkLifecycleTransport(account.networkFamily ?? "auto");
    this.webhookSender = options.webhookSender
      ?? ((input) => sendSessionWebhook(this.apiTransport, input));
    this.cardClient = options.cardClient ?? new DingTalkHttpsAICardClient({ transport: this.apiTransport });
    this.emotionClient = options.emotionClient ?? new DingTalkRestEmotionClient(this.apiTransport);
    this.mediaClient = options.mediaClient ?? new DingTalkRestInboundMediaClient(this.apiTransport);
    this.inboundDir = options.inboundDir ?? path.join(process.cwd(), ".codex-im-gateway-inbound", account.accountId);
    this.cardRouting = options.cardRouting ?? new DingTalkCardRouting(account.clientId, options.inboundDir ? path.join(options.inboundDir, "card-routing.json") : undefined);
    this.maxInboundBytes = options.maxInboundBytes ?? 100 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.fileClient = new DingTalkFileClient(this.apiTransport, undefined, undefined, this.now);
    this.client = createChannelClient("dingtalk", {
      ...TEXT_CAPABILITIES, mentions: "available", mentionBatchSize: 50, actionCardMentions: "available",
      completionMentionCard: account.cardTemplateId?.trim() ? "available" : "not-configured",
      inbound: { ...NO_MEDIA, image: "available", file: "available" },
      outbound: { ...NO_MEDIA, file: "available" },
      tableLayout: account.cardTemplateId ? "markdown" : "list",
      progress: account.cardTemplateId ? "available" : "not-configured",
      turnStatusHeader: account.cardTemplateId ? "available" : "not-configured",
      resumableProgress: Boolean(account.cardTemplateId),
      streamBootstrapRecovery: !this.cardClient.deliver ? "not-implemented" : account.cardTemplateId ? "available" : "not-configured"
    }, this);
  }

  async sendText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    if (this.account.cardTemplateId) {
      try {
        return await this.createTextCard(this.cardTarget(input.toUserId), input.text, true);
      } catch (error) {
        if (error instanceof ChannelProgressError) throw error;
        console.warn(`[codex-im-gateway] DingTalk AI Card unavailable, falling back to text: ${errorDetail(error)}`);
      }
    }
    return this.sendWebhookText(input);
  }
  deliveryRouteStatus(recipientId: string): "available" | "unconfirmed" {
    try { this.cardTarget(recipientId); return "available"; } catch { return "unconfirmed"; }
  }
  conversationIdentity(recipientId: string) {
    const route = this.cardRouting.get(recipientId);
    return route ? { kind: route.type === "group" ? "group" as const : "direct" as const,
      ...(route.name ? { name: route.name } : {}) } : undefined;
  }

  async sendMedia(input: ChannelMediaInput): Promise<{ messageId: string }> {
    if (input.kind !== "file") throw new ChannelCapabilityError("dingtalk", `outbound.${input.kind}`, "not-implemented");
    // Do not infer private/group routing from a cid prefix or guess a staff ID.
    // Prefer replying to the incoming conversation over unsolicited OpenAPI sends.
    const inFlight = this.replyContext.getStore();
    const context = inFlight && (input.toUserId === inFlight.conversationId || input.toUserId === inFlight.actorId)
      ? inFlight : this.replyTargets.get(input.toUserId);
    if (!context) throw new Error("钉钉文件接收会话未知，请先向机器人发送一条消息");
    let proactiveTarget: DingTalkProactiveFileTarget | undefined;
    if (context.conversationType === "2") proactiveTarget = { type: "group", conversationId: context.conversationId };
    else if (context.conversationType === "1") {
      if (context.staffId) proactiveTarget = { type: "user", staffId: context.staffId };
    } else throw new Error("钉钉文件接收会话缺少有效类型或员工 ID，请检查机器人应用可见范围");
    const target: DingTalkFileTarget | undefined = context.expiresAt !== undefined
      ? { type: "session", webhookUrl: context.webhookUrl, expiresAt: context.expiresAt, proactiveTarget }
      : proactiveTarget;
    if (!target) throw new Error("钉钉文件接收会话缺少有效回复通道或员工 ID，请重新向机器人发一条消息");
    const borrowedLifecycle = this.activeNetworkLifecycles.has(context.messageId);
    const lifecycleId = borrowedLifecycle ? context.messageId : `dingtalk-file-${crypto.randomUUID()}`;
    try {
      return await this.fileClient.send({
        path: input.path, target, robotCode: context.robotCode, lifecycleId,
        getAccessToken: () => this.accessToken()
      });
    } finally {
      if (!borrowedLifecycle) this.apiTransport.close(lifecycleId);
    }
  }

  canCombineCompletionMentionCard(input: Parameters<NonNullable<ChannelTextClient["canCombineCompletionMentionCard"]>>[0]): boolean {
    const card = dingTalkMentionCard(input.completedCard.text, input.mentions);
    return Buffer.byteLength(normalizeDingTalkCardContent(card.text)) <= DEFAULT_RESULT_PAGE_BYTES;
  }

  async sendMentionNotification(input: ChannelMentionInput): Promise<{ messageId: string }> {
    const target = this.cardTarget(input.toUserId);
    if (target.conversationType !== "2") throw new ChannelCapabilityError("dingtalk", "mentions", "群聊定向提醒仅适用于已确认群聊");
    if (input.completedCard) {
      // Native @ needs creation whitelist + body anchors + delivery recipients.
      // Deliver the whole answer WITH its recipients first; only then retire
      // the acknowledged source card. Never re-deliver that original instance.
      const card = dingTalkMentionCard(input.completedCard.text, input.mentions);
      const receipt = await this.createTextCard(target, card.text, true, undefined, card.atUserIds);
      try {
        await this.updateTextStream({ toUserId: input.toUserId, messageId: input.completedCard.messageId,
          text: input.completedCard.summary, finalize: true });
      } catch {
        // The result/@ is acknowledged. A summary failure must neither resend
        // it nor invalidate the result. Leaving the original answer is safe.
        console.warn("[codex-im-gateway] completion mention card delivered; original summary update unavailable");
      }
      return receipt;
    }
    // @ is routing metadata, not a reason to discard the Markdown surface.
    // Select this before any write; uncertain card sends never fall back.
    if (this.account.cardTemplateId?.trim()) {
      const card = dingTalkMentionCard(input.text, input.mentions);
      return this.createTextCard(target, card.text, true, undefined, card.atUserIds);
    }
    const reply = this.replyTargets.get(input.toUserId);
    // Select before any external write. Never switch transports after an ambiguous send.
    if (reply && (reply.expiresAt === undefined || reply.expiresAt > this.now())) {
      return this.sendWebhookText({ ...input, text: `${input.mentions.map(item => `@${item.userId}`).join(" ")}\n${input.text}`,
        atUserIds: input.mentions.map(item => item.userId) });
    }
    // Persisted group routing permits a small completion notice after restart,
    // even when the ephemeral session webhook is gone. Do not duplicate the answer.
    const card = dingTalkMentionCard(input.text, input.mentions);
    return this.createTextCard(target, card.text, true, undefined, card.atUserIds);
  }

  /** Read-only table in the existing AI template; selection remains a slash command. */
  async sendActionCard(input: import("./types.js").ChannelActionCardInput): Promise<ChannelReceipt> {
    const { card } = input;
    if (input.mentions?.length) {
      // This template has no native choice controls: keep the complete Q/slash
      // instructions and native @ together. Only the first page notifies people.
      const parts: ChannelDeliveryPart[] = [];
      try {
        for (const page of resultPages(card.fallbackText, DEFAULT_RESULT_PAGE_BYTES - 1_024)) {
          const sent = parts.length ? await this.sendText({ toUserId: input.toUserId, text: page.text })
            : await this.sendMentionNotification({ toUserId: input.toUserId, text: page.text, mentions: input.mentions });
          parts.push({ messageId: sent.messageId, text: page.text });
        }
      } catch (error) { throw new ChannelPartialDeliveryError(parts, error); }
      return { messageId: parts.at(-1)!.messageId, parts };
    }
    if (card.table && this.account.cardTemplateId) {
      const text = [escapeTableMarkdown(card.title), card.body, renderMarkdownTable(card.table), card.note].filter(Boolean).join("\n\n");
      try {
        return await this.createTextCard(this.cardTarget(input.toUserId), text, true);
      } catch (error) {
        if (error instanceof ChannelProgressError) throw error;
        console.warn(`[codex-im-gateway] DingTalk table card unavailable, falling back to a compact list: ${errorDetail(error)}`);
      }
    }
    const parts: ChannelDeliveryPart[] = [];
    try {
      for (const page of resultPages(card.fallbackText, 1800)) {
        const result = await this.sendWebhookText({ toUserId: input.toUserId, text: page.text });
        parts.push({ messageId: result.messageId, text: page.text });
      }
    } catch (error) { throw new ChannelPartialDeliveryError(parts, error); }
    return { messageId: parts.at(-1)!.messageId, parts };
  }

  private async sendWebhookText(input: { toUserId: string; text: string; atUserIds?: readonly string[] }): Promise<{ messageId: string }> {
    const target = this.requireReplyTarget(input.toUserId);
    const accessToken = await this.accessToken();
    const lifecycleId = target.messageId || `dingtalk-webhook-${crypto.randomUUID()}`;
    const ownedLifecycle = !this.activeNetworkLifecycles.has(lifecycleId);
    try {
      const result = await this.webhookSender({
        url: target.webhookUrl,
        text: dingTalkPlainText(input.text),
        accessToken,
        lifecycleId,
        ...(input.atUserIds ? { atUserIds: input.atUserIds } : {})
      });
      if (typeof result?.messageId !== "string" || !result.messageId.trim()) throw new ChannelDeliveryError("dingtalk", "sendText");
      return { messageId: result.messageId };
    } finally {
      if (ownedLifecycle) this.apiTransport.close(lifecycleId);
    }
  }

  async sendProgressText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    return this.sendWebhookText(input);
  }

  async startTextStream(input: ChannelStreamStartInput): Promise<{ messageId: string }> { return this.bootstrapTextStream(input); }

  async resumeTextStream(input: ChannelStreamResumeInput): Promise<{ messageId: string }> {
    return this.bootstrapTextStream(input, input.bootstrap, input.confirmUncertainDelivery);
  }

  private async bootstrapTextStream(input: ChannelStreamStartInput, saved?: ChannelStreamBootstrap, confirmUncertainDelivery = false): Promise<{ messageId: string }> {
    const instanceId = input.streamId ?? `codex_bridge_${crypto.randomUUID().replaceAll("-", "")}`;
    if (saved && (saved.instanceId !== instanceId || saved.recipientId !== input.toUserId)) throw new ChannelCapabilityError("dingtalk", "streamRecovery", "identity mismatch");
    let state: ChannelStreamBootstrap = saved ? structuredClone(saved) : { version: 1, instanceId, recipientId: input.toUserId, stage: "create-rejected" };
    if (saved && (!["created", "delivery-rejected", "delivery-unconfirmed"].includes(saved.stage)
      || saved.stage === "delivery-unconfirmed" && !confirmUncertainDelivery)) throw new ChannelCapabilityError("dingtalk", "streamRecovery", "unconfirmed delivery requires explicit confirmation");
    const publish = (stage: ChannelStreamBootstrap["stage"], failure?: ChannelStreamFailure) => {
      state = { ...state, stage, ...(failure ? { failure } : {}) }; if (!failure) delete state.failure;
      if (stage === "delivered") state.messageId = instanceId; else delete state.messageId;
      input.onBootstrap?.(structuredClone(state));
    };
    let target: CardTargetContext;
    try {
      const data = state.adapterData;
      if (saved && data) {
        if (data.accountId !== this.account.accountId || data.clientId !== this.account.clientId
          || !["group", "user"].includes(data.type) || !data.targetId || !data.robotCode) throw new ChannelCapabilityError("dingtalk", "streamRecovery", "route mismatch");
        target = { conversationId: data.targetId, conversationType: data.type === "group" ? "2" : "1", actorId: data.targetId, robotCode: data.robotCode };
      } else target = this.cardTarget(input.toUserId);
    } catch (error) {
      const failure: ChannelStreamFailure = { operation: saved ? "deliver" : "create", code: "RouteUnconfirmed",
        uncertain: false, requestNotSent: true };
      publish(state.stage, failure);
      throw new ChannelProgressError(!saved, undefined, 5_000, error, false, failure);
    }
    state.adapterData = { accountId: this.account.accountId, clientId: this.account.clientId,
      type: target.conversationType === "2" ? "group" : "user", targetId: target.conversationType === "2" ? target.conversationId : target.actorId, robotCode: target.robotCode };
    const providerTarget: DingTalkAICardTarget = target.conversationType === "2"
      ? { type: "group", conversationId: target.conversationId } : { type: "user", staffId: target.actorId };
    let operation: ChannelStreamFailure["operation"] = saved ? "deliver" : "create";
    try {
      const accessToken = await this.accessToken();
      if (saved) {
        if (!this.cardClient.deliver) throw new ChannelCapabilityError("dingtalk", "streamRecovery", "not-implemented");
        publish("delivery-pending");
        await this.cardClient.deliver({ accessToken, outTrackId: instanceId, robotCode: target.robotCode, target: providerTarget });
        publish("delivered");
      } else {
        publish("create-pending");
        await this.cardClient.create({ accessToken, cardTemplateId: this.account.cardTemplateId!, contentKey: this.account.cardContentKey?.trim() || "content",
          outTrackId: instanceId, robotCode: target.robotCode, target: providerTarget, text: input.text,
          ...(input.activity ? { activity: input.activity } : {}),
          onStage: stage => { if (stage === "delivery-pending") operation = "deliver"; publish(stage); } });
        publish("delivered");
      }
      operation = "update";
      await this.cardClient.update({ accessToken, contentKey: this.account.cardContentKey?.trim() || "content", outTrackId: instanceId,
        text: input.text, finalize: false, error: false, ...(input.activity ? { activity: input.activity } : {}) });
      return { messageId: instanceId };
    } catch (error) {
      const failure = cardStreamFailure(error, operation);
      const stage = state.stage === "delivered" ? "delivered" : operation === "create"
        ? failure.uncertain ? "create-unconfirmed" : "create-rejected"
        : state.stage === "created" ? "created" : failure.uncertain ? "delivery-unconfirmed" : "delivery-rejected";
      publish(stage, failure);
      if (stage === "delivered") throw dingTalkProgressError(error, instanceId);
      throw new ChannelProgressError(false, undefined, undefined, error, false, failure);
    }
  }

  readonly resumableTextStream = true;

  async updateTextStream(input: {
    toUserId: string;
    messageId: string;
    text: string;
    finalize?: boolean;
    error?: boolean;
    activity?: TurnActivity;
  }): Promise<void> {
    if (!this.account.cardTemplateId) throw new Error("钉钉 AI Card 模板未配置");
    try {
      await this.cardClient.update({
        accessToken: await this.accessToken(),
        contentKey: this.account.cardContentKey?.trim() || "content",
        outTrackId: input.messageId,
        text: input.text,
        finalize: input.finalize ?? false,
        error: input.error ?? false,
        ...(input.activity ? { activity: input.activity } : {})
      });
    } catch (error) { throw dingTalkProgressError(error, input.messageId); }
  }

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    if (options.signal?.aborted) return;
    options.onStatus?.({ state: "connecting" });
    let callbackIdentityReported = false;
    const handle = (frame: DWClientDownStream) => {
      acknowledge(this.streamClient, frame);
      let body: DingTalkRobotMessage;
      try {
        body = JSON.parse(frame.data) as DingTalkRobotMessage;
      } catch (error) {
        console.warn(`[codex-im-gateway] ignored malformed DingTalk message: ${errorDetail(error)}`);
        return;
      }
      const actorId = body.senderStaffId?.trim() || body.senderId?.trim();
      const conversationId = body.conversationId?.trim();
      const webhookUrl = body.sessionWebhook?.trim();
      if (!actorId || !conversationId || !webhookUrl) return;

      let decoded: ReturnType<typeof decodeDingTalkInbound>;
      try { decoded = decodeDingTalkInbound(body as unknown as Record<string, unknown>); }
      catch { console.warn("[codex-im-gateway] rejected malformed or excessive DingTalk attachments"); return; }

      const expiresAt = normalizeExpiry(body.sessionWebhookExpiredTime);
      const replyTarget: ReplyTarget = {
        webhookUrl,
        conversationId,
        conversationType: body.conversationType,
        actorId,
        staffId: body.senderStaffId?.trim() || undefined,
        robotCode: body.robotCode?.trim() || this.account.clientId,
        messageId: body.msgId || frame.headers.messageId,
        ...(expiresAt !== undefined ? { expiresAt } : {})
      };
      this.replyTargets.set(conversationId, replyTarget);
      this.replyTargets.set(actorId, replyTarget);
      this.cardRouting.remember(conversationId, body.conversationType, body.senderStaffId?.trim(), replyTarget.robotCode,
        { conversationName: body.conversationTitle, actorName: body.senderNick });
      const message: ChannelMessage = {
        id: body.msgId || frame.headers.messageId,
        senderId: actorId,
        ...(body.conversationType === "2" && body.senderStaffId?.trim()
          ? { mention: { userId: body.senderStaffId.trim(), ...(typeof body.senderNick === "string" && body.senderNick.trim()
            ? { name: body.senderNick.trim().slice(0, 100) } : {}) } } : {}),
        replyTargetId: conversationId,
        ...(["1", "2"].includes(body.conversationType) ? { conversationKind: body.conversationType === "1" ? "direct" as const : "group" as const } : {}),
        text: dingTalkCommandText(body, decoded.text),
        ...(!decoded.supported ? { unsupportedMessageType: body.msgtype } : {}),
        attachments: decoded.attachments,
        references: decoded.references,
        raw: { channel: "dingtalk", event: body }
      };
      if (options.claimMessage && !options.claimMessage(message)) return;
      if (!callbackIdentityReported) {
        callbackIdentityReported = true;
        // Diagnose the wire value, not ReplyTarget's Client ID fallback. Never log
        // the complete callback: it contains message text and session credentials.
        console.info(`[codex-im-gateway] DingTalk callback identity ${JSON.stringify({
          accountId: this.account.accountId,
          source: "callback",
          robotCode: typeof body.robotCode === "string" ? body.robotCode : null
        })}`);
      }
      void this.replyContext.run(replyTarget, () => this.handleMessageWithEmotion(message, replyTarget, options));
    };

    this.streamClient.registerCallbackListener(TOPIC_ROBOT, handle);
    let healthTimer: NodeJS.Timeout | undefined;
    const stopped = waitForAbort(options.signal);
    try {
      if (options.signal?.aborted) return;
      let initialConnectComplete = false;
      let last: string | undefined;
      const report = () => {
        const status = this.streamClient.connectionStatus?.() ?? (!initialConnectComplete
          ? { state: "connecting" as const }
          : this.streamClient.connected === false
            ? { state: "error" as const, detail: "DingTalk Stream 已断开；无法确认 SDK 是否正在重连。" }
            : { state: "connected" as const });
        const key = JSON.stringify(status);
        if (last !== key) { last = key; options.onStatus?.(status); }
      };
      const connecting = this.streamClient.connect();
      report();
      healthTimer = setInterval(report, 5_000);
      healthTimer.unref();
      const result = await Promise.race([
        connecting.then(() => "connected" as const),
        stopped.promise.then(() => "stopped" as const)
      ]);
      if (result === "stopped") return;
      initialConnectComplete = true;
      report();
      await stopped.promise;
    } finally {
      stopped.dispose();
      if (healthTimer) clearInterval(healthTimer);
      this.streamClient.off(TOPIC_ROBOT, handle);
      this.streamClient.disconnect();
      options.onStatus?.({ state: "stopped" });
    }
  }

  private async handleMessageWithEmotion(
    message: ChannelMessage,
    target: ReplyTarget,
    options: ChannelMonitorOptions,
  ): Promise<void> {
    this.activeNetworkLifecycles.add(target.messageId);
    const thinking = this.sendThinkingEmotion("reply", target)
      .then(() => true)
      .catch((error) => {
        console.warn(`[codex-im-gateway] DingTalk thinking emotion unavailable: ${errorDetail(error)}`);
        return false;
    });
    try {
      // Download only after the application has checked actor/conversation ACL.
      await options.onMessage(message);
    } catch (error) {
      console.error(
        `[codex-im-gateway] DingTalk message handling failed for ${message.senderId}: ${errorDetail(error)}`
      );
      try {
        await options.onMessageError?.(error, message);
      } catch (reportError) {
        console.error(`[codex-im-gateway] failed to report DingTalk message error: ${errorDetail(reportError)}`);
      }
    } finally {
      if (await thinking) {
        await this.sendThinkingEmotion("recall", target).catch((error) => {
          console.warn(`[codex-im-gateway] DingTalk thinking emotion recall failed: ${errorDetail(error)}`);
        });
      }
      this.activeNetworkLifecycles.delete(target.messageId);
      this.apiTransport.close(target.messageId);
    }
  }

  async resolveAttachments(message: ChannelMessage): Promise<ChannelMessage["attachments"]> {
    const target = this.replyContext.getStore() ?? this.replyTargets.get(message.replyTargetId ?? message.senderId);
    if (!target) throw new Error("DingTalk attachment context unavailable");
    const supplied = message.attachments;
    if (supplied.length > 20) throw new Error("DingTalk message has too many attachments");
    const output: ChannelMessage["attachments"] = [];
    for (const [index, attachment] of supplied.entries()) {
      if (attachment.path) { output.push(attachment); continue; }
      try {
        const downloaded = await this.mediaClient.download({ accessToken: await this.accessToken(), robotCode: target.robotCode,
          downloadCode: typeof attachment.item.downloadCode === "string" ? attachment.item.downloadCode : undefined,
          downloadUrl: typeof attachment.item.downloadUrl === "string" ? attachment.item.downloadUrl : undefined,
          maxBytes: this.maxInboundBytes, lifecycleId: message.id });
        if (downloaded.buffer.length > this.maxInboundBytes) throw new InboundMediaTooLargeError(this.maxInboundBytes, downloaded.buffer.length);
        const label = attachment.kind === "image"
          ? `dingtalk-image-${index + 1}${dingTalkImageExtension(downloaded.buffer, downloaded.contentType)}`
          : sanitizeFileName(attachment.label) || `dingtalk-file-${index + 1}`;
        fs.mkdirSync(this.inboundDir, { recursive: true });
        const filePath = uniqueDingTalkInboundPath(this.inboundDir, message.id, label);
        fs.writeFileSync(filePath, downloaded.buffer, { flag: "wx", mode: 0o600 });
        output.push({ ...attachment, label, item: {}, path: filePath });
      } catch (error) {
        if (error instanceof InboundMediaTooLargeError) throw error;
        throw new Error(`DingTalk inbound ${attachment.kind} download failed; check attachment access and download-code validity`);
      }
    }
    return output;
  }

  private async sendThinkingEmotion(action: "reply" | "recall", target: ReplyTarget): Promise<void> {
    await this.emotionClient[action]({
      accessToken: await this.accessToken(),
      robotCode: target.robotCode,
      openMsgId: target.messageId,
      openConversationId: target.conversationId
    });
  }

  private requireReplyTarget(toUserId: string): ReplyTarget {
    const target = this.replyTargets.get(toUserId);
    if (!target) {
      throw new Error("钉钉会话尚未建立回复通道，请先在钉钉中向机器人发送一条消息");
    }
    if (target.expiresAt !== undefined && target.expiresAt <= this.now()) {
      this.replyTargets.delete(toUserId);
      throw new Error("钉钉会话回复通道已过期，请在钉钉中重新向机器人发送一条消息");
    }
    return target;
  }

  private async accessToken(): Promise<string> {
    const accessToken = await this.streamClient.getAccessToken();
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new Error("钉钉访问令牌获取失败");
    }
    return accessToken.trim();
  }

  private async createTextCard(
    target: CardTargetContext,
    text: string,
    finalize: boolean,
    streamId?: string,
    atUserIds?: Record<string, string>
  ): Promise<{ messageId: string }> {
    const cardTemplateId = this.account.cardTemplateId?.trim();
    if (!cardTemplateId) throw new Error("钉钉 AI Card 模板未配置");
    const outTrackId = streamId ?? `codex_bridge_${crypto.randomUUID().replaceAll("-", "")}`;
    const accessToken = await this.accessToken();
    const contentKey = this.account.cardContentKey?.trim() || "content";
    await this.cardClient.create({
      accessToken,
      cardTemplateId,
      contentKey,
      outTrackId,
      robotCode: target.robotCode,
      ...(atUserIds ? { atUserIds } : {}),
      text,
      finalize,
      target: target.conversationType === "2"
        ? { type: "group", conversationId: target.conversationId }
        : { type: "user", staffId: target.actorId },
      ...(target.messageId && this.activeNetworkLifecycles.has(target.messageId)
        ? { lifecycleId: target.messageId }
        : {})
    });
    try {
      await this.cardClient.update({ accessToken, contentKey, outTrackId, text, finalize, error: false,
        ...(finalize ? { presentation: "static" as const } : {}) });
    } catch (error) {
      // Creation/delivery succeeded: retry this card, never create its replacement.
      throw dingTalkProgressError(error, outTrackId);
    }
    return { messageId: outTrackId };
  }

  private cardTarget(toUserId: string): CardTargetContext {
    const established = this.replyTargets.get(toUserId);
    if (established) {
      if (established.conversationType === "1" && !established.staffId) throw new ChannelCapabilityError("dingtalk", "cardRoute", "单聊员工 ID 尚未确认");
      return established;
    }
    const route = this.cardRouting.get(toUserId.trim());
    if (!route) throw new ChannelCapabilityError("dingtalk", "cardRoute", "RouteUnconfirmed：请先向当前机器人发送消息确认群聊/单聊路由");
    return {
      conversationId: route.targetId,
      conversationType: route.type === "group" ? "2" : "1",
      actorId: route.targetId,
      robotCode: route.robotCode
    };
  }
}

function dingTalkProgressError(error: unknown, messageId: string): ChannelProgressError {
  // IP routing/allowlist state can recover during a turn. Only an acknowledged
  // card may be probed; actual permission/template failures remain permanent.
  if (/\bIpNotInWhiteList\b/i.test(errorDetail(error))) {
    return new ChannelProgressError(false, messageId, 30_000, error, true, cardStreamFailure(error, "update"));
  }
  const policy = channelProgressError(error, messageId);
  return new ChannelProgressError(policy.retryable, policy.messageId, policy.retryAfterMs, error, policy.recoveryProbe, cardStreamFailure(error, "update"));
}

function cardStreamFailure(error: unknown, operation: ChannelStreamFailure["operation"]): ChannelStreamFailure {
  let current = error;
  for (let i = 0; i < 5; i++) {
    if (current instanceof DingTalkCardMutationError) return { operation, code: current.code,
      httpStatus: current.statusCode, requestId: current.requestId, uncertain: current.uncertain };
    if (current instanceof Error && current.cause) current = current.cause; else break;
  }
  const record = current && typeof current === "object" ? current as { code?: unknown; statusCode?: unknown } : undefined;
  const code = typeof record?.code === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(record.code) ? record.code : "TransportUnconfirmed";
  const httpStatus = typeof record?.statusCode === "number" ? record.statusCode : undefined;
  return { operation, code, httpStatus, uncertain: httpStatus === undefined || httpStatus >= 500 };
}

function logCardFailure(error: unknown, operation: ChannelStreamFailure["operation"], instanceId?: string): void {
  console.warn(`[codex-im-gateway] DingTalk AI Card ${JSON.stringify({ timestamp: new Date().toISOString(),
    event: "operation_failed", outTrackId: instanceId, ...cardStreamFailure(error, operation) })}`);
}

type DingTalkCardSdkClient = Pick<
  InstanceType<typeof DingTalk.card_1_0.default>,
  "createCardWithOptions" | "deliverCardWithOptions" | "streamingUpdateWithOptions" | "updateCardWithOptions"
>;

type DingTalkFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

type DingTalkHttpsAICardClientOptions = {
  readonly transport?: PinnedNetworkLifecycleTransport;
  readonly networkFamily?: NetworkFamilyPolicy;
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Production AI Card transport. This mirrors DingTalk's documented HTTPS REST
 * requests (and OpenClaw's working connector) instead of relying on the
 * generated Node SDK, whose streaming operation currently declares HTTP.
 */
export class DingTalkHttpsAICardClient implements DingTalkAICardClient {
  private readonly updateChains = new Map<string, Promise<void>>();
  private readonly inputingCards = new Set<string>();
  private readonly cardLifecycles = new Map<string, { id: string; owned: boolean }>();
  private readonly streamGuids = new DingTalkStreamSequence();
  private readonly transport: PinnedNetworkLifecycleTransport;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    requestOrOptions: DingTalkFetch | DingTalkHttpsAICardClientOptions = {},
    legacyRetryDelaysMs: readonly number[] = [0, 300, 1_000],
    legacySleep: (milliseconds: number) => Promise<void> = delayMilliseconds
  ) {
    if (typeof requestOrOptions === "function") {
      this.transport = new PinnedNetworkLifecycleTransport(
        "ipv4",
        (_family, input, init) => requestOrOptions(input, init)
      );
      this.retryDelaysMs = legacyRetryDelaysMs;
      this.sleep = legacySleep;
      return;
    }
    this.transport = requestOrOptions.transport
      ?? new PinnedNetworkLifecycleTransport(requestOrOptions.networkFamily ?? "auto");
    this.retryDelaysMs = requestOrOptions.retryDelaysMs ?? [0, 300, 1_000];
    this.sleep = requestOrOptions.sleep ?? delayMilliseconds;
  }

  async create(input: DingTalkAICardCreateInput): Promise<void> {
    const mentionParameters = dingTalkCardAtParameters(input.target, input.atUserIds);
    const suppliedLifecycleId = input.lifecycleId?.trim();
    const lifecycle = { id: suppliedLifecycleId || input.outTrackId, owned: !suppliedLifecycleId };
    this.cardLifecycles.set(input.outTrackId, lifecycle);
    let operation: "create" | "deliver" = "create";
    try {
      await this.mutate(lifecycle.id, "create", "/v1.0/card/instances", "POST", input.accessToken, {
        cardTemplateId: input.cardTemplateId,
        outTrackId: input.outTrackId,
        ...mentionParameters,
        cardData: { cardParamMap: initialDingTalkCardData(input) },
        callbackType: "STREAM",
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true }
      });
      operation = "deliver";
      input.onStage?.("created");
      input.onStage?.("delivery-pending");
      await this.deliver(input);
      input.onStage?.("delivered");
      this.inputingCards.delete(input.outTrackId);
    } catch (error) {
      this.cardLifecycles.delete(input.outTrackId);
      if (lifecycle.owned) this.transport.close(lifecycle.id);
      // An uncertain POST must not trigger another card or an alternative send.
      // Updates of an acknowledged card are independently safe to retry.
      if (operation === "create" && error instanceof DingTalkCardMutationError && !error.uncertain) throw error;
      throw new ChannelProgressError(false, undefined, undefined, error);
    }
  }

  async deliver(input: { accessToken: string; outTrackId: string; robotCode: string; target: DingTalkAICardTarget; atUserIds?: Record<string, string> }): Promise<void> {
    dingTalkCardAtParameters(input.target, input.atUserIds);
    const lifecycle = this.cardLifecycles.get(input.outTrackId) ?? { id: input.outTrackId, owned: true };
    this.cardLifecycles.set(input.outTrackId, lifecycle);
    await this.mutate(lifecycle.id, "deliver", "/v1.0/card/instances/deliver", "POST", input.accessToken, {
      outTrackId: input.outTrackId, userIdType: 1,
      ...(input.target.type === "group" ? { openSpaceId: `dtv1.card//IM_GROUP.${input.target.conversationId}`,
        imGroupOpenDeliverModel: { robotCode: input.robotCode, ...(input.atUserIds ? { atUserIds: input.atUserIds } : {}) } } : {
        openSpaceId: `dtv1.card//IM_ROBOT.${input.target.staffId}`,
        imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode: input.robotCode, extension: { dynamicSummary: "true" } }
      })
    });
  }

  async update(input: DingTalkAICardUpdateInput): Promise<void> {
    const lifecycle = this.cardLifecycles.get(input.outTrackId)
      ?? { id: input.outTrackId, owned: true };
    this.cardLifecycles.set(input.outTrackId, lifecycle);
    const previous = this.updateChains.get(input.outTrackId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.updateWithRetry(input, lifecycle.id));
    this.updateChains.set(input.outTrackId, current);
    try {
      await current;
      if (input.finalize) {
        this.cardLifecycles.delete(input.outTrackId);
        if (lifecycle.owned) this.transport.close(lifecycle.id);
      }
    } finally {
      if (this.updateChains.get(input.outTrackId) === current) this.updateChains.delete(input.outTrackId);
    }
  }

  private async updateWithRetry(input: DingTalkAICardUpdateInput, lifecycleId: string): Promise<void> {
    const content = visibleDingTalkTerminalContent(input);
    if (content.length > 50_000) throw new Error("DingTalk card payload requires pagination");
    if (input.presentation === "static") {
      if (!input.finalize) throw new Error("Static DingTalk card cannot represent active work");
      await this.updateCardState(lifecycleId, input, content, "3", true);
      this.inputingCards.delete(input.outTrackId); return;
    }
    const firstUpdate = !this.inputingCards.has(input.outTrackId);
    if (!input.finalize && !nativeDingTalkLoading(input)) {
      // Select the static body without finalizing the logical task or its
      // stream. A later running frame reselects input mode on this SAME card.
      await this.updateCardState(lifecycleId, input, content, "3", true);
      this.inputingCards.delete(input.outTrackId);
      return;
    }
    // One writer owns the active body. Re-entering input mode patches only
    // template controls, never the content key already owned by streaming.
    // Rewriting both resets native Markdown widgets (notably fenced commands).
    if (firstUpdate) await this.updateCardState(lifecycleId, input, content, "2", true, true);
    this.inputingCards.add(input.outTrackId);
    const streamBody = dingTalkCardStreamingUpdateBody({
      outTrackId: input.outTrackId,
      contentKey: input.contentKey,
      text: input.finalize ? content : content.replace(/\n+$/, ""),
      finalize: input.finalize,
      // Successful content generation is distinct from a failed Codex task.
      // The template's native failed-stream branch hides its supplied body.
      error: false,
      guid: this.streamGuids.next()
    });
    await this.mutateWithRetry(lifecycleId, "stream", "/v1.0/card/streaming", input.accessToken, streamBody);
    console.log(
      `[codex-im-gateway] DingTalk AI Card HTTPS streamed finalize=${input.finalize} `
      + `error=${input.error} outTrackId=${input.outTrackId} ${cardContentDiagnostic(content)}`
    );
    if (input.finalize) {
      await this.updateCardState(lifecycleId, input, content, "3", true);
      this.inputingCards.delete(input.outTrackId);
    }
  }

  private async updateCardState(
    lifecycleId: string,
    input: { accessToken: string; contentKey: string; outTrackId: string },
    content: string,
    flowStatus: "2" | "3" | "5",
    updateByKey: boolean,
    modeOnly = false
  ): Promise<void> {
    await this.mutateWithRetry(lifecycleId, "state", "/v1.0/card/instances", input.accessToken, {
      outTrackId: input.outTrackId,
      cardData: {
        cardParamMap: modeOnly ? dingTalkCardInputModeParamMap(input.contentKey) : dingTalkCardStateParamMap({
          contentKey: input.contentKey,
          text: content,
          flowStatus
        })
      },
      ...(updateByKey ? { cardUpdateOptions: { updateCardDataByKey: true } } : {})
    });
    console.log(
      `[codex-im-gateway] DingTalk AI Card HTTPS state updated flowStatus=${flowStatus} `
      + `outTrackId=${input.outTrackId}`
    );
  }

  private async mutateWithRetry(
    lifecycleId: string,
    operation: "stream" | "state",
    pathname: string,
    accessToken: string,
    body: unknown
  ): Promise<void> {
    let lastError: unknown;
    for (const [attempt, retryDelay] of this.retryDelaysMs.entries()) {
      if (retryDelay > 0) await this.sleep(retryDelay);
      try {
        await this.mutate(lifecycleId, operation, pathname, "PUT", accessToken, body);
        return;
      } catch (error) {
        lastError = error;
        const detail = errorDetail(error);
        const outTrackId = (body as { outTrackId?: unknown })?.outTrackId;
        console.warn(`[codex-im-gateway] DingTalk AI Card ${JSON.stringify({
          timestamp: new Date().toISOString(), event: "update_failed", operation,
          ...(typeof outTrackId === "string" ? { outTrackId } : {}), attempt: attempt + 1,
          httpStatus: Number(detail.match(/HTTP\s+(\d{3})/i)?.[1]) || undefined,
          code: detail.match(/\bcode=([A-Za-z0-9_.-]{1,100})(?=[,）\s]|$)/)?.[1],
          requestId: detail.match(/\brequestId=([A-Za-z0-9_-]{1,100})(?=[,）\s]|$)/)?.[1]
        })}`);
        // Permanent rejections are handled once by the common lifecycle. A
        // bounded recovery probe must not amplify into three immediate 403s.
        if (!channelProgressError(error).retryable) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorDetail(lastError));
  }

  private async mutate(
    lifecycleId: string,
    operation: "create" | "deliver" | "stream" | "state",
    pathname: string,
    method: "POST" | "PUT",
    accessToken: string,
    body: unknown
  ): Promise<void> {
    try {
    const response = await this.transport.request(lifecycleId, `https://api.dingtalk.com${pathname}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken
      },
      body: JSON.stringify(body)
    });
    const result: unknown = await response.json().catch(() => undefined);
    assertDingTalkCardMutationSucceeded(operation, {
      statusCode: response.status, headers: Object.fromEntries(response.headers), body: result
    });
    console.log(`[codex-im-gateway] DingTalk AI Card ${JSON.stringify({
      timestamp: new Date().toISOString(), event: "api_acknowledged", operation,
      outTrackId: (body as { outTrackId?: string }).outTrackId, httpStatus: response.status,
      requestId: safeCardRequestId(response.headers.get("x-acs-request-id"))
    })}`);
    } catch (error) { logCardFailure(error, operation === "stream" || operation === "state" ? "update" : operation,
      (body as { outTrackId?: string }).outTrackId); throw error; }
  }
}

export class DingTalkSdkAICardClient implements DingTalkAICardClient {
  private readonly client: DingTalkCardSdkClient;
  private readonly runtime = new RuntimeOptions({ connectTimeout: 30_000, readTimeout: 30_000 });
  private readonly updateChains = new Map<string, Promise<void>>();
  private readonly inputingCards = new Set<string>();
  private readonly streamGuids = new DingTalkStreamSequence();

  constructor(
    client?: DingTalkCardSdkClient,
    private readonly retryDelaysMs: readonly number[] = [0, 300, 1_000],
    private readonly sleep: (milliseconds: number) => Promise<void> = delayMilliseconds
  ) {
    this.client = client ?? new DingTalk.card_1_0.default(new OpenApiConfig({
      protocol: "https",
      regionId: "central"
    }));
  }

  async create(input: DingTalkAICardCreateInput): Promise<void> {
    const mentionParameters = dingTalkCardAtParameters(input.target, input.atUserIds);
    let operation: "create" | "deliver" = "create";
    try {
      const createRequest = new DingTalk.card_1_0.CreateCardRequest({
        cardTemplateId: input.cardTemplateId,
        outTrackId: input.outTrackId,
        ...mentionParameters,
        cardData: new DingTalk.card_1_0.CreateCardRequestCardData({
          cardParamMap: initialDingTalkCardData(input)
        }),
        callbackType: "STREAM",
        imGroupOpenSpaceModel: new DingTalk.card_1_0.CreateCardRequestImGroupOpenSpaceModel({
          supportForward: true
        }),
        imRobotOpenSpaceModel: new DingTalk.card_1_0.CreateCardRequestImRobotOpenSpaceModel({
          supportForward: true
        })
      });
      const createHeaders = new DingTalk.card_1_0.CreateCardHeaders({
        xAcsDingtalkAccessToken: input.accessToken
      });
      const createResponse = await this.client.createCardWithOptions(createRequest, createHeaders, this.runtime);
      assertDingTalkCardMutationSucceeded("create", createResponse);
      operation = "deliver";
      input.onStage?.("created");
      input.onStage?.("delivery-pending");
      await this.deliver(input);
      input.onStage?.("delivered");
      this.inputingCards.delete(input.outTrackId);
    } catch (error) {
      logCardFailure(error, operation, input.outTrackId);
      if (operation === "create" && error instanceof DingTalkCardMutationError && !error.uncertain) throw error;
      throw new ChannelProgressError(false, undefined, undefined, error);
    }
  }

  async deliver(input: { accessToken: string; outTrackId: string; robotCode: string; target: DingTalkAICardTarget; atUserIds?: Record<string, string> }): Promise<void> {
      dingTalkCardAtParameters(input.target, input.atUserIds);
      const deliverRequest = new DingTalk.card_1_0.DeliverCardRequest({
        outTrackId: input.outTrackId,
        userIdType: 1,
        ...(input.target.type === "group" ? {
          openSpaceId: `dtv1.card//IM_GROUP.${input.target.conversationId}`,
          imGroupOpenDeliverModel: new DingTalk.card_1_0.DeliverCardRequestImGroupOpenDeliverModel({
            robotCode: input.robotCode, ...(input.atUserIds ? { atUserIds: input.atUserIds } : {})
          })
        } : {
          openSpaceId: `dtv1.card//IM_ROBOT.${input.target.staffId}`,
          imRobotOpenDeliverModel: new DingTalk.card_1_0.DeliverCardRequestImRobotOpenDeliverModel({
            spaceType: "IM_ROBOT", robotCode: input.robotCode, extension: { dynamicSummary: "true" }
          })
        })
      });
      const deliverHeaders = new DingTalk.card_1_0.DeliverCardHeaders({
        xAcsDingtalkAccessToken: input.accessToken
      });
      const deliverResponse = await this.client.deliverCardWithOptions(deliverRequest, deliverHeaders, this.runtime);
      assertDingTalkCardMutationSucceeded("deliver", deliverResponse);
  }

  async update(input: DingTalkAICardUpdateInput): Promise<void> {
    const previous = this.updateChains.get(input.outTrackId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.updateWithRetry(input));
    this.updateChains.set(input.outTrackId, current);
    try {
      await current;
    } finally {
      if (this.updateChains.get(input.outTrackId) === current) {
        this.updateChains.delete(input.outTrackId);
      }
    }
  }

  private async updateWithRetry(input: DingTalkAICardUpdateInput): Promise<void> {
    const content = visibleDingTalkTerminalContent(input);
    if (content.length > 50_000) throw new Error("DingTalk card payload requires pagination");
    if (input.presentation === "static") {
      if (!input.finalize) throw new Error("Static DingTalk card cannot represent active work");
      await this.updateCardStateWithRetry(input, content, "3", true);
      this.inputingCards.delete(input.outTrackId); return;
    }
    const firstUpdate = !this.inputingCards.has(input.outTrackId);
    if (!input.finalize && !nativeDingTalkLoading(input)) {
      await this.updateCardStateWithRetry(input, content, "3", true);
      this.inputingCards.delete(input.outTrackId);
      return;
    }
    if (firstUpdate) await this.updateCardStateWithRetry(input, content, "2", true, true);
    this.inputingCards.add(input.outTrackId);
    const guid = this.streamGuids.next();
    let lastError: unknown;
    for (const [attempt, retryDelay] of this.retryDelaysMs.entries()) {
      if (retryDelay > 0) await this.sleep(retryDelay);
      const request = new DingTalk.card_1_0.StreamingUpdateRequest(dingTalkCardStreamingUpdateBody({
        outTrackId: input.outTrackId,
        contentKey: input.contentKey,
        text: content,
        finalize: input.finalize,
        error: false,
        guid
      }));
      const headers = new DingTalk.card_1_0.StreamingUpdateHeaders({
        xAcsDingtalkAccessToken: input.accessToken
      });
      try {
        const response = await this.client.streamingUpdateWithOptions(request, headers, this.runtime);
        assertDingTalkCardMutationSucceeded("stream", response);
        console.log(
          `[codex-im-gateway] DingTalk AI Card streamed attempt=${attempt + 1} `
          + `finalize=${input.finalize} error=${input.error} outTrackId=${input.outTrackId} guid=${guid} `
          + cardContentDiagnostic(content)
        );
        if (input.finalize) {
          await this.updateCardStateWithRetry(input, content, "3", true);
          this.inputingCards.delete(input.outTrackId);
        }
        return;
      } catch (error) {
        lastError = error;
        if (!channelProgressError(error).retryable) throw error;
        if (attempt + 1 < this.retryDelaysMs.length) {
          console.warn(
            `[codex-im-gateway] DingTalk AI Card stream attempt ${attempt + 1} failed; retrying: `
            + safeCardSdkError(error)
          );
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorDetail(lastError));
  }

  private async updateCardStateWithRetry(
    input: {
      accessToken: string;
      contentKey: string;
      outTrackId: string;
    },
    content: string,
    flowStatus: "2" | "3" | "5",
    updateByKey: boolean,
    modeOnly = false
  ): Promise<void> {
    let lastError: unknown;
    for (const [attempt, retryDelay] of this.retryDelaysMs.entries()) {
      if (retryDelay > 0) await this.sleep(retryDelay);
      const request = new DingTalk.card_1_0.UpdateCardRequest({
        outTrackId: input.outTrackId,
        cardData: new DingTalk.card_1_0.UpdateCardRequestCardData({
          cardParamMap: modeOnly ? dingTalkCardInputModeParamMap(input.contentKey) : dingTalkCardStateParamMap({
            contentKey: input.contentKey,
            text: content,
            flowStatus
          })
        }),
        ...(updateByKey ? {
          cardUpdateOptions: new DingTalk.card_1_0.UpdateCardRequestCardUpdateOptions({
            updateCardDataByKey: true
          })
        } : {})
      });
      const headers = new DingTalk.card_1_0.UpdateCardHeaders({
        xAcsDingtalkAccessToken: input.accessToken
      });
      try {
        const response = await this.client.updateCardWithOptions(request, headers, this.runtime);
        assertDingTalkCardMutationSucceeded("state", response);
        console.log(
          `[codex-im-gateway] DingTalk AI Card state updated attempt=${attempt + 1} `
          + `flowStatus=${flowStatus} outTrackId=${input.outTrackId}`
        );
        return;
      } catch (error) {
        lastError = error;
        if (!channelProgressError(error).retryable) throw error;
        if (attempt + 1 < this.retryDelaysMs.length) {
          console.warn(
            `[codex-im-gateway] DingTalk AI Card state attempt ${attempt + 1} failed; retrying: `
            + safeCardSdkError(error)
          );
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorDetail(lastError));
  }

}

/** Same ordering and retry identity for HTTPS and SDK transports. */
class DingTalkStreamSequence {
  private lastStreamGuidTimestamp = 0;
  private streamGuidSequence = 0;
  next(): string {
    const timestamp = Math.max(Date.now(), this.lastStreamGuidTimestamp);
    if (timestamp === this.lastStreamGuidTimestamp) {
      this.streamGuidSequence += 1;
    } else {
      this.lastStreamGuidTimestamp = timestamp;
      this.streamGuidSequence = 0;
    }
    return `${timestamp}_${this.streamGuidSequence.toString(36).padStart(10, "0")}`;
  }
}

function visibleDingTalkTerminalContent(input: { text: string; finalize: boolean; error: boolean } & DingTalkCardActivity): string {
  const hasFailureHeading = ["failed", "interrupted"].some(status => input.text.startsWith(turnStatusHeading(status as "failed" | "interrupted")));
  const text = input.finalize && input.error && !hasFailureHeading ? `❌ **处理失败**\n\n${input.text}` : input.text;
  return normalizeDingTalkCardContent(!input.finalize && nativeDingTalkLoading(input) ? dingTalkLoadingBody(text) : text);
}

/** Legacy non-task stream callers retain their existing input presentation. */
function nativeDingTalkLoading(input: DingTalkCardActivity): boolean {
  return input.activity === undefined || input.activity === "running" || input.activity === "recovering";
}

function initialDingTalkCardData(input: { contentKey: string; text: string; finalize?: boolean } & DingTalkCardActivity): Record<string, string> {
  const text = normalizeDingTalkCardContent(!input.finalize && nativeDingTalkLoading(input) ? dingTalkLoadingBody(input.text) : input.text);
  if (!text.trim()) throw new Error("DingTalk card initial content must not be empty");
  if (text.length > 50_000) throw new Error("DingTalk card payload requires pagination");
  // Publish a populated first frame, not an empty template awaiting a second request.
  return dingTalkCardStateParamMap({ contentKey: input.contentKey, text, flowStatus: input.finalize || !nativeDingTalkLoading(input) ? "3" : "2" });
}

export function dingTalkCardStateParamMap(input: {
  contentKey: string;
  text: string;
  flowStatus: "2" | "3" | "5";
}): Record<string, string> {
  return {
    flowStatus: input.flowStatus,
    [input.contentKey]: input.flowStatus === "2" ? input.text : "",
    staticMsgContent: input.flowStatus === "2" ? "" : input.text,
    sys_full_json_obj: JSON.stringify({ order: [input.flowStatus === "2" ? input.contentKey : "staticMsgContent"] }),
    config: JSON.stringify({ autoLayout: true })
  };
}

/** Input-mode control plane. No body means no second Markdown body writer. */
function dingTalkCardInputModeParamMap(contentKey: string): Record<string, string> {
  const { [contentKey]: _body, ...mode } = dingTalkCardStateParamMap({ contentKey, text: "", flowStatus: "2" });
  return mode;
}

export function dingTalkCardStreamingUpdateBody(input: {
  outTrackId: string;
  contentKey: string;
  text: string;
  finalize: boolean;
  error: boolean;
  guid: string;
}): {
  outTrackId: string;
  guid: string;
  key: string;
  content: string;
  isFull: true;
  isFinalize: boolean;
  isError: boolean;
} {
  return {
    outTrackId: input.outTrackId,
    guid: input.guid,
    key: input.contentKey,
    content: input.text,
    isFull: true,
    isFinalize: input.finalize,
    isError: input.error
  };
}

function cardContentDiagnostic(value: string): string {
  return `contentBytes=${Buffer.byteLength(value)} contentSha256=${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function safeCardRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
}

function safeCardSdkError(error: unknown): string {
  return error instanceof DingTalkCardMutationError ? error.message : "SDK transport error (raw response withheld)";
}

function delayMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class DingTalkRestEmotionClient implements DingTalkEmotionClient {
  constructor(private readonly transport: PinnedNetworkLifecycleTransport) {}

  async reply(input: DingTalkEmotionInput): Promise<void> {
    await sendDingTalkEmotionRequest(this.transport, "/v1.0/robot/emotion/reply", input);
  }

  async recall(input: DingTalkEmotionInput): Promise<void> {
    await sendDingTalkEmotionRequest(this.transport, "/v1.0/robot/emotion/recall", input);
  }
}

class DingTalkRestInboundMediaClient implements DingTalkInboundMediaClient {
  constructor(private readonly transport: PinnedNetworkLifecycleTransport) {}

  async download(input: {
    accessToken: string;
    robotCode: string;
    downloadCode?: string;
    downloadUrl?: string;
    maxBytes: number;
    lifecycleId?: string;
  }): Promise<{ buffer: Buffer; contentType?: string }> {
    const suppliedLifecycleId = input.lifecycleId?.trim();
    const lifecycleId = suppliedLifecycleId
      || `dingtalk-media-${crypto.randomUUID()}`;
    try {
      return await this.downloadInLifecycle(lifecycleId, input);
    } finally {
      if (!suppliedLifecycleId) this.transport.close(lifecycleId);
    }
  }

  private async downloadInLifecycle(
    lifecycleId: string,
    input: {
      accessToken: string;
      robotCode: string;
      downloadCode?: string;
      downloadUrl?: string;
      maxBytes: number;
    }
  ): Promise<{ buffer: Buffer; contentType?: string }> {
    let downloadUrl = input.downloadUrl?.trim();
    if (!downloadUrl) {
      const downloadCode = input.downloadCode?.trim();
      if (!downloadCode) throw new Error("钉钉附件缺少下载凭据");
      const response = await this.transport.request(lifecycleId, "https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": input.accessToken
        },
        body: JSON.stringify({ downloadCode, robotCode: input.robotCode })
      });
      const result = await response.json().catch(() => undefined) as {
        downloadUrl?: unknown;
        message?: unknown;
      } | undefined;
      if (!response.ok) {
        const detail = typeof result?.message === "string" && result.message
          ? result.message
          : `HTTP ${response.status}`;
        throw new Error(`钉钉图片下载地址请求失败：${detail}`);
      }
      downloadUrl = typeof result?.downloadUrl === "string" ? result.downloadUrl.trim() : "";
      if (!downloadUrl) throw new Error("钉钉图片下载地址响应缺少 downloadUrl");
    }

    const parsedUrl = normalizeDingTalkDownloadUrl(downloadUrl, Boolean(input.downloadCode && !input.downloadUrl));
    const response = await this.transport.request(lifecycleId, parsedUrl);
    if (!response.ok) throw new Error(`钉钉图片文件下载失败：HTTP ${response.status}`);
    const buffer = await responseBytes(response, input.maxBytes);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    return { buffer, ...(contentType ? { contentType } : {}) };
  }
}

export function normalizeDingTalkDownloadUrl(raw: string, allowOfficialHttpUpgrade: boolean): URL {
  const normalized = raw.startsWith("//") ? `https:${raw}` : raw;
  const parsedUrl = new URL(normalized);
  if (parsedUrl.protocol === "http:" && allowOfficialHttpUpgrade) {
    parsedUrl.protocol = "https:";
  }
  if (parsedUrl.protocol !== "https:") throw new Error("钉钉图片下载地址必须使用 HTTPS");
  return parsedUrl;
}

function dingTalkCommandText(body: DingTalkRobotMessage, text: string): string {
  const trimmed = text.trim();
  if (body.conversationType !== "2") return trimmed;
  // Group callbacks can retain the leading @mention (including DWS <@id>
  // syntax). Strip only mention tokens immediately preceding a slash command;
  // keep ordinary conversation, quoted examples and command arguments intact.
  return trimmed.replace(
    /^(?:(?:<@[^<>\s]+>|@[^@<>/\s]+)[^\S\r\n]+)+(?=\/[a-z][a-z0-9_-]*(?:\s|$))/iu,
    ""
  );
}

function uniqueDingTalkInboundPath(rootDir: string, messageId: string, label: string): string {
  const safeMessageId = sanitizeFileName(messageId).slice(0, 80);
  const extension = path.extname(label);
  const stem = path.basename(label, extension);
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const suffix = attempt ? `-${attempt + 1}` : "";
    const candidate = path.join(rootDir, `${safeMessageId}-${stem}${suffix}${extension}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("无法为钉钉图片分配本地文件名");
}

function dingTalkImageExtension(buffer: Buffer, contentType?: string): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ".jpg";
  const gifHeader = buffer.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return ".gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }
  const normalizedType = contentType?.toLowerCase();
  if (normalizedType === "image/png") return ".png";
  if (normalizedType === "image/jpeg") return ".jpg";
  if (normalizedType === "image/gif") return ".gif";
  if (normalizedType === "image/webp") return ".webp";
  if (normalizedType === "image/heic" || normalizedType === "image/heif") return ".heic";
  return ".bin";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function sendDingTalkEmotionRequest(
  transport: PinnedNetworkLifecycleTransport,
  pathname: "/v1.0/robot/emotion/reply" | "/v1.0/robot/emotion/recall",
  input: DingTalkEmotionInput
): Promise<void> {
  const emotionName = "🤔思考中";
  const response = await transport.request(input.openMsgId, `https://api.dingtalk.com${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": input.accessToken
    },
    body: JSON.stringify({
      robotCode: input.robotCode,
      openMsgId: input.openMsgId,
      openConversationId: input.openConversationId,
      emotionType: 2,
      emotionName,
      textEmotion: {
        emotionId: "2659900",
        emotionName,
        text: emotionName,
        backgroundId: "im_bg_1"
      }
    })
  });
  if (response.ok) return;
  const result = await response.json().catch(() => undefined) as { message?: unknown } | undefined;
  const detail = typeof result?.message === "string" && result.message
    ? result.message
    : `HTTP ${response.status}`;
  throw new Error(`钉钉表情请求失败（${pathname}）：${detail}`);
}

function acknowledge(client: DingTalkStreamClient, frame: DWClientDownStream): void {
  try {
    client.socketCallBackResponse(frame.headers.messageId, {});
  } catch (error) {
    console.warn(`[codex-im-gateway] unable to acknowledge DingTalk message: ${errorDetail(error)}`);
  }
}

async function sendSessionWebhook(transport: PinnedNetworkLifecycleTransport, input: {
  url: string;
  text: string;
  accessToken: string;
  lifecycleId: string;
  atUserIds?: readonly string[];
}): Promise<{ messageId?: string }> {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || !url.hostname.toLowerCase().endsWith(".dingtalk.com")) {
    throw new Error("钉钉会话回复地址无效");
  }
  const response = await transport.request(input.lifecycleId, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": input.accessToken
    },
    body: JSON.stringify({ msgtype: "text", text: { content: input.text },
      ...(input.atUserIds ? { at: { atUserIds: input.atUserIds, isAtAll: false } } : {}) })
  });
  const result = await response.json().catch(() => undefined) as {
    errcode?: unknown;
    errmsg?: unknown;
    processQueryKey?: unknown;
  } | undefined;
  if (!response.ok || result?.errcode !== 0) {
    throw new ChannelDeliveryError("dingtalk", "sendSessionWebhook",
      typeof result?.errcode === "number" ? result.errcode : undefined);
  }
  return typeof result?.processQueryKey === "string" && result.processQueryKey
    ? { messageId: result.processQueryKey }
    : { messageId: `dingtalk-webhook-receipt:${crypto.randomUUID()}` };
}

function normalizeExpiry(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function waitForAbort(signal?: AbortSignal): { promise: Promise<void>; dispose: () => void } {
  let onAbort = () => {};
  const promise = new Promise<void>((resolve) => {
    onAbort = resolve;
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose: () => signal?.removeEventListener("abort", onAbort) };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
