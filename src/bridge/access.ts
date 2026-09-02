export type AccessDecision =
  | { allowed: true; message: string }
  | { allowed: false; message: string };

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
