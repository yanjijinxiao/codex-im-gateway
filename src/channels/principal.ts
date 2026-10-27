import { z } from "zod";

/** Provider-confirmed human identity. A conversation or session role is not a
 * substitute; every authority rechecks the current account/provider binding. */
const identifier = z.string().trim().min(1).max(300).regex(/^[^\s\x00-\x1f\x7f]+$/);
export const channelPrincipalSchema = z.object({ accountId: identifier,
  channel: z.enum(["dingtalk", "feishu", "wecom", "weixin"]), providerId: identifier, actorId: identifier }).strict();
export type ChannelPrincipal = z.infer<typeof channelPrincipalSchema>;
