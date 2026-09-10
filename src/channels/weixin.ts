import { WeixinApiClient, isStaleContextError, type FetchLike } from "../weixin/api.js";
import type { WeixinAccount } from "../weixin/accounts.js";
import { downloadInboundAttachments, sendLocalMediaFile } from "../weixin/media.js";
import { monitorWeixin, type MonitorOptions } from "../weixin/monitor.js";
import { createChannelClient, TEXT_CAPABILITIES } from "./client.js";
import { ChannelContextExpiredError } from "./errors.js";
import type { ChannelAdapter, ChannelCapabilities, ChannelClient, ChannelMonitorOptions } from "./types.js";

export type WeixinAdapterOptions = {
  inboundDir: string;
  maxInboundBytes: number;
  apiClient?: WeixinApiClient;
  mediaFetch?: FetchLike;
  monitor?: (options: MonitorOptions) => Promise<void>;
};

export const WEIXIN_CAPABILITIES: ChannelCapabilities = {
  ...TEXT_CAPABILITIES,
  inbound: { image: "available", file: "available", video: "available", audio: "available" },
  outbound: { image: "available", file: "available", video: "available", audio: "not-implemented" },
  typing: "available"
};

export class WeixinChannelAdapter implements ChannelAdapter {
  readonly client: ChannelClient;
  private readonly api: WeixinApiClient;
  constructor(account: WeixinAccount, private readonly options: WeixinAdapterOptions) {
    this.api = options.apiClient ?? new WeixinApiClient({ baseUrl: account.baseUrl, token: account.token });
    this.client = createChannelClient("weixin", WEIXIN_CAPABILITIES, {
      sendText: async (input) => {
        try { return await this.api.sendText(input); }
        catch (error) { if (isStaleContextError(error)) throw new ChannelContextExpiredError(); throw error; }
      },
      sendTyping: (input) => this.api.sendTyping(input),
      sendMedia: (input) => sendLocalMediaFile({ client: this.api, ...input, filePath: input.path,
        kind: input.kind as "image" | "file" | "video", fetch: options.mediaFetch }),
      resolveAttachments: async (message) => {
        const remote = message.attachments.filter((attachment) => !attachment.path);
        const downloaded = await downloadInboundAttachments({ rootDir: options.inboundDir,
          senderId: message.senderId, messageId: message.id, attachments: remote,
          maxBytes: options.maxInboundBytes, cdnBaseUrl: account.cdnBaseUrl, fetch: options.mediaFetch });
        let index = 0;
        return message.attachments.map((attachment) => attachment.path ? attachment : { ...attachment, ...downloaded[index++] });
      }
    });
  }

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    options.onStatus?.({ state: "connecting" });
    try {
      await (this.options.monitor ?? monitorWeixin)({ ...options, client: this.api,
        initialSyncKey: options.checkpoint, onSyncKey: options.onCheckpoint });
    } finally { options.onStatus?.({ state: "stopped" }); }
  }
}
