import type { ChannelKind } from "../weixin/accounts.js";
import { resolveWebhookProvider, type WebhookProvider } from "./webhook-provider.js";

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
  readonly webhookProvider?: WebhookProvider;
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

function createNotificationText(channel: ChannelKind, message: ChannelMessage): string {
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
  return lines.join("\n");
}

function truncateCharacters(value: string, maximumCharacters: number): string {
  return Array.from(value).slice(0, maximumCharacters).join("");
}

function createProviderPayload(provider: Exclude<WebhookProvider, "generic">, text: string): object {
  if (provider === "wecom") {
    return { msgtype: "text", text: { content: truncateUtf8(text, 2_048) } };
  }
  if (provider === "feishu") {
    return { msg_type: "text", content: { text: truncateUtf8(text, 20_000) } };
  }
  if (provider === "dingtalk") {
    return {
      msgtype: "text",
      text: { content: truncateUtf8(text, 20_000) },
      at: { isAtAll: false }
    };
  }
  if (provider === "slack") return { text: truncateCharacters(text, 4_000) };
  return { content: truncateCharacters(text, 2_000) };
}

export class ChannelMessageWebhook {
  private webhookUrl: string | undefined;
  private webhookProvider: WebhookProvider | undefined;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: ChannelMessageWebhookOptions) {
    this.webhookUrl = options.webhookUrl;
    this.webhookProvider = options.webhookProvider;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  configure(webhookUrl?: string, webhookProvider?: WebhookProvider): void {
    this.webhookUrl = webhookUrl;
    this.webhookProvider = webhookProvider;
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
    const provider = resolveWebhookProvider(this.webhookProvider, webhookUrl);
    const payload = provider === "generic"
      ? genericPayload
      : createProviderPayload(provider, createNotificationText(this.options.channel, message));
    this.deliver(webhookUrl, payload, provider).catch((error: unknown) => {
      console.warn("[codex-channel-bridge] webhook delivery failed", {
        accountId: this.options.accountId,
        direction: message.direction,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async deliver(webhookUrl: string, payload: object, provider: WebhookProvider): Promise<void> {
    const response = await this.fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new ChannelMessageWebhookDeliveryError(response.status);
    if (provider === "generic" || provider === "slack" || provider === "discord") return;
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new ChannelMessageWebhookBusinessError(-1, "invalid response");
    }
    if (!result || typeof result !== "object") {
      throw new ChannelMessageWebhookBusinessError(-1, "invalid response");
    }
    if (provider === "feishu") {
      const code = "code" in result && typeof result.code === "number"
        ? result.code
        : "StatusCode" in result && typeof result.StatusCode === "number"
          ? result.StatusCode
          : undefined;
      if (code === undefined) throw new ChannelMessageWebhookBusinessError(-1, "invalid response");
      if (code !== 0) {
        const message = "msg" in result && typeof result.msg === "string"
          ? result.msg
          : "StatusMessage" in result && typeof result.StatusMessage === "string"
            ? result.StatusMessage
            : "unknown error";
        throw new ChannelMessageWebhookBusinessError(code, message);
      }
      return;
    }
    if (!("errcode" in result) || typeof result.errcode !== "number") {
      throw new ChannelMessageWebhookBusinessError(-1, "invalid response");
    }
    if (result.errcode !== 0) {
      const message = "errmsg" in result && typeof result.errmsg === "string" ? result.errmsg : "unknown error";
      throw new ChannelMessageWebhookBusinessError(result.errcode, message);
    }
  }
}
