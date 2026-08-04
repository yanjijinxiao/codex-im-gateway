import type { ChannelKind } from "../weixin/accounts.js";

export type ChannelMessageAttachment = {
  readonly kind: "image" | "file" | "video" | "audio";
  readonly label: string;
};

export type InboundChannelMessage = {
  readonly direction: "inbound";
  readonly id: string;
  readonly senderId: string;
  readonly text: string;
  readonly attachments: readonly ChannelMessageAttachment[];
};

export type OutboundChannelMessage = {
  readonly direction: "outbound";
  readonly id: string;
  readonly recipientId: string;
  readonly text: string;
  readonly attachments: readonly ChannelMessageAttachment[];
};

export type ChannelMessage = InboundChannelMessage | OutboundChannelMessage;

type ChannelMessageWebhookOptions = {
  readonly accountId: string;
  readonly channel: ChannelKind;
  readonly webhookUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
};

class ChannelMessageWebhookDeliveryError extends Error {
  readonly name = "ChannelMessageWebhookDeliveryError";

  constructor(readonly status: number) {
    super(`Webhook returned HTTP ${status}`);
  }
}

export class ChannelMessageWebhook {
  private webhookUrl: string | undefined;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: ChannelMessageWebhookOptions) {
    this.webhookUrl = options.webhookUrl;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  configure(webhookUrl?: string): void {
    this.webhookUrl = webhookUrl;
  }

  publish(message: ChannelMessage): void {
    const webhookUrl = this.webhookUrl;
    if (!webhookUrl) return;
    const payload = {
      schemaVersion: 1,
      event: "channel.message",
      occurredAt: this.now().toISOString(),
      account: {
        id: this.options.accountId,
        channel: this.options.channel
      },
      message
    } as const;
    this.deliver(webhookUrl, payload).catch((error: unknown) => {
      console.warn("[codex-channel-bridge] webhook delivery failed", {
        accountId: this.options.accountId,
        direction: message.direction,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async deliver(webhookUrl: string, payload: object): Promise<void> {
    const response = await this.fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new ChannelMessageWebhookDeliveryError(response.status);
  }
}
