import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import DingTalk from "@alicloud/dingtalk";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";
import {
  DWClient,
  TOPIC_ROBOT,
  type DWClientDownStream,
  type RobotMessage
} from "dingtalk-stream";

import type { DingTalkAccount } from "../weixin/accounts.js";
import { sanitizeFileName } from "../weixin/media.js";
import type { ChannelMessage } from "./message.js";
import type { ChannelAdapter, ChannelClient, ChannelMonitorOptions, ChannelTextClient, ChannelReceipt, ChannelDeliveryPart } from "./types.js";
import type { ChannelActionCard } from "./action-card.js";
import { renderMarkdownTable, escapeTableMarkdown } from "./table.js";
import { chunkText } from "../bridge/format.js";
import { ChannelPartialDeliveryError } from "./errors.js";
import { createChannelClient, TEXT_CAPABILITIES, NO_MEDIA } from "./client.js";
import {
  PinnedNetworkLifecycleTransport,
  type NetworkFamilyPolicy
} from "./network-family.js";

type DingTalkStreamClient = {
  readonly connected?: boolean;
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
}) => Promise<{ messageId?: string } | void>;

export type DingTalkAICardTarget =
  | { readonly type: "group"; readonly conversationId: string }
  | { readonly type: "user"; readonly staffId: string };

export type DingTalkAICardClient = {
  create(input: {
    accessToken: string;
    cardTemplateId: string;
    contentKey: string;
    outTrackId: string;
    robotCode: string;
    target: DingTalkAICardTarget;
    text: string;
    lifecycleId?: string;
  }): Promise<void>;
  update(input: {
    accessToken: string;
    contentKey: string;
    outTrackId: string;
    text: string;
    finalize: boolean;
    error: boolean;
  }): Promise<void>;
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
};

type DingTalkRobotMessage = Omit<RobotMessage, "msgtype" | "text"> & {
  readonly msgtype: string;
  readonly text?: { readonly content?: unknown };
  readonly content?: unknown;
};

type DingTalkInboundImage = {
  readonly downloadCode?: string;
  readonly downloadUrl?: string;
};

type ReplyTarget = {
  readonly webhookUrl: string;
  readonly expiresAt?: number;
  readonly conversationId: string;
  readonly conversationType: string;
  readonly actorId: string;
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
  private readonly apiTransport: PinnedNetworkLifecycleTransport;
  private readonly inboundDir: string;
  private readonly now: () => number;
  private readonly replyTargets = new Map<string, ReplyTarget>();
  private readonly activeNetworkLifecycles = new Set<string>();

  constructor(private readonly account: DingTalkAccount, options: DingTalkAdapterOptions = {}) {
    this.streamClient = options.streamClient ?? new DWClient({
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
    this.maxInboundBytes = options.maxInboundBytes ?? 100 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.client = createChannelClient("dingtalk", {
      ...TEXT_CAPABILITIES, inbound: { ...NO_MEDIA, image: "available" },
      tableLayout: account.cardTemplateId ? "markdown" : "list",
      progress: account.cardTemplateId ? "available" : "not-configured",
      resumableProgress: Boolean(account.cardTemplateId)
    }, this);
  }

  async sendText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    if (this.account.cardTemplateId) {
      try {
        return await this.createTextCard(this.cardTarget(input.toUserId), input.text, true);
      } catch (error) {
        console.warn(`[codex-im-gateway] DingTalk AI Card unavailable, falling back to text: ${errorDetail(error)}`);
      }
    }
    return this.sendWebhookText(input);
  }

  /** Read-only table in the existing AI template; selection remains a slash command. */
  async sendActionCard(input: { toUserId: string; card: ChannelActionCard }): Promise<ChannelReceipt> {
    const { card } = input;
    if (card.table && this.account.cardTemplateId) {
      const text = [escapeTableMarkdown(card.title), card.body, renderMarkdownTable(card.table), card.note].filter(Boolean).join("\n\n");
      try {
        return await this.createTextCard(this.cardTarget(input.toUserId), text, true);
      } catch (error) {
        console.warn(`[codex-im-gateway] DingTalk table card unavailable, falling back to a compact list: ${errorDetail(error)}`);
      }
    }
    const parts: ChannelDeliveryPart[] = [];
    try {
      for (const text of chunkText(card.fallbackText)) {
        const result = await this.sendWebhookText({ toUserId: input.toUserId, text });
        parts.push({ messageId: result.messageId, text });
      }
    } catch (error) { throw new ChannelPartialDeliveryError(parts, error); }
    return { messageId: parts.at(-1)!.messageId, parts };
  }

  private async sendWebhookText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    const target = this.requireReplyTarget(input.toUserId);
    const accessToken = await this.accessToken();
    const lifecycleId = target.messageId || `dingtalk-webhook-${crypto.randomUUID()}`;
    const ownedLifecycle = !this.activeNetworkLifecycles.has(lifecycleId);
    try {
      const result = await this.webhookSender({
        url: target.webhookUrl,
        text: input.text,
        accessToken,
        lifecycleId
      });
      return { messageId: result?.messageId ?? crypto.randomUUID() };
    } finally {
      if (ownedLifecycle) this.apiTransport.close(lifecycleId);
    }
  }

  async startTextStream(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    if (!this.account.cardTemplateId) throw new Error("钉钉 AI Card 模板未配置");
    return this.createTextCard(this.cardTarget(input.toUserId), input.text, false);
  }

  readonly resumableTextStream = true;

  async updateTextStream(input: {
    toUserId: string;
    messageId: string;
    text: string;
    finalize?: boolean;
    error?: boolean;
  }): Promise<void> {
    if (!this.account.cardTemplateId) throw new Error("钉钉 AI Card 模板未配置");
    await this.cardClient.update({
      accessToken: await this.accessToken(),
      contentKey: this.account.cardContentKey?.trim() || "content",
      outTrackId: input.messageId,
      text: input.text,
      finalize: input.finalize ?? false,
      error: input.error ?? false
    });
  }

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    if (options.signal?.aborted) return;
    options.onStatus?.({ state: "connecting" });
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

      const content = dingTalkMessageContent(body);

      const expiresAt = normalizeExpiry(body.sessionWebhookExpiredTime);
      const replyTarget: ReplyTarget = {
        webhookUrl,
        conversationId,
        conversationType: body.conversationType,
        actorId,
        robotCode: body.robotCode?.trim() || this.account.clientId,
        messageId: body.msgId || frame.headers.messageId,
        ...(expiresAt !== undefined ? { expiresAt } : {})
      };
      this.replyTargets.set(conversationId, replyTarget);
      this.replyTargets.set(actorId, replyTarget);
      const message: ChannelMessage = {
        id: body.msgId || frame.headers.messageId,
        senderId: actorId,
        replyTargetId: conversationId,
        text: content?.text ?? "",
        ...(!content ? { unsupportedMessageType: body.msgtype } : {}),
        attachments: [],
        raw: { channel: "dingtalk", event: body }
      };
      if (options.claimMessage && !options.claimMessage(message)) return;
      void this.handleMessageWithEmotion(message, replyTarget, options, content?.images);
    };

    this.streamClient.registerCallbackListener(TOPIC_ROBOT, handle);
    let healthTimer: NodeJS.Timeout | undefined;
    try {
      await this.streamClient.connect();
      let last: string | undefined;
      const report = () => {
        const state = this.streamClient.connected === false ? "reconnecting" : "connected";
        if (last !== state) { last = state; options.onStatus?.({ state }); }
      };
      report();
      healthTimer = setInterval(report, 5_000);
      healthTimer.unref();
      await untilAborted(options.signal);
    } finally {
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
    images: readonly DingTalkInboundImage[] = []
  ): Promise<void> {
    this.activeNetworkLifecycles.add(target.messageId);
    const thinking = this.sendThinkingEmotion("reply", target)
      .then(() => true)
      .catch((error) => {
        console.warn(`[codex-im-gateway] DingTalk thinking emotion unavailable: ${errorDetail(error)}`);
        return false;
    });
    try {
      const attachments = images.length
        ? await this.downloadInboundImages(message.id, target.robotCode, images)
        : [];
      await options.onMessage({ ...message, attachments });
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

  private async downloadInboundImages(
    messageId: string,
    robotCode: string,
    images: readonly DingTalkInboundImage[]
  ): Promise<ChannelMessage["attachments"]> {
    const accessToken = await this.accessToken();
    const attachments: ChannelMessage["attachments"] = [];
    fs.mkdirSync(this.inboundDir, { recursive: true });
    for (const [index, image] of images.entries()) {
      try {
        const downloaded = await this.mediaClient.download({
          accessToken,
          robotCode,
          downloadCode: image.downloadCode,
          downloadUrl: image.downloadUrl,
          maxBytes: this.maxInboundBytes,
          lifecycleId: messageId
        });
        const extension = dingTalkImageExtension(downloaded.buffer, downloaded.contentType);
        const label = sanitizeFileName(`dingtalk-image-${index + 1}${extension}`);
        const targetPath = uniqueDingTalkInboundPath(this.inboundDir, messageId, label);
        fs.writeFileSync(targetPath, downloaded.buffer, { flag: "wx" });
        attachments.push({ kind: "image", label, item: {}, path: targetPath });
      } catch (error) {
        throw new Error(`DingTalk inbound image download failed: ${errorDetail(error)}`);
      }
    }
    return attachments;
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
    finalize: boolean
  ): Promise<{ messageId: string }> {
    const cardTemplateId = this.account.cardTemplateId?.trim();
    if (!cardTemplateId) throw new Error("钉钉 AI Card 模板未配置");
    const outTrackId = `codex_bridge_${crypto.randomUUID().replaceAll("-", "")}`;
    const accessToken = await this.accessToken();
    const contentKey = this.account.cardContentKey?.trim() || "content";
    await this.cardClient.create({
      accessToken,
      cardTemplateId,
      contentKey,
      outTrackId,
      robotCode: target.robotCode,
      text,
      target: target.conversationType === "2"
        ? { type: "group", conversationId: target.conversationId }
        : { type: "user", staffId: target.actorId },
      ...(target.messageId && this.activeNetworkLifecycles.has(target.messageId)
        ? { lifecycleId: target.messageId }
        : {})
    });
    await this.cardClient.update({
      accessToken,
      contentKey,
      outTrackId,
      text,
      finalize,
      error: false
    });
    return { messageId: outTrackId };
  }

  private cardTarget(toUserId: string): CardTargetContext {
    const established = this.replyTargets.get(toUserId);
    if (established) return established;
    const recipient = toUserId.trim();
    if (!recipient) throw new Error("钉钉 AI Card 接收目标不能为空");
    return {
      conversationId: recipient,
      conversationType: recipient.startsWith("cid") ? "2" : "1",
      actorId: recipient,
      robotCode: this.account.clientId
    };
  }
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

  async create(input: {
    accessToken: string;
    cardTemplateId: string;
    contentKey: string;
    outTrackId: string;
    robotCode: string;
    target: DingTalkAICardTarget;
    text: string;
    lifecycleId?: string;
  }): Promise<void> {
    const suppliedLifecycleId = input.lifecycleId?.trim();
    const lifecycle = { id: suppliedLifecycleId || input.outTrackId, owned: !suppliedLifecycleId };
    this.cardLifecycles.set(input.outTrackId, lifecycle);
    try {
      await this.mutate(lifecycle.id, "create", "/v1.0/card/instances", "POST", input.accessToken, {
        cardTemplateId: input.cardTemplateId,
        outTrackId: input.outTrackId,
        cardData: { cardParamMap: { config: JSON.stringify({ autoLayout: true }) } },
        callbackType: "STREAM",
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true }
      });
      await this.mutate(lifecycle.id, "deliver", "/v1.0/card/instances/deliver", "POST", input.accessToken, {
        outTrackId: input.outTrackId,
        userIdType: 1,
        ...(input.target.type === "group" ? {
          openSpaceId: `dtv1.card//IM_GROUP.${input.target.conversationId}`,
          imGroupOpenDeliverModel: { robotCode: input.robotCode }
        } : {
          openSpaceId: `dtv1.card//IM_ROBOT.${input.target.staffId}`,
          imRobotOpenDeliverModel: {
            spaceType: "IM_ROBOT",
            robotCode: input.robotCode,
            extension: { dynamicSummary: "true" }
          }
        })
      });
      this.inputingCards.delete(input.outTrackId);
    } catch (error) {
      this.cardLifecycles.delete(input.outTrackId);
      if (lifecycle.owned) this.transport.close(lifecycle.id);
      throw error;
    }
  }

  async update(input: {
    accessToken: string;
    contentKey: string;
    outTrackId: string;
    text: string;
    finalize: boolean;
    error: boolean;
  }): Promise<void> {
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

  private async updateWithRetry(input: {
    accessToken: string;
    contentKey: string;
    outTrackId: string;
    text: string;
    finalize: boolean;
    error: boolean;
  }, lifecycleId: string): Promise<void> {
    const content = normalizeDingTalkCardContent(input.text).slice(0, 50_000);
    const firstUpdate = !this.inputingCards.has(input.outTrackId);
    if (firstUpdate) {
      await this.updateCardState(lifecycleId, input, content, "2", false);
      this.inputingCards.add(input.outTrackId);
    }
    const streamBody = dingTalkCardStreamingUpdateBody({
      outTrackId: input.outTrackId,
      contentKey: input.contentKey,
      text: input.finalize ? content : content.replace(/\n+$/, ""),
      finalize: input.finalize,
      error: input.error,
      guid: `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
    });
    await this.mutateWithRetry(lifecycleId, "stream", "/v1.0/card/streaming", input.accessToken, streamBody);
    console.log(
      `[codex-im-gateway] DingTalk AI Card HTTPS streamed finalize=${input.finalize} `
      + `error=${input.error} outTrackId=${input.outTrackId} content=${oneLineCardPreview(content, 180)}`
    );
    if (input.finalize) {
      await this.updateCardState(lifecycleId, input, content, input.error ? "5" : "3", true);
      this.inputingCards.delete(input.outTrackId);
    } else if (!firstUpdate) {
      // Some DingTalk tenants acknowledge /card/streaming without pushing the
      // new value to clients. Force the same full snapshot through the card
      // instance endpoint, which is the path that reliably renders the first
      // frame in those tenants.
      await this.updateCardState(lifecycleId, input, content, "2", true);
    }
  }

  private async updateCardState(
    lifecycleId: string,
    input: { accessToken: string; contentKey: string; outTrackId: string },
    content: string,
    flowStatus: "2" | "3" | "5",
    updateByKey: boolean
  ): Promise<void> {
    await this.mutateWithRetry(lifecycleId, "state", "/v1.0/card/instances", input.accessToken, {
      outTrackId: input.outTrackId,
      cardData: {
        cardParamMap: dingTalkCardStateParamMap({
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
        if (attempt + 1 < this.retryDelaysMs.length) {
          console.warn(
            `[codex-im-gateway] DingTalk AI Card HTTPS ${operation} attempt ${attempt + 1} failed; retrying: `
            + errorDetail(error)
          );
        }
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
    const response = await this.transport.request(lifecycleId, `https://api.dingtalk.com${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken
      },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => undefined) as {
      success?: unknown;
      result?: unknown;
      code?: unknown;
      message?: unknown;
      requestId?: unknown;
    } | undefined;
    if (response.ok && result?.success !== false && result?.result !== false) return;
    const code = typeof result?.code === "string" ? result.code : undefined;
    const message = typeof result?.message === "string" ? result.message : undefined;
    const requestId = typeof result?.requestId === "string"
      ? result.requestId
      : response.headers.get("x-acs-request-id") ?? undefined;
    throw new Error(
      `钉钉 AI Card ${operation} 请求失败（HTTP ${response.status}`
      + `${code ? `, code=${code}` : ""}${requestId ? `, requestId=${requestId}` : ""}）`
      + `${message ? `：${message}` : ""}`
    );
  }
}

export class DingTalkSdkAICardClient implements DingTalkAICardClient {
  private readonly client: DingTalkCardSdkClient;
  private readonly runtime = new RuntimeOptions({});
  private readonly updateChains = new Map<string, Promise<void>>();
  private readonly inputingCards = new Set<string>();
  private lastStreamGuidTimestamp = 0;
  private streamGuidSequence = 0;

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

  async create(input: {
    accessToken: string;
    cardTemplateId: string;
    contentKey: string;
    outTrackId: string;
    robotCode: string;
    target: DingTalkAICardTarget;
    text: string;
  }): Promise<void> {
    const createRequest = new DingTalk.card_1_0.CreateCardRequest({
      cardTemplateId: input.cardTemplateId,
      outTrackId: input.outTrackId,
      cardData: new DingTalk.card_1_0.CreateCardRequestCardData({
        cardParamMap: {
          [input.contentKey]: "",
          config: JSON.stringify({ autoLayout: true })
        }
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

    const deliverRequest = new DingTalk.card_1_0.DeliverCardRequest({
      outTrackId: input.outTrackId,
      userIdType: 1,
      ...(input.target.type === "group" ? {
        openSpaceId: `dtv1.card//IM_GROUP.${input.target.conversationId}`,
        imGroupOpenDeliverModel: new DingTalk.card_1_0.DeliverCardRequestImGroupOpenDeliverModel({
          robotCode: input.robotCode
        })
      } : {
        openSpaceId: `dtv1.card//IM_ROBOT.${input.target.staffId}`,
        imRobotOpenDeliverModel: new DingTalk.card_1_0.DeliverCardRequestImRobotOpenDeliverModel({
          spaceType: "IM_ROBOT"
        })
      })
    });
    const deliverHeaders = new DingTalk.card_1_0.DeliverCardHeaders({
      xAcsDingtalkAccessToken: input.accessToken
    });
    const deliverResponse = await this.client.deliverCardWithOptions(deliverRequest, deliverHeaders, this.runtime);
    assertDingTalkCardMutationSucceeded("deliver", deliverResponse);
    this.inputingCards.delete(input.outTrackId);
  }

  async update(input: {
    accessToken: string;
    contentKey: string;
    outTrackId: string;
    text: string;
    finalize: boolean;
    error: boolean;
  }): Promise<void> {
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

  private async updateWithRetry(input: {
    accessToken: string;
    contentKey: string;
    outTrackId: string;
    text: string;
    finalize: boolean;
    error: boolean;
  }): Promise<void> {
    const content = normalizeDingTalkCardContent(input.text).slice(0, 50_000);
    if (!this.inputingCards.has(input.outTrackId)) {
      await this.updateCardStateWithRetry(input, content, "2", false);
      this.inputingCards.add(input.outTrackId);
    }
    const guid = this.nextStreamGuid();
    let lastError: unknown;
    for (const [attempt, retryDelay] of this.retryDelaysMs.entries()) {
      if (retryDelay > 0) await this.sleep(retryDelay);
      const request = new DingTalk.card_1_0.StreamingUpdateRequest(dingTalkCardStreamingUpdateBody({
        outTrackId: input.outTrackId,
        contentKey: input.contentKey,
        text: content,
        finalize: input.finalize,
        error: input.error,
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
          + `content=${oneLineCardPreview(content, 180)}`
        );
        if (input.finalize) {
          await this.updateCardStateWithRetry(input, content, input.error ? "5" : "3", true);
          this.inputingCards.delete(input.outTrackId);
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < this.retryDelaysMs.length) {
          console.warn(
            `[codex-im-gateway] DingTalk AI Card stream attempt ${attempt + 1} failed; retrying: `
            + errorDetail(error)
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
    updateByKey: boolean
  ): Promise<void> {
    let lastError: unknown;
    for (const [attempt, retryDelay] of this.retryDelaysMs.entries()) {
      if (retryDelay > 0) await this.sleep(retryDelay);
      const request = new DingTalk.card_1_0.UpdateCardRequest({
        outTrackId: input.outTrackId,
        cardData: new DingTalk.card_1_0.UpdateCardRequestCardData({
          cardParamMap: dingTalkCardStateParamMap({
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
        if (attempt + 1 < this.retryDelaysMs.length) {
          console.warn(
            `[codex-im-gateway] DingTalk AI Card state attempt ${attempt + 1} failed; retrying: `
            + errorDetail(error)
          );
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorDetail(lastError));
  }

  private nextStreamGuid(): string {
    const timestamp = Math.max(Date.now(), this.lastStreamGuidTimestamp);
    if (timestamp === this.lastStreamGuidTimestamp) {
      this.streamGuidSequence += 1;
    } else {
      this.lastStreamGuidTimestamp = timestamp;
      this.streamGuidSequence = 0;
    }
    return `${timestamp}_${this.streamGuidSequence.toString(36).padStart(6, "0")}`;
  }
}

type DingTalkCardMutationResponse = {
  readonly statusCode?: number;
  readonly headers?: Record<string, string>;
  readonly body?: {
    readonly success?: boolean;
    readonly result?: unknown;
  };
};

export function assertDingTalkCardMutationSucceeded(
  operation: "create" | "deliver" | "stream" | "state",
  response: DingTalkCardMutationResponse
): void {
  const result = response.body?.result;
  const failedDelivery = Array.isArray(result)
    ? result.find((item) => item && typeof item === "object" && (item as { success?: boolean }).success === false)
    : undefined;
  if (response.body?.success !== false && result !== false && !failedDelivery) return;
  const requestId = response.headers?.["x-acs-request-id"] ?? response.headers?.["x-acs-trace-id"];
  const deliveryMessage = failedDelivery && typeof failedDelivery === "object"
    ? (failedDelivery as { errorMsg?: unknown }).errorMsg
    : undefined;
  const detail = typeof deliveryMessage === "string" && deliveryMessage.trim()
    ? deliveryMessage.trim()
    : `success=${String(response.body?.success)} result=${JSON.stringify(result)}`;
  throw new Error(
    `钉钉 AI Card ${operation} 业务响应失败（HTTP ${response.statusCode ?? "unknown"}`
    + `${requestId ? `, requestId=${requestId}` : ""}）：${detail}`
  );
}

export function dingTalkCardStateParamMap(input: {
  contentKey: string;
  text: string;
  flowStatus: "2" | "3" | "5";
}): Record<string, string> {
  return {
    flowStatus: input.flowStatus,
    [input.contentKey]: input.text,
    staticMsgContent: "",
    sys_full_json_obj: JSON.stringify({ order: [input.contentKey] }),
    config: JSON.stringify({ autoLayout: true })
  };
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

function oneLineCardPreview(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
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
      if (!downloadCode) throw new Error("钉钉图片缺少 downloadCode 和 pictureUrl");
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
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > input.maxBytes) {
      throw new Error(`钉钉图片超过 ${Math.floor(input.maxBytes / 1024 / 1024)} MiB 上限`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > input.maxBytes) {
      throw new Error(`钉钉图片超过 ${Math.floor(input.maxBytes / 1024 / 1024)} MiB 上限`);
    }
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

function dingTalkMessageContent(
  body: DingTalkRobotMessage
): { text: string; images: DingTalkInboundImage[] } | undefined {
  if (body.msgtype === "text") {
    return { text: stringValue(body.text?.content).trim(), images: [] };
  }
  const content = parseDingTalkContent(body.content);
  if (body.msgtype === "picture") {
    return {
      text: "",
      images: [{
        ...(stringValue(content.downloadCode).trim()
          ? { downloadCode: stringValue(content.downloadCode).trim() }
          : {}),
        ...(stringValue(content.pictureUrl).trim()
          ? { downloadUrl: stringValue(content.pictureUrl).trim() }
          : {})
      }]
    };
  }
  if (body.msgtype === "richText") {
    const richText = Array.isArray(content.richText) ? content.richText : [];
    const textParts: string[] = [];
    const images: DingTalkInboundImage[] = [];
    for (const value of richText) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const part = value as Record<string, unknown>;
      const text = stringValue(part.text);
      if (text) textParts.push(text);
      if (part.type === "picture" || part.pictureUrl || part.downloadCode) {
        images.push({
          ...(stringValue(part.downloadCode).trim()
            ? { downloadCode: stringValue(part.downloadCode).trim() }
            : {}),
          ...(stringValue(part.pictureUrl).trim()
            ? { downloadUrl: stringValue(part.pictureUrl).trim() }
            : {})
        });
      }
    }
    if (!textParts.length && !images.length) return undefined;
    return { text: textParts.join("").trim(), images: uniqueDingTalkImages(images) };
  }
  return undefined;
}

function parseDingTalkContent(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueDingTalkImages(images: readonly DingTalkInboundImage[]): DingTalkInboundImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = image.downloadUrl || image.downloadCode || `missing-${seen.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

export function normalizeDingTalkCardContent(text: string): string {
  const lines = ensureDingTalkTableSpacing(text).split("\n");
  const markdownBlockStart = /^(\s{0,3}(?:[-*+]|\d+[.)])[ ])|(\s{0,3}\|)|(\s{0,3}#{1,6}\s)|(\s{0,3}(?:[-*_])\s*(?:[-*_])\s*(?:[-*_]))/;
  const fence = /^\s{0,3}```/;
  const quote = /^\s{0,3}>\s?/;
  const merged: string[] = [];
  let pendingQuote: string[] = [];
  let inCodeBlock: boolean = false;
  const flushQuote = () => {
    if (!pendingQuote.length) return;
    merged.push(pendingQuote.join("<br>"));
    pendingQuote = [];
  };

  for (const line of lines) {
    const isFence = fence.test(line);
    if (inCodeBlock) {
      flushQuote();
      merged.push(line);
      if (isFence) inCodeBlock = false;
      continue;
    }
    if (isFence) {
      flushQuote();
      merged.push(line);
      inCodeBlock = true;
      continue;
    }
    if (quote.test(line)) {
      pendingQuote.push(pendingQuote.length ? line.replace(quote, "") : line);
    } else {
      flushQuote();
      merged.push(line);
    }
  }
  flushQuote();

  inCodeBlock = false;
  const parts: string[] = [];
  for (let index = 0; index < merged.length; index += 1) {
    const current = merged[index] ?? "";
    const nextInCodeBlock: boolean = fence.test(current) ? !inCodeBlock : inCodeBlock;
    if (index < merged.length - 1) {
      const next = merged[index + 1] ?? "";
      const keepNewline = nextInCodeBlock
        || current === ""
        || next === ""
        || fence.test(next)
        || markdownBlockStart.test(next);
      parts.push(current, keepNewline ? "\n" : "<br>");
    } else {
      parts.push(current);
    }
    inCodeBlock = nextInCodeBlock;
  }
  return parts.join("");
}

function ensureDingTalkTableSpacing(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const result: string[] = [];
  const tableDivider = /^\s*\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)+\|?\s*$/;
  const tableRow = /^\s*\|?.*\|.*\|?\s*$/;
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (tableRow.test(current) && tableDivider.test(next) && index > 0) {
      const previous = lines[index - 1] ?? "";
      if (previous.trim() && !tableRow.test(previous)) result.push("");
    }
    result.push(current);
  }
  return result.join("\n");
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
    body: JSON.stringify({ msgtype: "text", text: { content: input.text } })
  });
  const result = await response.json().catch(() => undefined) as {
    errcode?: unknown;
    errmsg?: unknown;
    processQueryKey?: unknown;
  } | undefined;
  if (!response.ok || (typeof result?.errcode === "number" && result.errcode !== 0)) {
    const detail = typeof result?.errmsg === "string" ? result.errmsg : `HTTP ${response.status}`;
    throw new Error(`钉钉消息发送失败：${detail}`);
  }
  return typeof result?.processQueryKey === "string" && result.processQueryKey
    ? { messageId: result.processQueryKey }
    : {};
}

function normalizeExpiry(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
