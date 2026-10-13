import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const routeSchema = z.object({ type: z.enum(["group", "user"]), targetId: z.string().min(1).max(1000),
  robotCode: z.string().min(1).max(200), clientId: z.string().min(1).max(200) }).strict();
export type DingTalkCardRoute = z.infer<typeof routeSchema>;

/** Public routing metadata only. Never persist sessionWebhook, tokens or messages. */
export class DingTalkCardRouting {
  private readonly routes = new Map<string, DingTalkCardRoute>();
  constructor(private readonly clientId: string, private readonly filePath?: string) {
    if (filePath && fs.existsSync(filePath)) {
      const parsed = z.record(z.string().max(1000), routeSchema).parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
      for (const [key, route] of Object.entries(parsed).slice(-1000)) if (route.clientId === clientId) this.routes.set(key, route);
    }
  }
  remember(conversationId: string, conversationType: string, staffId: string | undefined, robotCode: string): void {
    if (!conversationId || conversationId.length > 1000) return;
    const route = routeSchema.safeParse({ type: conversationType === "2" ? "group" : "user",
      targetId: conversationType === "2" ? conversationId : staffId, robotCode, clientId: this.clientId });
    if (!["1", "2"].includes(conversationType) || !route.success) return;
    this.routes.delete(conversationId); this.routes.set(conversationId, route.data);
    // An explicit staff ID also identifies a valid direct-message destination.
    if (staffId) this.routes.set(staffId, { ...route.data, type: "user", targetId: staffId });
    while (this.routes.size > 1000) this.routes.delete(this.routes.keys().next().value!);
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.routes)), { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    }
  }
  get(recipientId: string): DingTalkCardRoute | undefined { return this.routes.get(recipientId); }
}
