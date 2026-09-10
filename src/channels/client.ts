import fs from "node:fs";
import path from "node:path";
import { chunkText } from "../bridge/format.js";
import { ChannelCapabilityError, ChannelDeliveryError, ChannelPartialDeliveryError, InboundMediaTooLargeError } from "./errors.js";
import type { ChannelAttachment } from "./message.js";
import type { Capability, ChannelCapabilities, ChannelClient, ChannelTextClient, ChannelReceipt, ChannelDeliveryPart } from "./types.js";

export const NO_MEDIA = Object.freeze({ image: "not-implemented", file: "not-implemented", video: "not-implemented", audio: "not-implemented" } as const);
export const TEXT_CAPABILITIES: ChannelCapabilities = Object.freeze({
  tableLayout: "list",
  inbound: NO_MEDIA, outbound: NO_MEDIA, progress: "not-implemented", resumableProgress: false,
  actions: "not-implemented", tasks: "not-implemented", cardUpdates: "not-implemented", typing: "not-implemented"
});

/** Single location for capability enforcement, acknowledgement checking and card fallbacks. */
export function createChannelClient(channel: ChannelClient["channel"], capabilities: ChannelCapabilities, driver: ChannelTextClient): ChannelClient {
  const caps = Object.freeze({ ...capabilities, inbound: Object.freeze({ ...capabilities.inbound }), outbound: Object.freeze({ ...capabilities.outbound }) });
  const requireFeature = (feature: string, state: Capability) => {
    if (state !== "available") throw new ChannelCapabilityError(channel, feature, state);
  };
  const required = <T>(method: T | undefined, feature: string): T => {
    if (!method) throw new ChannelCapabilityError(channel, feature, "not-implemented");
    return method;
  };
  const acknowledged = async (operation: string, promise: Promise<ChannelReceipt>) => {
    const result = await promise;
    if (!result || typeof result.messageId !== "string" || !result.messageId.trim()) throw new ChannelDeliveryError(channel, operation);
    return result;
  };
  const sendText: ChannelClient["sendText"] = (input) => acknowledged("sendText", driver.sendText(input));
  const fallback = async (toUserId: string, text: string, contextToken?: string) => {
    const parts: ChannelDeliveryPart[] = [];
    try {
      for (const chunk of chunkText(text)) {
        const result = await sendText({ toUserId, text: chunk, ...(contextToken ? { contextToken } : {}) });
        parts.push({ messageId: result.messageId, text: chunk });
      }
    } catch (error) { throw new ChannelPartialDeliveryError(parts, error); }
    return { messageId: parts.at(-1)!.messageId, parts };
  };
  return {
    channel, capabilities: caps, resumableTextStream: caps.resumableProgress, sendText,
    startTextStream(input) {
      requireFeature("progress", caps.progress);
      return acknowledged("startTextStream", required(driver.startTextStream, "progress").call(driver, input));
    },
    async updateTextStream(input) {
      requireFeature("progress", caps.progress);
      await required(driver.updateTextStream, "progress").call(driver, input);
    },
    sendActionCard(input) {
      // Rendering a table does not imply support for interactive buttons.
      return caps.actions === "available" || (input.card.table && caps.tableLayout === "markdown")
        ? acknowledged("sendActionCard", required(driver.sendActionCard, "actions").call(driver, input))
        : fallback(input.toUserId, input.card.fallbackText, input.contextToken);
    },
    sendTaskCard(input) {
      return caps.tasks === "available"
        ? acknowledged("sendTaskCard", required(driver.sendTaskCard, "tasks").call(driver, input))
        : fallback(input.toUserId, input.card.fallbackText, input.contextToken);
    },
    async updateActionCard(input) {
      requireFeature("cardUpdates", caps.cardUpdates);
      await required(driver.updateActionCard, "cardUpdates").call(driver, input);
    },
    async updateTaskCard(input) {
      requireFeature("cardUpdates", caps.cardUpdates);
      await required(driver.updateTaskCard, "cardUpdates").call(driver, input);
    },
    async sendTyping(input) {
      requireFeature("typing", caps.typing);
      await required(driver.sendTyping, "typing").call(driver, input);
    },
    sendMedia(input) {
      requireFeature(`outbound.${input.kind}`, caps.outbound[input.kind]);
      if (input.kind === "image" && driver.sendImage) return acknowledged("sendMedia", driver.sendImage({ toUserId: input.toUserId, path: input.path }));
      return acknowledged("sendMedia", required(driver.sendMedia, `outbound.${input.kind}`).call(driver, input));
    },
    async resolveAttachments(message) {
      const attachments = message.attachments ?? [];
      for (const attachment of attachments) requireFeature(`inbound.${attachment.kind}`, caps.inbound[attachment.kind]);
      if (driver.resolveAttachments) return driver.resolveAttachments(message);
      if (attachments.some((item) => !item.path)) throw new ChannelCapabilityError(channel, "resolveAttachments", "not-implemented");
      return attachments;
    }
  };
}

/** Shared inbound boundary: disallow traversal/symlink escapes and oversized files. */
export function validateLocalAttachments(attachments: ChannelAttachment[], rootDir: string, maxBytes: number): Array<ChannelAttachment & { path: string }> {
  if (!attachments.length) return [];
  const root = fs.realpathSync(rootDir);
  return attachments.map((attachment) => {
    if (!attachment.path) throw new Error("Channel adapter did not resolve an inbound attachment");
    const resolved = fs.realpathSync(attachment.path);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("inbound attachment path is outside its account directory");
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error("inbound attachment is not a regular file");
    if (stat.size > maxBytes) throw new InboundMediaTooLargeError(maxBytes, stat.size);
    return { ...attachment, path: resolved };
  });
}
