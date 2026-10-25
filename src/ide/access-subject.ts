import { z } from "zod";

const identifier = z.string().trim().min(1).max(300).regex(/^[^\s\x00-\x1f\x7f]+$/);
export const idePrincipalSchema = z.object({ accountId: identifier,
  channel: z.enum(["dingtalk", "feishu", "wecom", "weixin"]), providerId: identifier, actorId: identifier }).strict();
export type IDEPrincipal = z.infer<typeof idePrincipalSchema>;

/** Provenance, not another allowlist. A durable revocation epoch prevents a
 * removed and later re-added identity from reviving its old browser cookies. */
export const ideAccessSubjectSchema = z.object({ principal: idePrincipalSchema,
  basis: z.enum(["im-personal", "legacy-approver"]), epoch: z.number().int().nonnegative().safe() }).strict();
export type IDEAccessSubject = z.infer<typeof ideAccessSubjectSchema>;
export type IDEAccessAuthority = { isSubjectAllowed(subject: IDEAccessSubject): boolean };
