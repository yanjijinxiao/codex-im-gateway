import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccount } from "../weixin/accounts.js";
import type { ChannelMessage } from "./message.js";
import type { ChannelAdapter, ChannelClient, ChannelMonitorOptions, ChannelTextClient } from "./types.js";
import { createChannelClient, TEXT_CAPABILITIES, NO_MEDIA } from "./client.js";
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
          & Partial<Pick<Lark.Client["im"]["v1"]["message"], "patch">>;
        readonly messageResource: Pick<Lark.Client["im"]["v1"]["messageResource"], "get">;
      };
    };
  };
  readonly wsClient?: Pick<Lark.WSClient, "start" | "close">;
  readonly inboundDir?: string;
};

export class FeishuChannelAdapter implements ChannelAdapter, ChannelTextClient {
  readonly client: ChannelClient;
  private status?: ChannelMonitorOptions["onStatus"];
  private readonly injectedSocket: boolean;
  private readonly apiClient: NonNullable<FeishuAdapterOptions["apiClient"]>;
  private readonly wsClient: NonNullable<FeishuAdapterOptions["wsClient"]>;
  private readonly cardUpdater: FeishuCardUpdater;
  private readonly inboundDir?: string;

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
    this.client = createChannelClient("feishu", {
      ...TEXT_CAPABILITIES,
      tableLayout: "native",
      inbound: { ...NO_MEDIA, image: options.inboundDir ? "available" : "not-configured" },
      outbound: { ...NO_MEDIA, image: "available" },
      actions: "available", tasks: "available",
      cardUpdates: this.apiClient.im.v1.message.patch ? "available" : "not-implemented"
    }, this);
  }

  async sendText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
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

  async sendActionCard(input: { toUserId: string; card: ChannelActionCard }): Promise<{ messageId: string }> {
    const result = await this.apiClient.im.v1.message.create({
      params: { receive_id_type: recipientType(input.toUserId) },
      data: {
        receive_id: input.toUserId,
        msg_type: "interactive",
        content: JSON.stringify(feishuActionCard(input.card))
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
          replyTargetId: event.message.chat_id,
          text: "",
          attachments: [],
          raw: { channel: "feishu", event }
        };
        if (options.claimMessage && !options.claimMessage(pendingMessage)) return;
        try {
          if (event.message.message_type !== "text" && event.message.message_type !== "image") {
            await options.onMessage({ ...pendingMessage, unsupportedMessageType: event.message.message_type });
            return;
          }
          await options.onMessage(await this.normalizeMessage(
            pendingMessage,
            event.message.message_type,
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
          : cardActionIdentity(event);
        const pendingMessage: ChannelMessage = {
          id: `feishu-card:${token}`,
          senderId: event.operator.openId,
          replyTargetId: event.chatId,
          interaction: { kind: "card", messageId: event.messageId },
          text: command,
          attachments: [],
          raw: { channel: "feishu", event: rawEvent }
        };
        if (options.claimMessage && !options.claimMessage(pendingMessage)) return;
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
        if (options.claimMessage && !options.claimMessage(pendingMessage)) return;
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
    messageType: "text" | "image",
    content: string
  ): Promise<ChannelMessage> {
    if (messageType === "text") return { ...message, text: parseText(content) };
    const imageKey = parseImageKey(content);
    if (!imageKey) throw new Error("Feishu image message did not include an image_key");
    if (!this.inboundDir) throw new Error("Feishu inbound directory is not configured");
    fs.mkdirSync(this.inboundDir, { recursive: true });
    const targetPath = pathForInboundImage(this.inboundDir, message.id, imageKey);
    const resource = await this.apiClient.im.v1.messageResource.get({
      params: { type: "image" },
      path: { message_id: message.id, file_key: imageKey }
    });
    await resource.writeFile(targetPath);
    return {
      ...message,
      attachments: [{ kind: "image", label: path.basename(targetPath), item: {}, path: targetPath }]
    };
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

function parseImageKey(content: string): string | undefined {
  try {
    const value = JSON.parse(content) as { image_key?: unknown };
    return typeof value.image_key === "string" && value.image_key.trim() ? value.image_key.trim() : undefined;
  } catch {
    return undefined;
  }
}

function pathForInboundImage(inboundDir: string, messageId: string, imageKey: string): string {
  const safeName = `${messageId}-${imageKey}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(inboundDir, `${safeName || crypto.randomUUID()}.png`);
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
