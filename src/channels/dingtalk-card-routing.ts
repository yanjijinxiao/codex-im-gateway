import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const routeSchema = z.object({ type: z.enum(["group", "user"]), targetId: z.string().min(1).max(1000),
  robotCode: z.string().min(1).max(200), clientId: z.string().min(1).max(200) }).strict();
const identitySchema = routeSchema.pick({ type: true, targetId: true, clientId: true }).extend({ name: z.string().min(1).max(120) }).strict();
export type DingTalkCardRoute = z.infer<typeof routeSchema> & { name?: string };

/** Public routing metadata only. Never persist sessionWebhook, tokens or messages. */
export class DingTalkCardRouting {
  private readonly routes = new Map<string, DingTalkCardRoute>();
  constructor(private readonly clientId: string, private readonly filePath?: string) {
    if (filePath && fs.existsSync(filePath)) {
      const parsed = z.record(z.string().max(1000), routeSchema).parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
      for (const [key, route] of Object.entries(parsed).slice(-1000)) if (route.clientId === clientId) this.routes.set(key, route);
      // Display-only cache is separate: older Gateway versions read the strict
      // routing file unchanged, and losing a name must never stop delivery.
      const identitiesPath = `${filePath}.identities.json`;
      if (fs.existsSync(identitiesPath)) {
        try {
          const identities = z.record(z.string().max(1000), identitySchema).parse(JSON.parse(fs.readFileSync(identitiesPath, "utf8")));
          for (const [key, identity] of Object.entries(identities).slice(-1000)) {
            const route = this.routes.get(key);
            if (route && identity.clientId === clientId && route.type === identity.type && route.targetId === identity.targetId) route.name = identity.name;
          }
        } catch { console.warn("[codex-im-gateway] ignored invalid conversation display cache; routing is unchanged"); }
      }
    }
  }
  remember(conversationId: string, conversationType: string, staffId: string | undefined, robotCode: string,
    identity: { conversationName?: string; actorName?: string } = {}): void {
    if (!conversationId || conversationId.length > 1000) return;
    const cleanName = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) || undefined : undefined;
    const name = cleanName(conversationType === "2" ? identity.conversationName : identity.actorName);
    const route = routeSchema.safeParse({ type: conversationType === "2" ? "group" : "user",
      targetId: conversationType === "2" ? conversationId : staffId, robotCode, clientId: this.clientId });
    if (!["1", "2"].includes(conversationType) || !route.success) return;
    const previous = this.routes.get(conversationId);
    const retainedName = previous?.type === route.data.type && previous.targetId === route.data.targetId ? previous.name : undefined;
    const namedRoute: DingTalkCardRoute = { ...route.data, ...(name ?? retainedName ? { name: name ?? retainedName } : {}) };
    this.routes.delete(conversationId); this.routes.set(conversationId, namedRoute);
    // An explicit staff ID also identifies a valid direct-message destination.
    // A group title must never become a member's private-chat name.
    if (staffId) this.routes.set(staffId, { ...route.data, type: "user", targetId: staffId,
      name: cleanName(identity.actorName) ?? (this.routes.get(staffId)?.type === "user" ? this.routes.get(staffId)?.name : undefined) });
    while (this.routes.size > 1000) this.routes.delete(this.routes.keys().next().value!);
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries([...this.routes].map(([id, { name: _name, ...route }]) => [id, route]))), { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      try {
        const identityPath = `${this.filePath}.identities.json`;
        const identities = Object.fromEntries([...this.routes].flatMap(([id, route]) => route.name
          ? [[id, { type: route.type, targetId: route.targetId, clientId: route.clientId, name: route.name }]] : []));
        fs.writeFileSync(`${identityPath}.${process.pid}.tmp`, JSON.stringify(identities), { mode: 0o600 });
        fs.renameSync(`${identityPath}.${process.pid}.tmp`, identityPath);
      } catch { console.warn("[codex-im-gateway] could not persist conversation display cache; routing is unchanged"); }
    }
  }
  get(recipientId: string): DingTalkCardRoute | undefined { return this.routes.get(recipientId); }
}
