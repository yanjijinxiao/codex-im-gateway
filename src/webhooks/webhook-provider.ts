export const WEBHOOK_PROVIDERS = [
  "generic",
  "wecom",
  "feishu",
  "dingtalk",
  "slack",
  "discord"
] as const;

export type WebhookProvider = typeof WEBHOOK_PROVIDERS[number];

export function isWebhookProvider(value: unknown): value is WebhookProvider {
  return typeof value === "string" && WEBHOOK_PROVIDERS.some((provider) => provider === value);
}

export function resolveWebhookProvider(
  configuredProvider: WebhookProvider | undefined,
  webhookUrl: string | undefined
): WebhookProvider {
  if (isWebhookProvider(configuredProvider)) return configuredProvider;
  if (!webhookUrl) return "generic";
  try {
    const url = new URL(webhookUrl);
    if (url.hostname === "qyapi.weixin.qq.com" && url.pathname === "/cgi-bin/webhook/send") return "wecom";
    if (
      (url.hostname === "open.feishu.cn" || url.hostname === "open.larksuite.com")
      && url.pathname.startsWith("/open-apis/bot/v2/hook/")
    ) return "feishu";
    if (url.hostname === "oapi.dingtalk.com" && url.pathname === "/robot/send") return "dingtalk";
    if (url.hostname === "hooks.slack.com" && url.pathname.startsWith("/services/")) return "slack";
    if (
      (url.hostname === "discord.com" || url.hostname === "discordapp.com")
      && /^\/api(?:\/v\d+)?\/webhooks\//.test(url.pathname)
    ) return "discord";
  } catch {
    return "generic";
  }
  return "generic";
}
