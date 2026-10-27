import crypto from "node:crypto";

import type * as Lark from "@larksuiteoapi/node-sdk";
import { z } from "zod";

const feishuFormActionEventSchema = z.object({
  action: z.object({
    form_value: z.record(z.string(), z.unknown()).optional()
  }).passthrough().optional()
}).passthrough();

export function formValueFromRawCardAction(rawEvent: unknown): unknown {
  const parsed = feishuFormActionEventSchema.safeParse(rawEvent);
  return parsed.success ? parsed.data.action?.form_value : undefined;
}

export function cardActionIdentity(event: Lark.CardActionEvent, command?: string): string {
  const value = command ?? JSON.stringify(event.action.value ?? "");
  return crypto.createHash("sha256")
    .update(JSON.stringify([event.chatId, event.messageId, event.operator.openId, value]))
    .digest("hex")
    .slice(0, 32);
}
