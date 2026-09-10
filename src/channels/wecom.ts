import crypto from "node:crypto";

import AiBot, { type TextMessage, type WsFrame } from "@wecom/aibot-node-sdk";

import type { WeComAccount } from "../weixin/accounts.js";
import type { ChannelMessage } from "./message.js";
import type { ChannelAdapter, ChannelClient, ChannelMonitorOptions, ChannelTextClient } from "./types.js";
import { createChannelClient, TEXT_CAPABILITIES } from "./client.js";

export class WeComChannelAdapter implements ChannelAdapter, ChannelTextClient {
  readonly client: ChannelClient;
  private readonly wsClient: InstanceType<typeof AiBot.WSClient>;

  constructor(account: WeComAccount, options: { wsClient?: InstanceType<typeof AiBot.WSClient> } = {}) {
    this.wsClient = options.wsClient ?? new AiBot.WSClient({ botId: account.botId, secret: account.secret });
    this.client = createChannelClient("wecom", TEXT_CAPABILITIES, this);
  }

  async sendText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    const response = await this.wsClient.sendMessage(input.toUserId, {
      msgtype: "markdown",
      markdown: { content: input.text }
    });
    return { messageId: String(response.headers.req_id ?? crypto.randomUUID()) };
  }

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    if (options.signal?.aborted) return;
    options.onStatus?.({ state: "connecting" });
    const handle = (frame: WsFrame<TextMessage>) => {
      const body = frame.body;
      if (!body) return;
      const message: ChannelMessage = {
        id: body.msgid,
        senderId: body.from.userid,
        replyTargetId: body.chatid ?? body.from.userid,
        text: body.text.content.trim(),
        attachments: [],
        raw: { channel: "wecom", event: body }
      };
      if (options.claimMessage && !options.claimMessage(message)) return;
      void options.onMessage(message).catch(async (error) => {
        try {
          await options.onMessageError?.(error, message);
        } catch (reportError) {
          console.error(`[codex-im-gateway] failed to report WeCom message error: ${errorDetail(reportError)}`);
        }
      });
    };
    const connected = () => options.onStatus?.({ state: "connected" });
    const reconnecting = () => options.onStatus?.({ state: "reconnecting" });
    const error = () => options.onStatus?.({ state: "reconnecting", detail: "WebSocket connection failed" });
    this.wsClient.on("message.text", handle);
    this.wsClient.on("authenticated", connected);
    this.wsClient.on("disconnected", reconnecting);
    this.wsClient.on("reconnecting", reconnecting);
    this.wsClient.on("error", error);
    try {
      this.wsClient.connect();
      await untilAborted(options.signal);
    } finally {
      this.wsClient.off("message.text", handle);
      this.wsClient.off("authenticated", connected);
      this.wsClient.off("disconnected", reconnecting);
      this.wsClient.off("reconnecting", reconnecting);
      this.wsClient.off("error", error);
      this.wsClient.disconnect();
      options.onStatus?.({ state: "stopped" });
    }
  }
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
