import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccount } from "../weixin/accounts.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { ChannelAdapter, ChannelMonitorOptions, ChannelTextClient } from "./types.js";
import { feishuActionCard } from "./feishu-action-card.js";
import { cardActionIdentity, formValueFromRawCardAction } from "./feishu-card-action.js";
import { feishuTaskCard } from "./feishu-task-card.js";
import {
  type ChannelTaskCard
} from "./task-card.js";
import {
  formatChannelActionCommand,
  parseChannelActionValue,
  type ChannelActionCard
} from "./action-card.js";

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
  readonly client: ChannelTextClient = this;
  private readonly apiClient: NonNullable<FeishuAdapterOptions["apiClient"]>;
  private readonly wsClient: NonNullable<FeishuAdapterOptions["wsClient"]>;
  private readonly inboundDir?: string;

  constructor(account: FeishuAccount, options: FeishuAdapterOptions = {}) {
    const config = { appId: account.appId, appSecret: account.appSecret };
    this.apiClient = options.apiClient ?? new Lark.Client(config);
    this.wsClient = options.wsClient ?? new Lark.WSClient(config);
    this.inboundDir = options.inboundDir;
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
    return { messageId: String(result.data?.message_id ?? crypto.randomUUID()) };
  }

  async sendImage(input: { toUserId: string; path: string }): Promise<{ messageId: string }> {
    const upload = await this.apiClient.im.v1.image.create({
      data: { image_type: "message", image: await fs.promises.readFile(input.path) }
    });
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
    return { messageId: String(result.data?.message_id ?? crypto.randomUUID()) };
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
    return { messageId: String(result.data?.message_id ?? crypto.randomUUID()) };
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
    return { messageId: String(result.data?.message_id ?? crypto.randomUUID()) };
  }

  async updateTaskCard(input: { messageId: string; card: ChannelTaskCard }): Promise<void> {
    const patch = this.apiClient.im.v1.message.patch;
    if (!patch) throw new FeishuTaskCardUpdateUnavailableError();
    await patch({
      path: { message_id: input.messageId },
      data: { content: JSON.stringify(feishuTaskCard(input.card)) }
    });
  }

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event) => {
        if (event.message.message_type !== "text" && event.message.message_type !== "image") return;
        const actorId = event.sender.sender_id?.open_id
          ?? event.sender.sender_id?.user_id
          ?? event.sender.sender_id?.union_id;
        if (!actorId) return;
        const pendingMessage: NormalizedWeixinMessage = {
          id: event.message.message_id,
          senderId: actorId,
          replyTargetId: event.message.chat_id,
          text: "",
          attachments: [],
          raw: { channel: "feishu", event }
        };
        if (options.claimMessage && !options.claimMessage(pendingMessage)) return;
        try {
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
        const pendingMessage: NormalizedWeixinMessage = {
          id: `feishu-card:${token}`,
          senderId: event.operator.openId,
          replyTargetId: event.chatId,
          interaction: { kind: "card", messageId: event.messageId },
          text: command,
          attachments: [],
          raw: { channel: "feishu", event: rawEvent }
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
    const started = this.wsClient.start({ eventDispatcher: dispatcher });
    await Promise.race([started, untilAborted(options.signal)]);
    if (!options.signal?.aborted) await untilAborted(options.signal);
    this.wsClient.close({ force: true });
  }

  private async normalizeMessage(
    message: NormalizedWeixinMessage,
    messageType: "text" | "image",
    content: string
  ): Promise<NormalizedWeixinMessage> {
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
  message: NormalizedWeixinMessage
): Promise<void> {
  try {
    await options.onMessageError?.(error, message);
  } catch (reportError) {
    if (!(reportError instanceof Error)) throw reportError;
    console.error(`[codex-channel-bridge] failed to report Feishu message error: ${errorDetail(reportError)}`);
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

class FeishuTaskCardUpdateUnavailableError extends Error {
  readonly name = "FeishuTaskCardUpdateUnavailableError";

  constructor() {
    super("Feishu message patch capability is unavailable");
  }
}
