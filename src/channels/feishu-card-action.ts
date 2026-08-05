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

export function cardActionIdentity(event: Lark.CardActionEvent): string {
  const value = JSON.stringify(event.action.value ?? "");
  return crypto.createHash("sha256")
    .update(`${event.messageId}\n${event.operator.openId}\n${value}`)
    .digest("hex")
    .slice(0, 32);
}
