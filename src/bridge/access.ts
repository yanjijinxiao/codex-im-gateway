export type AccessDecision =
  | { allowed: true; message: string }
  | { allowed: false; message: string };

export type SessionRole = "viewer" | "participant" | "controller";
const ROLE_LEVEL: Record<SessionRole, number> = { viewer: 0, participant: 1, controller: 2 };
export function roleAllows(actual: SessionRole, required: SessionRole): boolean {
  return ROLE_LEVEL[actual] >= ROLE_LEVEL[required];
}

export function requiredCommandRole(name: string, arg = ""): SessionRole {
  if (name === "session" && /^detail(?:\s|$)/i.test(arg.trim())) return "viewer";
  if (["stop", "approve", "reject"].includes(name)) return "controller";
  if (name === "role") return arg.trim() ? "controller" : "viewer";
  if (name === "project" && /^(?:add|a|rename|rn|delete|d)\b/i.test(arg)) return "controller";
  if (["help", "status", "balance", "sessions", "history"].includes(name)) return "viewer";
  if (["project", "session", "model", "effort", "memory", "goal", "mode", "policy", "follow"].includes(name) && !arg.trim()) return "viewer";
  return "participant";
}

export type AccessControllerOptions = {
  allowedSenderIds?: string[];
  pairedSenderIds?: string[];
};

export class AccessController {
  private readonly configuredAllowlist: Set<string>;
  private readonly pairedSenderIds: Set<string>;

  constructor(options: AccessControllerOptions = {}) {
    this.configuredAllowlist = new Set(options.allowedSenderIds ?? []);
    this.pairedSenderIds = new Set(options.pairedSenderIds ?? []);
  }

  isAllowed(senderId: string): boolean {
    return this.configuredAllowlist.has(senderId) || this.pairedSenderIds.has(senderId);
  }

  requireAccess(senderId: string, conversationId: string = senderId): AccessDecision {
    // A conversation ID in the allowlist is an explicit group-wide ACL. Otherwise,
    // the individual actor must be allowed; card callbacks never inherit authority
    // merely because their reply target is a chat.
    if (this.isAllowed(senderId) || this.isAllowed(conversationId)) {
      return { allowed: true, message: "sender is allowed" };
    }

    return {
      allowed: false,
      message: `Access denied. Open the Codex IM Gateway management page and allow actor ${senderId} or conversation ${conversationId}`
    };
  }

  allow(senderId: string): void {
    this.pairedSenderIds.add(senderId);
  }

  remove(senderId: string): void {
    this.pairedSenderIds.delete(senderId);
    this.configuredAllowlist.delete(senderId);
  }

  listPairedSenderIds(): string[] {
    return [...this.pairedSenderIds].sort();
  }
}
