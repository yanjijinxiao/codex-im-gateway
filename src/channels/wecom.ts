import crypto from "node:crypto";

import AiBot, { type TextMessage, type WsFrame } from "@wecom/aibot-node-sdk";

import type { WeComAccount } from "../weixin/accounts.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { ChannelAdapter, ChannelMonitorOptions, ChannelTextClient } from "./types.js";

export class WeComChannelAdapter implements ChannelAdapter, ChannelTextClient {
  readonly client: ChannelTextClient = this;
  private readonly wsClient: InstanceType<typeof AiBot.WSClient>;

  constructor(account: WeComAccount) {
    this.wsClient = new AiBot.WSClient({ botId: account.botId, secret: account.secret });
  }

  async sendText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    const response = await this.wsClient.sendMessage(input.toUserId, {
      msgtype: "markdown",
      markdown: { content: input.text }
    });
    return { messageId: String(response.headers.req_id ?? crypto.randomUUID()) };
  }

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    const handle = (frame: WsFrame<TextMessage>) => {
      const body = frame.body;
      if (!body) return;
      const message: NormalizedWeixinMessage = {
        id: body.msgid,
        senderId: body.chatid ?? body.from.userid,
        text: body.text.content.trim(),
        attachments: [],
        raw: body as unknown as NormalizedWeixinMessage["raw"]
      };
      if (options.claimMessage && !options.claimMessage(message)) return;
      void options.onMessage(message).catch(async (error) => {
        try {
          await options.onMessageError?.(error, message);
        } catch (reportError) {
          console.error(`[codex-weixin] failed to report WeCom message error: ${errorDetail(reportError)}`);
        }
      });
    };
    this.wsClient.on("message.text", handle);
    this.wsClient.connect();
    await untilAborted(options.signal);
    this.wsClient.off("message.text", handle);
    this.wsClient.disconnect();
  }
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
