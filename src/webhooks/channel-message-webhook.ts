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

class ChannelMessageWebhookBusinessError extends Error {
  readonly name = "ChannelMessageWebhookBusinessError";

  constructor(readonly code: number, message: string) {
    super(`Webhook returned business error ${code}: ${message}`);
  }
}

function isWeComIncomingWebhook(webhookUrl: string): boolean {
  try {
    const url = new URL(webhookUrl);
    return url.hostname === "qyapi.weixin.qq.com" && url.pathname === "/cgi-bin/webhook/send";
  } catch {
    return false;
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maximumBytes; end > 0; end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      continue;
    }
  }
  return "";
}

function createWeComIncomingWebhookPayload(channel: ChannelKind, message: ChannelMessage): object {
  const counterparty = message.direction === "inbound"
    ? `发送者: ${message.senderId}`
    : `接收者: ${message.recipientId}`;
  const lines = [
    `[Codex Channel Bridge] ${message.direction === "inbound" ? "收到" : "发出"}消息`,
    `渠道: ${channel}`,
    counterparty,
    ...(message.text ? [`内容: ${message.text}`] : []),
    ...(message.attachments.length
      ? [`附件: ${message.attachments.map((attachment) => attachment.label).join(", ")}`]
      : [])
  ];
  return {
    msgtype: "text",
    text: {
      content: truncateUtf8(lines.join("\n"), 2_048)
    }
  };
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
    const genericPayload = {
      schemaVersion: 1,
      event: "channel.message",
      occurredAt: this.now().toISOString(),
      account: {
        id: this.options.accountId,
        channel: this.options.channel
      },
      message
    } as const;
    const weComIncomingWebhook = isWeComIncomingWebhook(webhookUrl);
    const payload = weComIncomingWebhook
      ? createWeComIncomingWebhookPayload(this.options.channel, message)
      : genericPayload;
    this.deliver(webhookUrl, payload, weComIncomingWebhook).catch((error: unknown) => {
      console.warn("[codex-channel-bridge] webhook delivery failed", {
        accountId: this.options.accountId,
        direction: message.direction,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async deliver(webhookUrl: string, payload: object, weComIncomingWebhook: boolean): Promise<void> {
    const response = await this.fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new ChannelMessageWebhookDeliveryError(response.status);
    if (!weComIncomingWebhook) return;
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("errcode" in result) || typeof result.errcode !== "number") {
      throw new ChannelMessageWebhookBusinessError(-1, "invalid response");
    }
    if (result.errcode !== 0) {
      const message = "errmsg" in result && typeof result.errmsg === "string" ? result.errmsg : "unknown error";
      throw new ChannelMessageWebhookBusinessError(result.errcode, message);
    }
  }
}
