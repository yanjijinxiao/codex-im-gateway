/** Compatibility for the original injected `weixin` client. No production routing lives here. */
import { isStaleContextError, type FetchLike, type WeixinApiClient } from "../weixin/api.js";
import { downloadInboundAttachments, sendLocalMediaFile } from "../weixin/media.js";
import { createChannelClient, TEXT_CAPABILITIES } from "./client.js";
import { ChannelContextExpiredError } from "./errors.js";
import type { ChannelClient, ChannelTextClient } from "./types.js";

export function adaptLegacyClient(driver: ChannelTextClient, options: {
  inboundDir: string; maxInboundBytes: number; cdnBaseUrl?: string; mediaFetch?: FetchLike;
}): ChannelClient {
  if (driver.capabilities && "channel" in driver) return driver as ChannelClient;
  const api = driver as ChannelTextClient & Partial<WeixinApiClient>;
  const available = (yes: unknown) => yes ? "available" as const : "not-implemented" as const;
  const native = Object.fromEntries(["sendText", "startTextStream", "updateTextStream", "sendImage", "sendActionCard",
    "updateActionCard", "sendTaskCard", "updateTaskCard", "sendTyping", "sendMedia"].flatMap((name) => {
    const method = driver[name as keyof ChannelTextClient];
    return typeof method === "function" ? [[name, method.bind(driver)]] : [];
  })) as unknown as ChannelTextClient;
  return createChannelClient("weixin", {
    ...TEXT_CAPABILITIES,
    inbound: { image: "available", file: "available", video: "available", audio: "available" },
    outbound: { image: available(driver.sendImage || (api.getUploadUrl && api.sendImageMessage)),
      file: available(api.getUploadUrl && api.sendFileMessage), video: available(api.getUploadUrl && api.sendVideoMessage), audio: "not-implemented" },
    progress: available(driver.startTextStream && driver.updateTextStream), resumableProgress: Boolean(driver.resumableTextStream),
    actions: available(driver.sendActionCard), tasks: available(driver.sendTaskCard),
    cardUpdates: available(driver.updateActionCard || driver.updateTaskCard), typing: available(driver.sendTyping)
  }, {
    ...native,
    async sendText(input) {
      try { return await driver.sendText(input); }
      catch (error) { if (isStaleContextError(error)) throw new ChannelContextExpiredError(); throw error; }
    },
    sendMedia: native.sendMedia ?? ((input) => sendLocalMediaFile({ client: api as WeixinApiClient,
      ...input, filePath: input.path, kind: input.kind as "image" | "file" | "video", fetch: options.mediaFetch })),
    resolveAttachments: async (message) => {
      const remote = (message.attachments ?? []).filter((attachment) => !attachment.path);
      const downloaded = await downloadInboundAttachments({ ...options, rootDir: options.inboundDir,
        maxBytes: options.maxInboundBytes, fetch: options.mediaFetch,
        senderId: message.senderId, messageId: message.id, attachments: remote });
      let index = 0;
      return (message.attachments ?? []).map((attachment) => attachment.path ? attachment : { ...attachment, ...downloaded[index++] });
    }
  });
}
