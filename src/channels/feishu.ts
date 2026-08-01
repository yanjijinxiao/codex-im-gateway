import crypto from "node:crypto";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccount } from "../weixin/accounts.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { ChannelAdapter, ChannelMonitorOptions, ChannelTextClient } from "./types.js";

export class FeishuChannelAdapter implements ChannelAdapter, ChannelTextClient {
  readonly client: ChannelTextClient = this;
  private readonly apiClient: Lark.Client;
  private readonly wsClient: Lark.WSClient;

  constructor(account: FeishuAccount) {
    const config = { appId: account.appId, appSecret: account.appSecret };
    this.apiClient = new Lark.Client(config);
    this.wsClient = new Lark.WSClient(config);
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

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (event) => {
        if (event.message.message_type !== "text") return;
        const message: NormalizedWeixinMessage = {
          id: event.message.message_id,
          senderId: event.message.chat_id,
          text: parseText(event.message.content),
          attachments: [],
          raw: event as unknown as NormalizedWeixinMessage["raw"]
        };
        if (options.claimMessage && !options.claimMessage(message)) return;
        void options.onMessage(message).catch(async (error) => {
          try {
            await options.onMessageError?.(error, message);
          } catch (reportError) {
            console.error(`[codex-channel-bridge] failed to report Feishu message error: ${errorDetail(reportError)}`);
          }
        });
      }
    });
    const started = this.wsClient.start({ eventDispatcher: dispatcher });
    await Promise.race([started, untilAborted(options.signal)]);
    if (!options.signal?.aborted) await untilAborted(options.signal);
    this.wsClient.close({ force: true });
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
