import { ChannelDeliveryError } from "./errors.js";

/** Feishu's SDK can resolve HTTP 200 with a nonzero business code. */
export function assertFeishuSuccess(result: unknown, operation: string): void {
  if (!result || typeof result !== "object") throw new ChannelDeliveryError("feishu", operation);
  const code = (result as { code?: unknown }).code;
  if (code !== undefined && code !== 0) throw new ChannelDeliveryError("feishu", operation, String(code));
}

export function feishuMessageReceipt(result: unknown, operation: string): { messageId: string } {
  assertFeishuSuccess(result, operation);
  const id = (result as { data?: { message_id?: unknown } }).data?.message_id;
  if (typeof id !== "string" || !id.trim()) throw new ChannelDeliveryError("feishu", operation);
  return { messageId: id };
}
