export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CodexCreditsBalance = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type CodexSpendLimit = {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
};

export type CodexAccountBalance = {
  limitId?: string;
  limitName?: string;
  planType?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  credits?: CodexCreditsBalance;
  individualLimit?: CodexSpendLimit;
  spendControlReached?: boolean;
};

export function parseAccountRateLimits(value: unknown): CodexAccountBalance {
  const response = asRecord(value);
  const snapshot = asRecord(response?.rateLimits);
  if (!snapshot) {
    throw new Error("Codex app-server did not return account rate limits");
  }
  return compact({
    limitId: stringValue(snapshot.limitId),
    limitName: stringValue(snapshot.limitName),
    planType: stringValue(snapshot.planType),
    primary: parseWindow(snapshot.primary),
    secondary: parseWindow(snapshot.secondary),
    credits: parseCredits(snapshot.credits),
    individualLimit: parseSpendLimit(snapshot.individualLimit),
    spendControlReached: booleanValue(snapshot.spendControlReached)
  });
}

export function formatAccountBalance(balance: CodexAccountBalance): string {
  const lines = ["Codex 当前账号用量"];
  if (balance.planType) lines.push(`套餐：${formatPlan(balance.planType)}`);
  if (balance.limitName && balance.limitName.toLowerCase() !== "codex") {
    lines.push(`额度：${balance.limitName}`);
  }
  if (balance.primary) lines.push(formatWindow(balance.primary));
  if (balance.secondary) lines.push(formatWindow(balance.secondary));
  if (balance.individualLimit) {
    lines.push(`消费额度：剩余 ${formatPercent(balance.individualLimit.remainingPercent)}（已用 ${balance.individualLimit.used} / ${balance.individualLimit.limit}）`);
  }
  if (balance.credits) lines.push(formatCredits(balance.credits));
  if (balance.spendControlReached) lines.push("消费额度已用完");
  if (lines.length === 1) lines.push("当前 Codex 账号未提供可用的额度信息。");
  return lines.join("\n");
}

function formatWindow(window: CodexRateLimitWindow): string {
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const reset = window.resetsAt ? `（${formatResetTime(window.resetsAt)} 重置）` : "";
  return `${formatWindowDuration(window.windowDurationMins)}：剩余 ${formatPercent(remaining)}${reset}`;
}

function formatWindowDuration(minutes: number | null): string {
  if (!minutes) return "额度";
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}

function formatResetTime(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1_000);
  if (Number.isNaN(date.getTime())) return "未知时间";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatCredits(credits: CodexCreditsBalance): string {
  if (credits.unlimited) return "Credits：无限";
  if (credits.hasCredits && credits.balance !== null) return `Credits：${credits.balance}`;
  return "Credits：无可用余额";
}

function formatPlan(planType: string): string {
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function parseWindow(value: unknown): CodexRateLimitWindow | undefined {
  const record = asRecord(value);
  const usedPercent = numberValue(record?.usedPercent);
  if (!record || usedPercent === undefined) return undefined;
  return {
    usedPercent,
    windowDurationMins: nullableNumber(record.windowDurationMins),
    resetsAt: nullableNumber(record.resetsAt)
  };
}

function parseCredits(value: unknown): CodexCreditsBalance | undefined {
  const record = asRecord(value);
  const hasCredits = booleanValue(record?.hasCredits);
  const unlimited = booleanValue(record?.unlimited);
  if (!record || hasCredits === undefined || unlimited === undefined) return undefined;
  return { hasCredits, unlimited, balance: nullableString(record.balance) };
}

function parseSpendLimit(value: unknown): CodexSpendLimit | undefined {
  const record = asRecord(value);
  const limit = stringValue(record?.limit);
  const used = stringValue(record?.used);
  const remainingPercent = numberValue(record?.remainingPercent);
  const resetsAt = numberValue(record?.resetsAt);
  if (!record || limit === undefined || used === undefined || remainingPercent === undefined || resetsAt === undefined) {
    return undefined;
  }
  return { limit, used, remainingPercent, resetsAt };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : stringValue(value) ?? null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : numberValue(value) ?? null;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
