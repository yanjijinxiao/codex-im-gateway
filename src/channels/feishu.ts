import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccount } from "../weixin/accounts.js";
import type { ChannelMessage } from "./message.js";
import type { ChannelAdapter, ChannelClient, ChannelMonitorOptions, ChannelTextClient } from "./types.js";
import { createChannelClient, TEXT_CAPABILITIES, NO_MEDIA } from "./client.js";
import { inboundBytes } from "./inbound-bytes.js";
import { sanitizeFileName } from "../weixin/media.js";
import { feishuMessageReceipt, assertFeishuSuccess } from "./feishu-result.js";
import { feishuActionCard } from "./feishu-action-card.js";
import { cardActionIdentity, formValueFromRawCardAction } from "./feishu-card-action.js";
import { FeishuCardUpdater } from "./feishu-card-updater.js";
import { commandForFeishuMenuEvent } from "./feishu-shortcuts.js";
import { feishuTaskCard } from "./feishu-task-card.js";
import type { ChannelTaskCard } from "./task-card.js";
import { formatChannelActionCommand, parseChannelActionValue, type ChannelActionCard } from "./action-card.js";

type FeishuAdapterOptions = {
  readonly apiClient?: {
    readonly im: {
      readonly v1: {
        readonly image: Pick<Lark.Client["im"]["v1"]["image"], "create">;
        readonly message: Pick<Lark.Client["im"]["v1"]["message"], "create">
          & Partial<Pick<Lark.Client["im"]["v1"]["message"], "patch" | "get">>;
        readonly messageResource: Pick<Lark.Client["im"]["v1"]["messageResource"], "get">;
      };
    };
  };
  readonly wsClient?: Pick<Lark.WSClient, "start" | "close">;
  readonly inboundDir?: string;
  readonly maxInboundBytes?: number;
};

export class FeishuChannelAdapter implements ChannelAdapter, ChannelTextClient {
  readonly client: ChannelClient;
  private status?: ChannelMonitorOptions["onStatus"];
  private readonly injectedSocket: boolean;
  private readonly apiClient: NonNullable<FeishuAdapterOptions["apiClient"]>;
  private readonly wsClient: NonNullable<FeishuAdapterOptions["wsClient"]>;
  private readonly cardUpdater: FeishuCardUpdater;
  private readonly inboundDir?: string;
  private readonly maxInboundBytes: number;

  constructor(account: FeishuAccount, options: FeishuAdapterOptions = {}) {
    const config = { appId: account.appId, appSecret: account.appSecret };
    this.apiClient = options.apiClient ?? new Lark.Client(config);
    this.injectedSocket = Boolean(options.wsClient);
    this.wsClient = options.wsClient ?? new Lark.WSClient({ ...config,
      onReady: () => this.status?.({ state: "connected" }),
      onReconnected: () => this.status?.({ state: "connected" }),
      onReconnecting: () => this.status?.({ state: "reconnecting" }),
      onError: () => this.status?.({ state: "reconnecting", detail: "WebSocket connection failed" })
    });
    this.cardUpdater = new FeishuCardUpdater(this.apiClient.im.v1.message.patch);
    this.inboundDir = options.inboundDir;
    this.maxInboundBytes = options.maxInboundBytes ?? 100 * 1024 * 1024;
    this.client = createChannelClient("feishu", {
      ...TEXT_CAPABILITIES, mentions: "available", mentionBatchSize: 50, actionCardMentions: "available",
      tableLayout: "native",
      inbound: { ...NO_MEDIA, image: options.inboundDir ? "available" : "not-configured", file: options.inboundDir ? "available" : "not-configured" },
      outbound: { ...NO_MEDIA, image: "available" },
      actions: "available", tasks: "available",
      cardUpdates: this.apiClient.im.v1.message.patch ? "available" : "not-implemented"
    }, this);
  }

  async sendText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    // Ordinary/model-authored text cannot grant native mention authority.
    return this.sendTextPayload({ ...input, text: input.text.replace(/<(\/?at)(?=[\s>])/gi, "&lt;$1") });
  }

  private async sendTextPayload(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    const result = await this.apiClient.im.v1.message.create({
      params: { receive_id_type: recipientType(input.toUserId) },
      data: {
        receive_id: input.toUserId,
        msg_type: "text",
        content: JSON.stringify({ text: input.text })
      }
    });
    return feishuMessageReceipt(result, "sendText");
  }

  async sendMentionNotification(input: import("./types.js").ChannelMentionInput): Promise<{ messageId: string }> {
    if (recipientType(input.toUserId) !== "chat_id") throw new Error("Directed mentions require a group chat");
    // Only structured, validated recipient ids become tags. Model text is escaped.
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const tags = input.mentions.map(item => `<at user_id="${escape(item.userId)}"></at>`).join(" ");
    return this.sendTextPayload({ toUserId: input.toUserId, text: `${tags}\n${escape(input.text)}` });
  }

  async sendImage(input: { toUserId: string; path: string }): Promise<{ messageId: string }> {
    const upload = await this.apiClient.im.v1.image.create({
      data: { image_type: "message", image: await fs.promises.readFile(input.path) }
    });
    assertFeishuSuccess(upload, "uploadImage");
    if (!upload?.image_key) {
      throw new Error("Feishu image upload did not return an image_key");
    }
    const result = await this.apiClient.im.v1.message.create({
      params: { receive_id_type: recipientType(input.toUserId) },
      data: {
        receive_id: input.toUserId,
        msg_type: "image",
        content: JSON.stringify({ image_key: upload.image_key })
      }
    });
    return feishuMessageReceipt(result, "sendImage");
  }

  async sendActionCard(input: import("./types.js").ChannelActionCardInput): Promise<{ messageId: string }> {
    if (input.mentions?.length && recipientType(input.toUserId) !== "chat_id") throw new Error("Directed mentions require a group chat");
    const result = await this.apiClient.im.v1.message.create({
      params: { receive_id_type: recipientType(input.toUserId) },
      data: {
        receive_id: input.toUserId,
        msg_type: "interactive",
        content: JSON.stringify(feishuActionCard(input.card, input.mentions))
      }
    });
    return feishuMessageReceipt(result, "sendActionCard");
  }

  async sendTaskCard(input: { toUserId: string; card: ChannelTaskCard }): Promise<{ messageId: string }> {
    const result = await this.apiClient.im.v1.message.create({
      params: { receive_id_type: recipientType(input.toUserId) },
      data: {
        receive_id: input.toUserId,
        msg_type: "interactive",
        content: JSON.stringify(feishuTaskCard(input.card))
      }
    });
    return feishuMessageReceipt(result, "sendTaskCard");
  }

  async updateActionCard(input: { messageId: string; card: ChannelActionCard }): Promise<void> {
    await this.cardUpdater.update(input.messageId, feishuActionCard(input.card));
  }

  async updateTaskCard(input: { messageId: string; card: ChannelTaskCard }): Promise<void> {
    await this.cardUpdater.update(input.messageId, feishuTaskCard(input.card));
  }

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    if (options.signal?.aborted) return;
    this.status = options.onStatus;
    this.status?.({ state: "connecting" });
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event) => {
        const actorId = event.sender.sender_id?.open_id
          ?? event.sender.sender_id?.user_id
          ?? event.sender.sender_id?.union_id;
        if (!actorId) return;
        const pendingMessage: ChannelMessage = {
          id: event.message.message_id,
          senderId: actorId,
          ...(["p2p", "group"].includes(event.message.chat_type) ? {
            conversationKind: event.message.chat_type === "p2p" ? "direct" as const : "group" as const
          } : {}),
          ...(event.message.chat_type === "group" ? { mention: { userId: actorId } } : {}),
          replyTargetId: event.message.chat_id,
          text: "",
          attachments: [],
          raw: { channel: "feishu", event }
        };
        if (event.message.parent_id) pendingMessage.references = [{ messageId: event.message.parent_id,
          type: "unknown", attachments: [], availability: "metadata-only", reason: "尚未取得引用正文。" }];
        if (!await claimInbound(options, pendingMessage)) return;
        try {
          if (!["text", "image", "file"].includes(event.message.message_type)) {
            await options.onMessage({ ...pendingMessage, unsupportedMessageType: event.message.message_type });
            return;
          }
          await options.onMessage(await this.normalizeMessage(
            pendingMessage,
            event.message.message_type as "text" | "image" | "file",
            event.message.content
          ));
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          await reportMessageError(options, error, pendingMessage);
        }
      },
      "card.action.trigger": async (rawEvent: Lark.RawCardActionEvent) => {
        const event = Lark.normalizeCardAction(rawEvent, { includeRaw: true });
        if (!event) return;
        const action = parseChannelActionValue(event.action.value);
        if (!action) return;
        const command = formatChannelActionCommand(action, formValueFromRawCardAction(rawEvent));
        if (!command) return;
        const token = typeof rawEvent.token === "string" && rawEvent.token.trim()
          ? rawEvent.token.trim()
          : cardActionIdentity(event, command);
        const pendingMessage: ChannelMessage = {
          id: `feishu-card:${token}`,
          senderId: event.operator.openId,
          replyTargetId: event.chatId,
          interaction: { kind: "card", messageId: event.messageId },
          text: command,
          attachments: [],
          raw: { channel: "feishu", event: rawEvent }
        };
        if (!await claimInbound(options, pendingMessage)) return;
        return this.cardUpdater.respondToCallback(async () => {
          try {
            await options.onMessage(pendingMessage);
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            await reportMessageError(options, error, pendingMessage);
          }
        });
      },
      "application.bot.menu_v6": async (event) => {
        const command = commandForFeishuMenuEvent(event.event_key);
        const operatorId = event.operator?.operator_id?.open_id
          ?? event.operator?.operator_id?.user_id
          ?? event.operator?.operator_id?.union_id;
        if (!command || !operatorId) return;
        const eventId = event.event_id ?? event.uuid ?? crypto.randomUUID();
        const pendingMessage: ChannelMessage = {
          id: `feishu-menu:${eventId}`,
          senderId: operatorId,
          replyTargetId: operatorId,
          source: "native-menu",
          text: command,
          attachments: [],
          raw: { channel: "feishu", event }
        };
        if (!await claimInbound(options, pendingMessage)) return;
        try {
          await options.onMessage(pendingMessage);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          await reportMessageError(options, error, pendingMessage);
        }
      }
    });
    try {
      const started = this.wsClient.start({ eventDispatcher: dispatcher });
      await Promise.race([started, untilAborted(options.signal)]);
      if (this.injectedSocket && !options.signal?.aborted) this.status?.({ state: "connected" });
      if (!options.signal?.aborted) await untilAborted(options.signal);
    } finally {
      this.wsClient.close({ force: true });
      this.status?.({ state: "stopped" });
      this.status = undefined;
    }
  }

  private async normalizeMessage(
    message: ChannelMessage,
    messageType: "text" | "image" | "file",
    content: string
  ): Promise<ChannelMessage> {
    if (messageType === "text") return { ...message, text: parseText(content) };
    const value = JSON.parse(content) as { image_key?: string; file_key?: string; file_name?: string };
    const key = messageType === "image" ? value.image_key : value.file_key;
    if (!key) throw new Error("Feishu attachment message did not include a resource key");
    return {
      ...message,
      attachments: [{ kind: messageType, label: messageType === "image" ? "image.png" : value.file_name || "file",
        item: { fileKey: key, messageId: message.id } }]
    };
  }

  async resolveReferences(message: ChannelMessage): Promise<ChannelMessage> {
    const references = [];
    for (const reference of message.references ?? []) {
      if (reference.availability === "available" || !reference.messageId || !this.apiClient.im.v1.message.get) {
        references.push(reference); continue;
      }
      try {
        const result = await this.apiClient.im.v1.message.get({ path: { message_id: reference.messageId } });
        assertFeishuSuccess(result, "getQuotedMessage");
        const quoted = result.data?.items?.find(item => item.message_id === reference.messageId);
        if (!quoted || quoted.chat_id !== (message.replyTargetId ?? message.senderId)
          || !["text", "image", "file"].includes(quoted.msg_type ?? "")) throw new Error("Quoted resource unavailable");
        const decoded = await this.normalizeMessage({ ...message, id: reference.messageId, attachments: [], references: [] },
          quoted.msg_type as "text" | "image" | "file", quoted.body?.content ?? "{}");
        references.push({ ...reference, type: quoted.msg_type!, text: decoded.text,
          attachments: decoded.attachments.map(item => ({ ...item, sourceMessageId: reference.messageId })),
          availability: "available" as const, reason: undefined });
      } catch { references.push({ ...reference, reason: "无法取得引用原文：请检查机器人消息读取权限，或直接发送原文件。" }); }
    }
    return { ...message, references };
  }

  async resolveAttachments(message: ChannelMessage): Promise<ChannelMessage["attachments"]> {
    if (!this.inboundDir) throw new Error("Feishu inbound directory is not configured");
    const attachments: ChannelMessage["attachments"] = [];
    for (const attachment of message.attachments) {
      if (attachment.path) { attachments.push(attachment); continue; }
      const resource = await this.apiClient.im.v1.messageResource.get({
        params: { type: attachment.kind === "image" ? "image" : "file" },
        path: { message_id: String(attachment.item.messageId), file_key: String(attachment.item.fileKey) }
      });
      const bytes = await inboundBytes(resource.getReadableStream(), this.maxInboundBytes);
      fs.mkdirSync(this.inboundDir, { recursive: true });
      const label = sanitizeFileName(attachment.label).slice(0, 180);
      const targetPath = path.join(this.inboundDir, `${crypto.randomUUID()}-${label}`);
      fs.writeFileSync(targetPath, bytes, { flag: "wx", mode: 0o600 });
      attachments.push({ ...attachment, item: {}, path: targetPath, label });
    }
    return attachments;
  }
}

/** SDK dispatch catches rejected callbacks itself. Durable claim errors belong
 * to the same application boundary as decoding and execution, before any input. */
async function claimInbound(options: ChannelMonitorOptions, message: ChannelMessage): Promise<boolean> {
  try { return !options.claimMessage || options.claimMessage(message); }
  catch (error) {
    await reportMessageError(options, error instanceof Error ? error : new Error("Feishu inbound receipt unavailable"), message);
    return false;
  }
}

async function reportMessageError(
  options: ChannelMonitorOptions,
  error: Error,
  message: ChannelMessage
): Promise<void> {
  try {
    await options.onMessageError?.(error, message);
  } catch (reportError) {
    if (!(reportError instanceof Error)) throw reportError;
    console.error(`[codex-im-gateway] failed to report Feishu message error: ${errorDetail(reportError)}`);
  }
}

function recipientType(recipientId: string): "chat_id" | "open_id" | "user_id" {
  if (recipientId.startsWith("oc_")) return "chat_id";
  if (recipientId.startsWith("ou_")) return "open_id";
  return "user_id";
}

function parseText(content: string): string {
  try {
    const value = JSON.parse(content) as { text?: unknown };
    return typeof value.text === "string" ? value.text.trim() : "";
  } catch {
    return content.trim();
  }
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
