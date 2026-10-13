import { ChannelDeliveryError } from "./errors.js";

/** Feishu's SDK can resolve HTTP 200 with a nonzero business code. */
export function assertFeishuSuccess(result: unknown, operation: string): void {
  if (!result || typeof result !== "object") throw new ChannelDeliveryError("feishu", operation);
  const code = (result as { code?: unknown }).code;
  // The image-upload SDK also supports a decoded image_key-only response.
  if (operation === "uploadImage" && code === undefined &&
    typeof (result as { image_key?: unknown }).image_key === "string" &&
    (result as { image_key: string }).image_key.trim()) return;
  if (code !== 0) throw new ChannelDeliveryError("feishu", operation, code === undefined ? undefined : String(code));
}

export function feishuMessageReceipt(result: unknown, operation: string): { messageId: string } {
  assertFeishuSuccess(result, operation);
  const id = (result as { data?: { message_id?: unknown } }).data?.message_id;
  if (typeof id !== "string" || !id.trim()) throw new ChannelDeliveryError("feishu", operation);
  return { messageId: id };
}
