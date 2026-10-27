import { z } from "zod";

import { channelPrincipalSchema } from "../channels/principal.js";
export const idePrincipalSchema = channelPrincipalSchema;
export type IDEPrincipal = z.infer<typeof idePrincipalSchema>;

/** Provenance, not another allowlist. A durable revocation epoch prevents a
 * removed and later re-added identity from reviving its old browser cookies. */
export const ideAccessSubjectSchema = z.object({ principal: idePrincipalSchema,
  basis: z.enum(["im-personal", "legacy-approver"]), epoch: z.number().int().nonnegative().safe() }).strict();
export type IDEAccessSubject = z.infer<typeof ideAccessSubjectSchema>;
export type IDEAccessAuthority = { isSubjectAllowed(subject: IDEAccessSubject): boolean };
