import fs from "node:fs";
import path from "node:path";

import {
  normalizeChannelModeSettings,
  type ChannelModeSettings
} from "../channels/channel-mode-settings.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { StatePaths } from "../state/paths.js";
import { resolveWebhookProvider, type WebhookProvider } from "../webhooks/webhook-provider.js";

export type WeixinAccount = {
  channel?: "weixin";
  accountId: string;
  botId?: string;
  token: string;
  baseUrl: string;
  cdnBaseUrl: string;
  userId?: string;
  displayName?: string;
  webhookUrl?: string;
  webhookProvider?: WebhookProvider;
  modeSettings?: ChannelModeSettings;
  savedAt: string;
  enabled: boolean;
};

export type WeComAccount = {
  channel: "wecom";
  accountId: string;
  botId: string;
  secret: string;
  displayName?: string;
  webhookUrl?: string;
  webhookProvider?: WebhookProvider;
  modeSettings?: ChannelModeSettings;
  savedAt: string;
  enabled: boolean;
};

export type FeishuAccount = {
  channel: "feishu";
  accountId: string;
  appId: string;
  appSecret: string;
  displayName?: string;
  webhookUrl?: string;
  webhookProvider?: WebhookProvider;
  modeSettings?: ChannelModeSettings;
  savedAt: string;
  enabled: boolean;
};

export type ChannelAccount = WeixinAccount | WeComAccount | FeishuAccount;
export type ChannelKind = "weixin" | "wecom" | "feishu";

export type RetainedWeixinAccount = {
  accountId: string;
  userId: string;
  displayName?: string;
  modeSettings?: ChannelModeSettings;
  retainedAt: string;
};

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export function normalizeAccountId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function accountChannel(account: ChannelAccount): ChannelKind {
  return account.channel ?? "weixin";
}

export function saveAccount(paths: StatePaths, account: ChannelAccount): void {
  ensureDir(paths.accountsDir);
  writeJsonFile(path.join(paths.accountsDir, `${normalizeAccountId(account.accountId)}.json`), account);
}

export type SaveScannedAccountResult = {
  account: WeixinAccount;
  reusedExisting: boolean;
};

export function saveScannedAccount(
  paths: StatePaths,
  scanned: WeixinAccount,
  targetAccountId?: string
): SaveScannedAccountResult {
  const accounts = listAccounts(paths).filter((account): account is WeixinAccount => accountChannel(account) === "weixin");
  const loadedTarget = targetAccountId ? loadAccount(paths, targetAccountId) : undefined;
  const target = loadedTarget && accountChannel(loadedTarget) === "weixin" ? loadedTarget as WeixinAccount : undefined;
  if (target?.userId && scanned.userId && target.userId !== scanned.userId) {
    throw new Error("The scanned WeChat account does not match the existing account");
  }
  const exact = accounts.find((account) => account.accountId === scanned.accountId);
  const sameUsers = scanned.userId
    ? accounts.filter((account) => account.userId === scanned.userId)
    : [];
  const retainedMatches = scanned.userId
    ? listRetainedAccounts(paths).filter((account) => account.userId === scanned.userId)
    : [];
  const retained = !target && !exact && sameUsers.length === 0 && retainedMatches.length === 1
    ? retainedMatches[0]
    : undefined;
  const existing = target ?? exact ?? (sameUsers.length === 1 ? sameUsers[0] : undefined);
  const previous = existing ?? retained;
  const botId = scanned.botId ?? scanned.accountId;
  const account: WeixinAccount = previous ? {
    ...scanned,
    accountId: previous.accountId,
    botId,
    userId: scanned.userId ?? previous.userId,
    ...(previous.displayName ? { displayName: previous.displayName } : {}),
    ...(existing?.webhookUrl ? { webhookUrl: existing.webhookUrl } : {}),
    ...(existing?.webhookProvider ? { webhookProvider: existing.webhookProvider } : {}),
    ...(previous.modeSettings ? { modeSettings: normalizeChannelModeSettings(previous.modeSettings) } : {}),
    enabled: true
  } : { ...scanned, botId };
  saveAccount(paths, account);
  if (retained) forgetRetainedAccount(paths, retained);
  return { account, reusedExisting: Boolean(previous) };
}

export function listRetainedAccounts(paths: StatePaths): RetainedWeixinAccount[] {
  const value = readJsonFile<unknown>(paths.retainedAccountsPath, []);
  if (!Array.isArray(value)) return [];
  return value.filter((account): account is RetainedWeixinAccount => Boolean(
    account
    && typeof account === "object"
    && typeof account.accountId === "string"
    && typeof account.userId === "string"
    && typeof account.retainedAt === "string"
    && (account.displayName === undefined || typeof account.displayName === "string")
    && (account.modeSettings === undefined || typeof account.modeSettings === "object")
  )).map((account) => ({
    ...account,
    ...(account.modeSettings ? { modeSettings: normalizeChannelModeSettings(account.modeSettings) } : {})
  })).sort((a, b) => a.accountId.localeCompare(b.accountId));
}

export function retainAccountHistory(paths: StatePaths, account: WeixinAccount): RetainedWeixinAccount {
  if (!account.userId) {
    throw new Error("该微信账号缺少稳定用户标识，无法保留会话历史；请选择彻底删除");
  }
  const retained: RetainedWeixinAccount = {
    accountId: account.accountId,
    userId: account.userId,
    ...(account.displayName ? { displayName: account.displayName } : {}),
    ...(account.modeSettings ? { modeSettings: normalizeChannelModeSettings(account.modeSettings) } : {}),
    retainedAt: new Date().toISOString()
  };
  const accounts = listRetainedAccounts(paths)
    .filter((candidate) => candidate.accountId !== account.accountId && candidate.userId !== account.userId);
  accounts.push(retained);
  writeJsonFile(paths.retainedAccountsPath, accounts.sort((a, b) => a.accountId.localeCompare(b.accountId)));
  return retained;
}

export function forgetRetainedAccount(
  paths: StatePaths,
  account: Pick<RetainedWeixinAccount, "accountId" | "userId">
): void {
  const accounts = listRetainedAccounts(paths);
  const remaining = accounts.filter((candidate) => (
    candidate.accountId !== account.accountId && candidate.userId !== account.userId
  ));
  if (remaining.length === accounts.length) return;
  if (remaining.length) {
    writeJsonFile(paths.retainedAccountsPath, remaining);
  } else {
    fs.rmSync(paths.retainedAccountsPath, { force: true });
  }
}

export function listAccounts(paths: StatePaths): ChannelAccount[] {
  ensureDir(paths.accountsDir);
  return fs.readdirSync(paths.accountsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonFile<ChannelAccount>(path.join(paths.accountsDir, name), undefined as never))
    .map((account) => ({
      ...account,
      enabled: account.enabled !== false,
      modeSettings: normalizeChannelModeSettings(account.modeSettings)
    }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}

export function setAccountEnabled(paths: StatePaths, accountId: string, enabled: boolean): ChannelAccount {
  const account = loadAccount(paths, accountId);
  const updated = { ...account, enabled };
  saveAccount(paths, updated);
  return updated;
}

export type AccountSettingsPatch = {
  displayName: string;
  webhookUrl?: string | null;
  webhookProvider?: WebhookProvider;
};

export function setAccountSettings(paths: StatePaths, accountId: string, patch: AccountSettingsPatch): ChannelAccount {
  const account = loadAccount(paths, accountId);
  const updated: ChannelAccount = { ...account };
  const displayName = patch.displayName.trim();
  if (displayName) {
    updated.displayName = displayName;
  } else {
    delete updated.displayName;
  }
  if (patch.webhookUrl !== undefined) {
    const webhookUrl = patch.webhookUrl?.trim();
    if (webhookUrl) updated.webhookUrl = webhookUrl;
    else delete updated.webhookUrl;
  }
  if (patch.webhookProvider !== undefined) updated.webhookProvider = patch.webhookProvider;
  saveAccount(paths, updated);
  return updated;
}

export function setAccountModeSettings(
  paths: StatePaths,
  accountId: string,
  modeSettings: ChannelModeSettings
): ChannelAccount {
  const account = loadAccount(paths, accountId);
  const updated: ChannelAccount = {
    ...account,
    modeSettings: normalizeChannelModeSettings(modeSettings)
  };
  saveAccount(paths, updated);
  return updated;
}

export function deleteAccount(paths: StatePaths, accountId: string): void {
  const account = loadAccount(paths, accountId);
  fs.rmSync(path.join(paths.accountsDir, `${normalizeAccountId(account.accountId)}.json`), { force: true });
}

export type PublicChannelAccount =
  | (Omit<WeixinAccount, "token" | "webhookUrl"> & {
      channel: "weixin";
      webhookConfigured: boolean;
      webhookProvider: WebhookProvider;
    })
  | (Omit<WeComAccount, "secret" | "webhookUrl"> & {
      webhookConfigured: boolean;
      webhookProvider: WebhookProvider;
    })
  | (Omit<FeishuAccount, "appSecret" | "webhookUrl"> & {
      webhookConfigured: boolean;
      webhookProvider: WebhookProvider;
    });

export type PublicWeixinAccount = PublicChannelAccount;

export function publicAccount(account: ChannelAccount): PublicChannelAccount {
  if (accountChannel(account) === "wecom") {
    const { secret: _secret, webhookUrl, ...safe } = account as WeComAccount;
    return {
      ...safe,
      webhookProvider: resolveWebhookProvider(account.webhookProvider, webhookUrl),
      webhookConfigured: Boolean(webhookUrl)
    };
  }
  if (accountChannel(account) === "feishu") {
    const { appSecret: _appSecret, webhookUrl, ...safe } = account as FeishuAccount;
    return {
      ...safe,
      webhookProvider: resolveWebhookProvider(account.webhookProvider, webhookUrl),
      webhookConfigured: Boolean(webhookUrl)
    };
  }
  const { token: _token, webhookUrl, ...safe } = account as WeixinAccount;
  return {
    ...safe,
    channel: "weixin",
    webhookProvider: resolveWebhookProvider(account.webhookProvider, webhookUrl),
    webhookConfigured: Boolean(webhookUrl)
  };
}

export function loadAccount(paths: StatePaths, accountId?: string): ChannelAccount {
  const accounts = listAccounts(paths);
  if (accounts.length === 0) {
    throw new Error("No WeChat account found. Open Codex Channel Bridge and add an account.");
  }
  if (!accountId) {
    if (accounts.length > 1) {
      throw new Error(`Multiple accounts found. Pass --account <id>. Available: ${accounts.map((a) => a.accountId).join(", ")}`);
    }
    return accounts[0];
  }
  const normalized = normalizeAccountId(accountId);
  const found = accounts.find((account) => normalizeAccountId(account.accountId) === normalized || account.accountId === accountId);
  if (!found) {
    throw new Error(`WeChat account not found: ${accountId}`);
  }
  return found;
}
