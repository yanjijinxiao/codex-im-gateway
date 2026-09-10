import fs from "node:fs";
import { z } from "zod";

const entrySchema = z.object({
  hostId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  purpose: z.enum(["conversation", "probe"]),
  reason: z.string().trim().min(1)
}).strict();
const registrySchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) }).strict();

/** Gateway-owned classification, independent of backend lifecycle and IM channel.
 * Never infer purpose from a title, prompt, source=exec, or runtime status.
 */
export class SessionPurposeIndex {
  private readonly purposes = new Map<string, "conversation" | "probe">();

  constructor(entries: readonly z.infer<typeof entrySchema>[] = []) {
    for (const entry of entries) {
      const key = sessionKey(entry.threadId, entry.hostId);
      if (this.purposes.has(key)) throw new Error("Duplicate session purpose identity");
      this.purposes.set(key, entry.purpose);
    }
  }

  isProbe(threadId: string, hostId = "local"): boolean {
    return this.purposes.get(sessionKey(threadId, hostId)) === "probe";
  }
}

/** Read once per catalog refresh; missing means no classifications, not an error.
 * Do not create the file or rewrite backend session records during discovery.
 */
export function readSessionPurposes(file: string): SessionPurposeIndex {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new SessionPurposeIndex();
    throw new Error("Session purpose registry is unreadable");
  }
  try {
    return new SessionPurposeIndex(registrySchema.parse(JSON.parse(raw)).entries);
  } catch {
    // Avoid echoing deployment-local identities or malformed file contents.
    throw new Error("Invalid session purpose registry; expected version 1 and unique host/thread entries");
  }
}

function sessionKey(threadId: string, hostId: string): string {
  return JSON.stringify([hostId, threadId]);
}
