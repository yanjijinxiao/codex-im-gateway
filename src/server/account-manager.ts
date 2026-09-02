import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseActionBlocks } from "../bridge/actions.js";
import { createCodexChannelIntentResolver } from "../bridge/ai-channel-intent.js";
import type {
  ChannelCapabilityNavigation,
  ChannelCapabilityProvider
} from "../bridge/channel-capability.js";
import { createInstalledSkillCapabilitiesProvider } from "../bridge/installed-skill-capabilities.js";
import { buildPromptParts, buildPromptPreview, parsePrompt } from "../bridge/format.js";
import type { PromptBufferItem } from "../bridge/prompt-buffer.js";
import { BridgeService } from "../bridge/service.js";
import {
  userFacingMessageHandlingError,
  wasMessageHandlingErrorReported
} from "../bridge/errors.js";
import { DingTalkChannelAdapter } from "../channels/dingtalk.js";
import { FeishuChannelAdapter } from "../channels/feishu.js";
import {
  normalizeChannelModeSettings,
  type ChannelModeSettingsUpdate
} from "../channels/channel-mode-settings.js";
import type { ChannelAdapter, ChannelTextClient } from "../channels/types.js";
import { createTaskCard, type ChannelTaskCard } from "../channels/task-card.js";
import { WeComChannelAdapter } from "../channels/wecom.js";
import type {
  CodexBridgeBackend,
  CodexHistoryMessage,
  CodexModelOption,
  CodexRuntimeInfo
} from "../codex/backend.js";
import { assertCodexThreadRunnable } from "../codex/backend.js";
import { CodexBackendRouter } from "../codex/runner.js";
import {
  LlmWikiMcpClientPool,
  type LlmWikiInspection
} from "../knowledge/llm-wiki-mcp-client.js";
import type { CodexAccountBalance } from "../codex/account-balance.js";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../codex/approval.js";
import { isWorkspaceAllowed, loadConfig, type CodexImGatewayConfig } from "../state/config.js";
import { accountStatePaths, type StatePaths } from "../state/paths.js";
import {
  CodexSessionCompletionMonitor,
  type CodexSessionCompletion,
  type CodexSessionTask
} from "./codex-session-monitor.js";
import {
  CodexDesktopApprovalMonitor,
  type CodexDesktopApproval
} from "./codex-desktop-approval-monitor.js";
import {
  RuntimeStateStore,
  type ManagedProject,
  type ManagedKnowledgeBase,
  type ManagedSession,
  type ProjectNotificationTarget,
  type SessionRuntimeOverrides
} from "../state/runtime-state.js";
import {
  listCodexProjectCandidates,
  listCodexCliProjectCandidates,
  projectCandidatesFromBackendCatalog,
  type CodexProjectCandidate
} from "./codex-projects.js";
import {
  accountChannel,
  deleteAccount,
  forgetRetainedAccount,
  listAccounts,
  loadAccount,
  migrateLegacyDingTalkCardProfiles,
  publicAccount,
  retainAccountHistory,
  saveAccount,
  setAccountModeSettings,
  setAccountSettings,
  setAccountEnabled,
  normalizeAccountId,
  type ChannelAccount,
  type AccountSettingsPatch,
  type DingTalkAccount,
  type FeishuAccount,
  type PublicWeixinAccount,
  type WeComAccount,
  type WeixinAccount
} from "../weixin/accounts.js";
import { WeixinApiClient } from "../weixin/api.js";
import { monitorWeixin, type MonitorOptions } from "../weixin/monitor.js";
import { inferMediaKind, sanitizeFileName } from "../weixin/media.js";
import {
  TaskboardClient,
  type TaskboardComment,
  type TaskboardEvent,
  type TaskboardIssue,
  type TaskboardStatus
} from "../taskboard/client.js";
import {
  TaskboardWorkbench,
  type TaskboardIssueDetail,
  type TaskboardIssueSummary
} from "../taskboard/workbench.js";
import {
  syncFeishuShortcutMenu,
  type FeishuShortcutMenuSyncResult
} from "../channels/feishu-menu-sync.js";
import { ChannelMessageWebhook } from "../webhooks/channel-message-webhook.js";
import { resolveChannelModeSettings } from "./channel-mode-settings.js";

export type AccountRunStatus = "stopped" | "starting" | "running" | "error";

export type AccountSummary = PublicWeixinAccount & {
  status: AccountRunStatus;
  error?: string;
  pairedSenderIds: string[];
  lastActiveSenderId?: string;
  lastActiveActorId?: string;
  lastAuthorizedSenderId?: string;
  lastAuthorizedActorId?: string;
  sessionCount: number;
};

export type AccountSession = ManagedSession & {
  accountId: string;
  active: boolean;
  responding: boolean;
};

export type AccountProject = ManagedProject & {
  accountId: string;
  sessionCount: number;
  boundSessions: AccountProjectSession[];
  activeTaskCount: number;
  runningTasks: AccountProjectTask[];
};

export type AccountKnowledgeBase = ManagedKnowledgeBase & {
  accountId: string;
  boundProjects: Array<{ id: string; name: string }>;
  channelDefault: boolean;
};

export type AccountProjectSession = {
  id: string;
  title: string;
  active: boolean;
  hasThread: boolean;
  updatedAt: string;
};

export type AccountProjectTask = {
  id: string;
  title: string;
  source: "managed" | "codex";
  startedAt: string;
  updatedAt: string;
};

export type TaskboardIntegrationStatus = {
  enabled: boolean;
  managed: boolean;
  available: boolean;
  url: string;
  error?: string;
  projects: Array<{
    accountId: string;
    projectId: string;
    projectName: string;
    workspace: string;
    taskboardProjectId?: string;
    taskboardProjectName?: string;
    issueCount?: number;
  }>;
};

export type SessionChatResult = {
  threadId: string;
  message: SessionHistoryMessage;
};

export type SessionUpload = {
  name: string;
  data: Buffer;
};

export type SessionMessageAttachment = {
  index: number;
  type: "image" | "file" | "video";
  name: string;
  size?: number;
  available: boolean;
};

export type SessionHistoryMessage = CodexHistoryMessage & {
  attachments: SessionMessageAttachment[];
};

export type SessionAttachmentFile = SessionMessageAttachment & {
  path: string;
};

type InternalSessionHistoryMessage = CodexHistoryMessage & {
  attachments: SessionAttachmentFile[];
};

type RuntimeEntry = {
  status: AccountRunStatus;
  controller?: AbortController;
  task?: Promise<void>;
  service?: BridgeService;
  store?: RuntimeStateStore;
  client?: ChannelTextClient;
  webhook?: ChannelMessageWebhook;
  error?: string;
};

type DirectChannelText = {
  readonly recipientId: string;
  readonly text: string;
  readonly contextToken?: string;
};

export type AccountManagerOptions = {
  paths: StatePaths;
  configProvider?: () => CodexImGatewayConfig;
  clientFactory?: (account: WeixinAccount) => WeixinApiClient;
  channelFactory?: (
    account: WeComAccount | FeishuAccount | DingTalkAccount,
    options: { inboundDir: string }
  ) => ChannelAdapter;
  bridgeFactory?: (input: ConstructorParameters<typeof BridgeService>[0]) => BridgeService;
  monitor?: (options: MonitorOptions) => Promise<void>;
  runnerFactory?: (config: CodexImGatewayConfig) => CodexBridgeBackend;
  codexSessionMonitorFactory?: (
    handlers: {
      onCompletion: (completion: CodexSessionCompletion) => Promise<void>;
      onTaskChanged: (task: CodexSessionTask) => void;
    }
  ) => CodexSessionCompletionMonitor;
  codexDesktopApprovalMonitorFactory?: (
    handlers: {
      onApproval: (approval: CodexDesktopApproval) => Promise<CodexApprovalDecision | undefined>;
    }
  ) => CodexDesktopApprovalMonitor;
  taskboardClientFactory?: (url: string) => TaskboardClient;
  llmWiki?: LlmWikiMcpClientPool;
  channelCapabilities?: ChannelCapabilityProvider;
};

export class AccountManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly respondingSessions = new Map<string, number>();
  private readonly configProvider: () => CodexImGatewayConfig;
  private readonly clientFactory: (account: WeixinAccount) => WeixinApiClient;
  private readonly bridgeFactory: (input: ConstructorParameters<typeof BridgeService>[0]) => BridgeService;
  private readonly channelFactory: NonNullable<AccountManagerOptions["channelFactory"]>;
  private readonly monitor: (options: MonitorOptions) => Promise<void>;
  private readonly runnerFactory: (config: CodexImGatewayConfig) => CodexBridgeBackend;
  private readonly codexSessionMonitorFactory: NonNullable<AccountManagerOptions["codexSessionMonitorFactory"]>;
  private readonly codexDesktopApprovalMonitorFactory: NonNullable<AccountManagerOptions["codexDesktopApprovalMonitorFactory"]>;
  private readonly externalCodexTasks = new Map<string, CodexSessionTask>();
  private readonly managedTurnCompletions = new Set<string>();
  private readonly taskboardClientFactory: (url: string) => TaskboardClient;
  private readonly taskboardWorkbench: TaskboardWorkbench;
  private readonly recentTaskboardNotifications = new Map<string, number>();
  private readonly llmWiki: LlmWikiMcpClientPool;
  private readonly channelCapabilities: ChannelCapabilityProvider;
  private runner?: CodexBridgeBackend;
  private codexSessionMonitor?: CodexSessionCompletionMonitor;
  private codexDesktopApprovalMonitor?: CodexDesktopApprovalMonitor;
  private taskboard?: TaskboardClient;
  private taskboardController?: AbortController;
  private taskboardTask?: Promise<void>;

  constructor(private readonly options: AccountManagerOptions) {
    this.configProvider = options.configProvider ?? (() => loadConfig(options.paths));
    this.clientFactory = options.clientFactory ?? ((account) => new WeixinApiClient({
      baseUrl: account.baseUrl,
      token: account.token
    }));
    this.bridgeFactory = options.bridgeFactory ?? ((input) => new BridgeService(input));
    this.channelFactory = options.channelFactory ?? ((account, adapterOptions) => {
      if (account.channel === "wecom") return new WeComChannelAdapter(account);
      if (account.channel === "feishu") {
        return new FeishuChannelAdapter(account, { inboundDir: adapterOptions.inboundDir });
      }
      return new DingTalkChannelAdapter(account, { inboundDir: adapterOptions.inboundDir });
    });
    this.monitor = options.monitor ?? monitorWeixin;
    this.runnerFactory = options.runnerFactory ?? ((config) => new CodexBackendRouter({
      backend: config.codexBackend,
      appServerTransport: config.codexAppServerTransport,
      codexBin: config.codexBin,
      execSandbox: config.codexExecSandbox
    }));
    this.codexSessionMonitorFactory = options.codexSessionMonitorFactory
      ?? ((handlers) => new CodexSessionCompletionMonitor(handlers));
    this.codexDesktopApprovalMonitorFactory = options.codexDesktopApprovalMonitorFactory
      ?? ((handlers) => new CodexDesktopApprovalMonitor(handlers));
    this.taskboardClientFactory = options.taskboardClientFactory ?? ((url) => new TaskboardClient({ baseUrl: url }));
    this.llmWiki = options.llmWiki ?? new LlmWikiMcpClientPool();
    this.channelCapabilities = options.channelCapabilities ?? createInstalledSkillCapabilitiesProvider();
    this.taskboardWorkbench = new TaskboardWorkbench({
      client: () => this.taskboardFor(),
      projects: () => this.listProjects().map(taskboardProjectBase)
    });
  }

  async startAll(): Promise<void> {
    for (const account of migrateLegacyDingTalkCardProfiles(this.options.paths)) {
      console.log(
        `[codex-im-gateway] migrated DingTalk AI Card streaming profile for account ${account.accountId}`
      );
    }
    await Promise.all(listAccounts(this.options.paths)
      .filter((account) => account.enabled)
      .map((account) => this.startAccount(account.accountId, false)));
    this.ensureCodexDesktopApprovalMonitor();
    this.ensureCodexSessionMonitor();
    this.startTaskboardMonitor();
  }

  async stopAll(): Promise<void> {
    this.codexDesktopApprovalMonitor?.stop();
    this.codexDesktopApprovalMonitor = undefined;
    await this.codexSessionMonitor?.stop();
    this.codexSessionMonitor = undefined;
    this.externalCodexTasks.clear();
    this.managedTurnCompletions.clear();
    this.taskboardController?.abort();
    await this.taskboardTask;
    this.taskboardController = undefined;
    this.taskboardTask = undefined;
    this.taskboard = undefined;
    this.recentTaskboardNotifications.clear();
    await Promise.all(listAccounts(this.options.paths)
      .filter((account) => this.entries.get(account.accountId)?.status === "running")
      .map((account) => this.stopAccount(account.accountId, false)));
    this.closeRunner();
    this.llmWiki.close();
  }

  async restartRunning(): Promise<void> {
    const running = listAccounts(this.options.paths)
      .filter((account) => this.entries.get(account.accountId)?.status === "running")
      .map((account) => account.accountId);
    await Promise.all(running.map((accountId) => this.stopAccount(accountId, false)));
    this.taskboardController?.abort();
    await this.taskboardTask;
    this.taskboardController = undefined;
    this.taskboardTask = undefined;
    this.taskboard = undefined;
    this.closeRunner();
    await Promise.all(running.map((accountId) => this.startAccount(accountId, false)));
    this.startTaskboardMonitor();
  }

  async refreshAccount(accountId: string): Promise<AccountSummary> {
    const account = loadAccount(this.options.paths, accountId);
    const existing = this.entries.get(account.accountId);
    if (existing?.status === "running" || existing?.status === "starting") {
      await this.stopAccount(account.accountId, false);
    }
    return this.startAccount(account.accountId, false);
  }

  async startAccount(accountId: string, persist = true): Promise<AccountSummary> {
    const account = persist ? setAccountEnabled(this.options.paths, accountId, true) : loadAccount(this.options.paths, accountId);
    const existing = this.entries.get(account.accountId);
    if (existing?.status === "running" || existing?.status === "starting") {
      return this.summary(account);
    }

    const controller = new AbortController();
    const statePaths = accountStatePaths(this.options.paths, account.accountId);
    const store = new RuntimeStateStore(statePaths);
    this.synchronizeManagedProjects(store);
    const channel = accountChannel(account);
    const webhook = new ChannelMessageWebhook({
      accountId: account.accountId,
      channel,
      ...(account.webhookUrl ? { webhookUrl: account.webhookUrl } : {}),
      ...(account.webhookProvider ? { webhookProvider: account.webhookProvider } : {})
    });
    const adapter = channel === "weixin" ? undefined : this.channelFactory(
      account as WeComAccount | FeishuAccount | DingTalkAccount,
      { inboundDir: statePaths.inboundDir }
    );
    const client = adapter?.client ?? this.clientFactory(account as WeixinAccount);
    const config = this.configProvider();
    const runner = this.runnerFor(config);
    const service = this.bridgeFactory({
      config,
      stateStore: store,
      weixin: client,
      inboundDir: statePaths.inboundDir,
      ...(channel === "weixin" ? { cdnBaseUrl: (account as WeixinAccount).cdnBaseUrl } : {}),
      runner,
      intentResolver: createCodexChannelIntentResolver({
        runner,
        cwd: this.options.paths.root,
        ...(config.model ? { model: config.model } : {})
      }),
      listCodexModels: () => this.getCodexModels(),
      getCodexBalance: () => this.getCodexBalance(),
      listCodexProjects: () => this.listCodexProjects(runner),
      llmWiki: this.llmWiki,
      modeSettings: normalizeChannelModeSettings(account.modeSettings),
      taskboard: this.taskboardFor(config),
      channelCapabilities: this.channelCapabilities,
      onOutboundMessage: (message) => webhook.publish(message),
      onTurnStatus: ({ sessionId, active }) => this.setSessionResponding(account.accountId, sessionId, active),
      onTurnCompleted: ({ sessionId, text, success, turnId }) => this.notifyProjectCompletion(
        account.accountId,
        sessionId,
        text,
        success,
        turnId
      )
    });
    const entry: RuntimeEntry = { status: "starting", controller, service, store, client, webhook };
    this.entries.set(account.accountId, entry);

    entry.status = "running";
    const handleMessage = async (message: Parameters<BridgeService["handleMessage"]>[0]) => {
      const authorizedConversation = message.source === "native-menu"
        ? store.getAuthorizedConversation(message.senderId)
        : undefined;
      const messageWithConversation = authorizedConversation
        ? { ...message, replyTargetId: authorizedConversation }
        : message;
      if (channel !== "weixin") {
        const replyTargetId = messageWithConversation.replyTargetId ?? messageWithConversation.senderId;
        const allowedIds = new Set([...config.allowedSenderIds, ...store.listPairedSenderIds()]);
        store.rememberChannelIdentity(
          messageWithConversation.senderId,
          replyTargetId,
          allowedIds.has(messageWithConversation.senderId) || allowedIds.has(replyTargetId)
        );
      }
      webhook.publish({
        direction: "inbound",
        id: messageWithConversation.id,
        senderId: messageWithConversation.senderId,
        text: messageWithConversation.text,
        attachments: messageWithConversation.attachments.map(({ kind, label }) => ({ kind, label }))
      });
      await service.handleMessage(messageWithConversation);
    };
    const onMessageError = async (error: unknown, message: Parameters<BridgeService["handleMessage"]>[0]) => {
      if (wasMessageHandlingErrorReported(error)) return;
      await this.sendChannelText(entry, {
        recipientId: message.replyTargetId ?? message.senderId,
        text: userFacingMessageHandlingError(error),
        contextToken: store.getContextToken(message.replyTargetId ?? message.senderId)
      });
    };
    const task = adapter ? adapter.monitor({
      signal: controller.signal,
      claimMessage: (message) => store.claimProcessedMessage(message.id),
      onMessage: handleMessage,
      onMessageError
    }) : this.monitor({
      client: client as WeixinApiClient,
      signal: controller.signal,
      initialSyncKey: store.getSyncKey(),
      onSyncKey: (syncKey) => store.setSyncKey(syncKey),
      claimMessage: (message) => store.claimProcessedMessage(message.id),
      onMessage: handleMessage,
      onMessageError
    });
    entry.task = task.then(() => {
      entry.status = "stopped";
    }).catch((error: unknown) => {
      if (controller.signal.aborted) {
        entry.status = "stopped";
        return;
      }
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : String(error);
    });
    return this.summary(account);
  }

  async stopAccount(accountId: string, persist = true): Promise<AccountSummary> {
    const account = persist ? setAccountEnabled(this.options.paths, accountId, false) : loadAccount(this.options.paths, accountId);
    const entry = this.entries.get(account.accountId);
    if (entry) {
      entry.controller?.abort();
      await entry.task;
      entry.status = "stopped";
    }
    return this.summary(account);
  }

  async removeAccount(accountId: string, options: { retainHistory?: boolean } = {}): Promise<void> {
    const account = loadAccount(this.options.paths, accountId);
    const retainHistory = options.retainHistory === true && accountChannel(account) === "weixin";
    await this.stopAccount(accountId, false);
    if (retainHistory) {
      retainAccountHistory(this.options.paths, account as WeixinAccount);
    } else if (accountChannel(account) === "weixin" && (account as WeixinAccount).userId) {
      const weixin = account as WeixinAccount;
      const userId = weixin.userId;
      if (userId) forgetRetainedAccount(this.options.paths, { accountId: weixin.accountId, userId });
    }
    deleteAccount(this.options.paths, accountId);
    if (!retainHistory) {
      fs.rmSync(path.dirname(accountStatePaths(this.options.paths, account.accountId).statePath), {
        recursive: true,
        force: true
      });
    }
    this.entries.delete(account.accountId);
  }

  updateAccount(accountId: string, patch: AccountSettingsPatch): AccountSummary {
    const displayName = patch.displayName.trim();
    if (displayName.length > 40) {
      throw new Error("Account display name must be 40 characters or fewer");
    }
    const account = setAccountSettings(this.options.paths, accountId, { ...patch, displayName });
    this.entries.get(account.accountId)?.webhook?.configure(account.webhookUrl, account.webhookProvider);
    return this.summary(account);
  }

  async updateAccountModeSettings(
    accountId: string,
    settings: ChannelModeSettingsUpdate
  ): Promise<AccountSummary> {
    const account = loadAccount(this.options.paths, accountId);
    const modeSettings = await resolveChannelModeSettings({
      store: this.storeFor(account.accountId),
      llmWiki: this.llmWiki,
      settings
    });
    const updated = setAccountModeSettings(this.options.paths, account.accountId, modeSettings);
    this.entries.get(account.accountId)?.service?.configureModeSettings?.(modeSettings);
    return this.summary(updated);
  }

  addChannelAccount(input:
    | { channel: "wecom"; botId: string; secret: string; displayName?: string }
    | { channel: "feishu"; appId: string; appSecret: string; displayName?: string }
    | {
        channel: "dingtalk";
        clientId: string;
        clientSecret: string;
        cardTemplateId?: string;
        cardContentKey?: string;
        networkFamily?: "auto" | "ipv4" | "ipv6";
        displayName?: string;
      }
  ): Promise<AccountSummary> {
    const savedAt = new Date().toISOString();
    const displayName = input.displayName?.trim();
    let account: WeComAccount | FeishuAccount | DingTalkAccount;
    if (input.channel === "wecom") {
      account = {
        channel: "wecom",
        accountId: uniqueAccountId(this.options.paths, `wecom-${normalizeAccountId(input.botId)}`),
        botId: input.botId.trim(),
        secret: input.secret.trim(),
        ...(displayName ? { displayName } : {}),
        savedAt,
        enabled: true
      };
    } else if (input.channel === "feishu") {
      account = {
        channel: "feishu",
        accountId: uniqueAccountId(this.options.paths, `feishu-${normalizeAccountId(input.appId)}`),
        appId: input.appId.trim(),
        appSecret: input.appSecret.trim(),
        ...(displayName ? { displayName } : {}),
        savedAt,
        enabled: true
      };
    } else {
      account = {
        channel: "dingtalk",
        accountId: uniqueAccountId(this.options.paths, `dingtalk-${normalizeAccountId(input.clientId)}`),
        clientId: input.clientId.trim(),
        clientSecret: input.clientSecret.trim(),
        ...(input.cardTemplateId?.trim() ? { cardTemplateId: input.cardTemplateId.trim() } : {}),
        ...(input.cardContentKey?.trim() ? { cardContentKey: input.cardContentKey.trim() } : {}),
        ...(input.networkFamily ? { networkFamily: input.networkFamily } : {}),
        ...(displayName ? { displayName } : {}),
        savedAt,
        enabled: true
      };
    }
    saveAccount(this.options.paths, account);
    return this.startAccount(account.accountId, false);
  }

  listAccounts(): AccountSummary[] {
    return listAccounts(this.options.paths).map((account) => this.summary(account));
  }

  async listChannelCapabilityNavigation(): Promise<readonly ChannelCapabilityNavigation[]> {
    const capabilities = await this.channelCapabilities();
    return capabilities.flatMap((capability) => capability.navigation ? [capability.navigation] : [])
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  async syncFeishuShortcutMenu(accountId: string): Promise<FeishuShortcutMenuSyncResult> {
    const account = loadAccount(this.options.paths, accountId);
    if (account.channel !== "feishu") {
      throw new Error("只有飞书渠道可以同步机器人快捷菜单");
    }
    return syncFeishuShortcutMenu(account);
  }

  listSessions(): AccountSession[] {
    return listAccounts(this.options.paths).flatMap((account) => {
      const store = this.storeFor(account.accountId);
      const activeIds = new Set(Object.values(store.snapshot.activeSessionIds));
      return store.listSessions().map((session) => ({
        ...session,
        accountId: account.accountId,
        active: activeIds.has(session.id),
        responding: this.isSessionResponding(account.accountId, session.id)
      }));
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listProjects(accountId?: string): AccountProject[] {
    const accounts = accountId ? [loadAccount(this.options.paths, accountId)] : listAccounts(this.options.paths);
    return accounts.flatMap((account) => {
      const store = this.storeFor(account.accountId);
      return store.listProjects().map((project) => this.projectSummary(account.accountId, project, store));
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listCodexProjects(runner = this.runnerFor(this.configProvider())): Promise<readonly CodexProjectCandidate[]> {
    try {
      return projectCandidatesFromBackendCatalog(await runner.listProjects());
    } catch (error) {
      console.warn(
        `[codex-im-gateway] unable to read selected backend project catalog; using local discovery fallback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return this.configProvider().codexBackend === "exec"
        ? listCodexCliProjectCandidates()
        : listCodexProjectCandidates();
    }
  }

  listKnowledgeBases(accountId?: string): AccountKnowledgeBase[] {
    const accounts = accountId ? [loadAccount(this.options.paths, accountId)] : listAccounts(this.options.paths);
    return accounts.flatMap((account) => {
      const store = this.storeFor(account.accountId);
      const projects = store.listProjects();
      const modeSettings = normalizeChannelModeSettings(account.modeSettings);
      return store.listKnowledgeBases().map((knowledgeBase) => ({
        ...knowledgeBase,
        accountId: account.accountId,
        boundProjects: projects
          .filter((project) => project.knowledgeBaseId === knowledgeBase.id)
          .map((project) => ({ id: project.id, name: project.name })),
        channelDefault: modeSettings.qaKnowledgeBaseId === knowledgeBase.id
      }));
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async inspectKnowledgeBase(accountId: string, knowledgeBaseId: string): Promise<LlmWikiInspection> {
    const knowledgeBase = this.storeFor(accountId).listKnowledgeBases()
      .find((candidate) => candidate.id === knowledgeBaseId);
    if (!knowledgeBase) throw new Error(`Managed knowledge base not found: ${knowledgeBaseId}`);
    return this.llmWiki.inspect(knowledgeBase);
  }

  async createKnowledgeBase(
    accountId: string,
    input: { name: string; rootPath: string; engineRoot?: string; stateDir?: string }
  ): Promise<{ knowledgeBase: AccountKnowledgeBase; inspection: LlmWikiInspection }> {
    const now = new Date().toISOString();
    const candidate: ManagedKnowledgeBase = {
      id: "validation",
      name: input.name,
      rootPath: path.resolve(input.rootPath),
      ...(input.engineRoot ? { engineRoot: path.resolve(input.engineRoot) } : {}),
      ...(input.stateDir ? { stateDir: path.resolve(input.stateDir) } : {}),
      createdAt: now,
      updatedAt: now
    };
    const inspection = await this.llmWiki.inspect(candidate);
    const knowledgeBase = this.storeFor(accountId).createKnowledgeBase(input.name, input.rootPath, input);
    return {
      knowledgeBase: { ...knowledgeBase, accountId, boundProjects: [], channelDefault: false },
      inspection
    };
  }

  async updateKnowledgeBase(
    accountId: string,
    knowledgeBaseId: string,
    input: { name?: string; rootPath?: string; engineRoot?: string | null; stateDir?: string | null }
  ): Promise<{ knowledgeBase: AccountKnowledgeBase; inspection: LlmWikiInspection }> {
    const store = this.storeFor(accountId);
    const current = store.listKnowledgeBases().find((candidate) => candidate.id === knowledgeBaseId);
    if (!current) throw new Error(`Managed knowledge base not found: ${knowledgeBaseId}`);
    const candidate: ManagedKnowledgeBase = {
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.rootPath !== undefined ? { rootPath: path.resolve(input.rootPath) } : {}),
      ...knowledgeBaseOptionalPath(input, "engineRoot", current.engineRoot),
      ...knowledgeBaseOptionalPath(input, "stateDir", current.stateDir),
      updatedAt: new Date().toISOString()
    };
    const inspection = await this.llmWiki.inspect(candidate);
    const updated = store.updateKnowledgeBase(knowledgeBaseId, input);
    this.llmWiki.invalidate(knowledgeBaseId);
    const knowledgeBase = this.listKnowledgeBases(accountId)
      .find((item) => item.id === updated.id);
    if (!knowledgeBase) {
      throw new Error(`Managed knowledge base not found after update: ${updated.id}`);
    }
    return {
      knowledgeBase,
      inspection
    };
  }

  deleteKnowledgeBase(accountId: string, knowledgeBaseId: string): void {
    const modeSettings = normalizeChannelModeSettings(loadAccount(this.options.paths, accountId).modeSettings);
    if (modeSettings.qaKnowledgeBaseId === knowledgeBaseId) {
      throw new Error("Knowledge base is still configured as the channel Q&A default");
    }
    this.storeFor(accountId).deleteKnowledgeBase(knowledgeBaseId);
    this.llmWiki.invalidate(knowledgeBaseId);
  }

  bindProjectKnowledgeBase(
    accountId: string,
    projectId: string,
    knowledgeBaseId?: string
  ): AccountProject {
    const store = this.storeFor(accountId);
    const project = store.bindProjectKnowledgeBase(projectId, knowledgeBaseId);
    return this.projectSummary(accountId, project, store);
  }

  createProject(
    accountId: string,
    name: string,
    workspace: string,
    metadata: { sourceProjectId?: string; projectKind?: "local" | "remote"; hostId?: string } = {}
  ): AccountProject {
    const config = this.configProvider();
    const targetWorkspace = path.resolve(workspace);
    if (!isWorkspaceAllowed(targetWorkspace, config.allowedWorkspaces)) {
      throw new Error(`Workspace is not allowed: ${targetWorkspace}`);
    }
    const store = this.storeFor(accountId);
    const project = store.createProject(name, targetWorkspace, metadata);
    this.ensureCodexSessionMonitor();
    return this.projectSummary(accountId, project, store);
  }

  renameProject(accountId: string, projectId: string, name: string): AccountProject {
    const store = this.storeFor(accountId);
    const project = store.renameProject(projectId, name);
    return this.projectSummary(accountId, project, store);
  }

  setProjectNotifications(
    accountId: string,
    projectId: string,
    targets: ProjectNotificationTarget[]
  ): AccountProject {
    for (const target of targets) loadAccount(this.options.paths, target.accountId);
    const store = this.storeFor(accountId);
    const project = store.setProjectNotifications(projectId, targets);
    this.ensureCodexSessionMonitor();
    return this.projectSummary(accountId, project, store);
  }

  deleteProject(accountId: string, projectId: string): void {
    this.storeFor(accountId).deleteProject(projectId);
  }

  async getCodexRuntimeInfo(): Promise<CodexRuntimeInfo> {
    const config = this.configProvider();
    const configured: CodexRuntimeInfo = {
      ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {})
    };
    try {
      const runtime = await this.runnerFor(config).getRuntimeInfo(config.defaultCwd);
      return {
        model: configured.model ?? runtime.model,
        effort: configured.effort ?? runtime.effort,
        ...(runtime.provider ? { provider: runtime.provider } : {})
      };
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return configured;
    }
  }

  async getCodexModels(): Promise<CodexModelOption[]> {
    let models: CodexModelOption[] = [];
    try {
      models = await this.runnerFor().listModels();
    } catch (error) {
      console.warn(`Codex model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const runtime = await this.getCodexRuntimeInfo();
    return addProviderModelFamily(models, runtime.provider);
  }

  async getCodexBalance(): Promise<CodexAccountBalance> {
    return this.runnerFor().getAccountRateLimits();
  }

  createSession(
    accountId: string,
    senderId: string,
    workspace?: string,
    title?: string,
    projectId?: string
  ): AccountSession {
    const config = this.configProvider();
    const project = projectId
      ? this.storeFor(accountId).listProjects().find((candidate) => candidate.id === projectId)
      : undefined;
    if (projectId && !project) {
      throw new Error(`Managed project not found: ${projectId}`);
    }
    const targetWorkspace = project?.workspace ?? workspace ?? config.defaultCwd;
    if (!isWorkspaceAllowed(targetWorkspace, config.allowedWorkspaces)) {
      throw new Error(`Workspace is not allowed: ${targetWorkspace}`);
    }
    const session = this.storeFor(accountId).createSession(senderId, targetWorkspace, title, project?.id);
    return this.sessionSummary(accountId, session, true);
  }

  renameSession(accountId: string, sessionId: string, title: string): AccountSession {
    const session = this.storeFor(accountId).renameSession(sessionId, title);
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  updateSessionRuntime(accountId: string, sessionId: string, overrides: SessionRuntimeOverrides): AccountSession {
    const session = this.storeFor(accountId).updateSessionRuntime(sessionId, overrides);
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  isSessionStreamEnabled(accountId: string, sessionId: string): boolean {
    const session = requireSession(this.storeFor(accountId), sessionId);
    return session.streamReplies ?? this.configProvider().streamReplies;
  }

  async activateSession(accountId: string, sessionId: string): Promise<AccountSession> {
    const store = this.storeFor(accountId);
    const pending = requireSession(store, sessionId);
    if (pending.threadId) {
      const project = pending.projectId ? store.getProject(pending.projectId) : undefined;
      assertCodexThreadRunnable(await this.runnerFor().inspectThread(pending.threadId, project?.hostId));
    }
    const session = store.activateSession(sessionId);
    return this.sessionSummary(accountId, session, true);
  }

  resetSession(accountId: string, sessionId: string): AccountSession {
    const session = this.storeFor(accountId).resetSession(sessionId);
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  deleteSession(accountId: string, sessionId: string): void {
    this.storeFor(accountId).deleteSession(sessionId);
    this.respondingSessions.delete(sessionRuntimeKey(accountId, sessionId));
  }

  async getSessionMessages(accountId: string, sessionId: string): Promise<SessionHistoryMessage[]> {
    const messages = await this.readSessionMessages(accountId, sessionId);
    return messages.map((message) => ({
      ...message,
      attachments: message.attachments.map(({ path: _path, ...attachment }) => attachment)
    }));
  }

  async getSessionAttachment(
    accountId: string,
    sessionId: string,
    messageId: string,
    attachmentIndex: number
  ): Promise<SessionAttachmentFile> {
    const messages = await this.readSessionMessages(accountId, sessionId);
    const attachment = messages.find((message) => message.id === messageId)
      ?.attachments.find((candidate) => candidate.index === attachmentIndex);
    if (!attachment?.available) {
      throw new Error("Session attachment not found");
    }
    return attachment;
  }

  private async readSessionMessages(accountId: string, sessionId: string): Promise<InternalSessionHistoryMessage[]> {
    const store = this.storeFor(accountId);
    const session = requireSession(store, sessionId);
    if (!session.threadId) {
      return [];
    }
    const storedProject = session.projectId ? store.getProject(session.projectId) : undefined;
    const project = storedProject ? this.synchronizeManagedProject(store, storedProject) : undefined;
    const history = await this.runnerFor().getHistory(session.threadId, project?.hostId);
    return history.flatMap((message) => {
      if (message.role === "user") {
        const parsed = parsePrompt(message.text);
        const inboundRoot = accountStatePaths(this.options.paths, accountId).inboundDir;
        const attachments = parsed.attachments
          .filter((attachment) => isPathWithin(inboundRoot, attachment.path))
          .map((attachment, index) => sessionAttachment({
            type: attachment.kind === "audio" ? "file" : attachment.kind,
            path: attachment.path
          }, index));
        return parsed.text || attachments.length ? [{ ...message, text: parsed.text, attachments }] : [];
      }
      const parsed = parseAssistantMessage(message.text);
      const attachments = parsed.actions.send.map((action, index) => sessionAttachment(action, index));
      const text = parsed.visibleText.trim();
      return text || attachments.length ? [{ ...message, text, attachments }] : [];
    });
  }

  async continueSession(
    accountId: string,
    sessionId: string,
    text: string,
    uploads: SessionUpload[] = [],
    onProgress?: (message: string) => Promise<void> | void
  ): Promise<SessionChatResult> {
    const prompt = text.trim();
    if (!prompt && !uploads.length) {
      throw new Error("Message text or attachment is required");
    }
    const store = this.storeFor(accountId);
    const session = requireSession(store, sessionId);
    const project = session.projectId ? store.getProject(session.projectId) : undefined;
    const config = this.configProvider();
    const attachments = this.saveSessionUploads(accountId, session.id, uploads);
    const promptPreview = buildPromptPreview(prompt, attachments);
    if (promptPreview) {
      store.setSessionPromptPreview(session.id, promptPreview);
    }
    this.setSessionResponding(accountId, session.id, true);
    try {
      const promptParts = buildPromptParts(
        prompt,
        attachments,
        "Web",
        store.relevantKnowledge(promptPreview ?? prompt, session.projectId)
      );
      const result = await this.runnerFor(config).run({
        prompt: promptParts.prompt,
        developerInstructions: promptParts.developerInstructions,
        cwd: session.workspace,
        hostId: project?.hostId,
        projectId: project?.sourceProjectId,
        projectName: project?.name,
        threadId: session.threadId,
        threadTitle: preferredThreadTitle(session.title, promptPreview),
        onThreadCreated: (createdThreadId) => {
          store.setSessionThread(session.id, createdThreadId);
        },
        queueKey: session.threadId ?? session.id,
        model: session.model ?? config.model,
        effort: session.effort ?? config.effort,
        onApproval: (request: CodexApprovalRequest) => this.requestProjectApprovalForSession(accountId, session, request),
        ...((session.streamReplies ?? config.streamReplies) && onProgress
          ? { onProgress }
          : {})
      });
      const threadId = result.threadId ?? session.threadId;
      if (!threadId) {
        throw new Error("Codex did not return a thread id");
      }
      store.setSessionThread(session.id, threadId);
      const parsed = parseAssistantMessage(result.text);
      for (const memory of parsed.actions.remember) {
        store.rememberKnowledge(memory, session.projectId, session.id);
      }
      const response: SessionChatResult = {
        threadId,
        message: {
          id: crypto.randomUUID(),
          role: "assistant",
          text: parsed.visibleText.trim(),
          createdAt: new Date().toISOString(),
          attachments: parsed.actions.send.map((action, index) => {
            const { path: _path, ...attachment } = sessionAttachment(action, index);
            return attachment;
          })
        }
      };
      await this.notifyProjectCompletion(accountId, session.id, parsed.visibleText.trim(), true, result.turnId);
      return response;
    } catch (error) {
      await this.notifyProjectCompletion(
        accountId,
        session.id,
        error instanceof Error ? error.message : String(error),
        false
      );
      throw error;
    } finally {
      this.setSessionResponding(accountId, session.id, false);
    }
  }

  private synchronizeManagedProjects(store: RuntimeStateStore): void {
    for (const project of store.listProjects()) {
      this.synchronizeManagedProject(store, project);
    }
  }

  private synchronizeManagedProject(store: RuntimeStateStore, project: ManagedProject): ManagedProject {
    const candidate = listCodexProjectCandidates().find((item) => (
      path.resolve(item.workspace) === path.resolve(project.workspace)
      && (item.hostId ?? "local") === (project.hostId ?? "local")
    ));
    if (!candidate?.projectId) return project;
    if (
      project.sourceProjectId === candidate.projectId
      && project.projectKind === candidate.projectKind
      && project.hostId === candidate.hostId
    ) return project;
    return store.updateProjectMetadata(project.id, {
      sourceProjectId: candidate.projectId,
      projectKind: candidate.projectKind,
      hostId: candidate.hostId
    });
  }

  private saveSessionUploads(accountId: string, sessionId: string, uploads: SessionUpload[]): PromptBufferItem[] {
    if (!uploads.length) return [];
    const sessionDir = path.join(
      accountStatePaths(this.options.paths, accountId).inboundDir,
      "web",
      safePathSegment(sessionId),
      crypto.randomUUID()
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    try {
      return uploads.map((upload) => {
        const label = sanitizeFileName(upload.name);
        const targetPath = uniqueFilePath(sessionDir, label);
        fs.writeFileSync(targetPath, upload.data, { flag: "wx" });
        return {
          kind: inferMediaKind(label),
          label,
          path: targetPath
        };
      });
    } catch (error) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      throw error;
    }
  }

  allowSender(accountId: string, senderId: string): void {
    const entry = this.entries.get(loadAccount(this.options.paths, accountId).accountId);
    if (entry?.service) {
      entry.service.allowSender(senderId);
      return;
    }
    const store = this.storeFor(accountId);
    store.setPairedSenderIds([...store.listPairedSenderIds(), senderId]);
  }

  removeSender(accountId: string, senderId: string): void {
    const entry = this.entries.get(loadAccount(this.options.paths, accountId).accountId);
    if (entry?.service) {
      entry.service.removeSender(senderId);
      return;
    }
    const store = this.storeFor(accountId);
    store.setPairedSenderIds(store.listPairedSenderIds().filter((candidate) => candidate !== senderId));
  }

  private storeFor(accountId: string): RuntimeStateStore {
    const account = loadAccount(this.options.paths, accountId);
    return this.entries.get(account.accountId)?.store
      ?? new RuntimeStateStore(accountStatePaths(this.options.paths, account.accountId));
  }

  private isActive(accountId: string, sessionId: string): boolean {
    return Object.values(this.storeFor(accountId).snapshot.activeSessionIds).includes(sessionId);
  }

  private sessionSummary(accountId: string, session: ManagedSession, active: boolean): AccountSession {
    return {
      ...session,
      accountId,
      active,
      responding: this.isSessionResponding(accountId, session.id)
    };
  }

  private isSessionResponding(accountId: string, sessionId: string): boolean {
    return (this.respondingSessions.get(sessionRuntimeKey(accountId, sessionId)) ?? 0) > 0;
  }

  private setSessionResponding(accountId: string, sessionId: string, active: boolean): void {
    const key = sessionRuntimeKey(accountId, sessionId);
    const count = this.respondingSessions.get(key) ?? 0;
    const next = active ? count + 1 : Math.max(0, count - 1);
    if (next) {
      this.respondingSessions.set(key, next);
    } else {
      this.respondingSessions.delete(key);
    }
  }

  private runnerFor(config = this.configProvider()): CodexBridgeBackend {
    if (this.runner) return this.runner;
    const runner = this.runnerFactory(config);
    this.runner = runner;
    runner.warmUp(this.options.paths.root).catch((error: unknown) => {
      console.warn("[codex-im-gateway] Codex app-server warm-up failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return runner;
  }

  private closeRunner(): void {
    this.runner?.close();
    this.runner = undefined;
  }

  private async notifyProjectCompletion(
    ownerAccountId: string,
    sessionId: string,
    resultText: string,
    success = true,
    turnId?: string
  ): Promise<void> {
    const ownerStore = this.storeFor(ownerAccountId);
    const session = ownerStore.getSession(sessionId);
    const project = session?.projectId
      ? ownerStore.listProjects().find((candidate) => candidate.id === session.projectId)
      : undefined;
    if (!session || !project) return;
    if (session.threadId && turnId) {
      this.managedTurnCompletions.add(taskRuntimeKey(session.threadId, turnId));
    }
    await this.sendProjectCompletion(project, session.title, resultText, success, session.threadId);
  }

  private ensureCodexSessionMonitor(): void {
    if (this.codexSessionMonitor || !this.hasManagedProjects()) return;
    this.ensureCodexDesktopApprovalMonitor();
    this.codexSessionMonitor = this.codexSessionMonitorFactory({
      onCompletion: (completion) => this.notifyExternalCodexCompletion(completion),
      onTaskChanged: (task) => this.updateExternalCodexTask(task)
    });
    this.codexSessionMonitor.start();
  }

  private hasManagedProjects(): boolean {
    return listAccounts(this.options.paths).some((account) =>
      this.storeFor(account.accountId).listProjects().length > 0
    );
  }

  private updateExternalCodexTask(task: CodexSessionTask): void {
    const key = `${task.sessionId}\n${task.turnId}`;
    if (task.status === "running") {
      this.externalCodexTasks.set(key, task);
      if (this.projectForExternalThread(task.sessionId, task.workspace)) {
        this.codexDesktopApprovalMonitor?.followThread(task.sessionId);
      }
    } else {
      this.externalCodexTasks.delete(key);
    }
  }

  private ensureCodexDesktopApprovalMonitor(): void {
    if (this.codexDesktopApprovalMonitor || !this.hasManagedProjects()) return;
    this.codexDesktopApprovalMonitor = this.codexDesktopApprovalMonitorFactory({
      onApproval: (approval) => this.handleDesktopApproval(approval)
    });
    this.codexDesktopApprovalMonitor.start();
  }

  private async handleDesktopApproval(approval: CodexDesktopApproval): Promise<CodexApprovalDecision | undefined> {
    const project = this.projectForExternalThread(approval.request.threadId, approval.request.cwd);
    if (!project) {
      console.warn(`[codex-im-gateway] no managed project found for Codex Desktop approval ${approval.requestId}`);
      return undefined;
    }
    return this.requestProjectApproval(project, approval.request);
  }

  private requestProjectApprovalForSession(
    accountId: string,
    session: ManagedSession,
    request: CodexApprovalRequest
  ): Promise<CodexApprovalDecision> {
    const project = session.projectId
      ? this.storeFor(accountId).listProjects().find((candidate) => candidate.id === session.projectId)
      : undefined;
    if (!project) return Promise.resolve("decline");
    return this.requestProjectApproval(project, request).then((decision) => decision ?? "decline");
  }

  private async requestProjectApproval(
    project: ManagedProject,
    request: CodexApprovalRequest
  ): Promise<CodexApprovalDecision | undefined> {
    const target = (project.notifications ?? [])
      .filter((candidate) => candidate.enabled)
      .find((candidate) => {
        const entry = this.entries.get(candidate.accountId);
        return entry?.status === "running" && Boolean(entry.service);
      });
    if (!target) {
      console.warn(`[codex-im-gateway] no running notification channel for approval in project ${project.name}`);
      return undefined;
    }
    const entry = this.entries.get(target.accountId);
    return entry?.service?.requestApproval(target.recipientId, request);
  }

  private projectForExternalThread(threadId: string, workspace?: string): ManagedProject | undefined {
    const contexts = listAccounts(this.options.paths).flatMap((account) => {
      const store = this.storeFor(account.accountId);
      const projects = new Map(store.listProjects().map((project) => [project.id, project]));
      return store.listSessions().flatMap((session) => {
        const project = session.projectId ? projects.get(session.projectId) : undefined;
        return project ? [{ session, project }] : [];
      });
    });
    const exact = contexts.find(({ session }) => session.threadId === threadId)?.project;
    if (exact) return exact;
    if (!workspace) return undefined;
    const canonical = canonicalWorkspace(workspace);
    return contexts.find(({ project }) => canonicalWorkspace(project.workspace) === canonical)?.project
      ?? listAccounts(this.options.paths).flatMap((account) => this.storeFor(account.accountId).listProjects())
        .find((project) => canonicalWorkspace(project.workspace) === canonical);
  }

  private projectSummary(
    accountId: string,
    project: ManagedProject,
    store = this.storeFor(accountId)
  ): AccountProject {
    const sessions = store.listSessions().filter((session) => session.projectId === project.id);
    const activeSessionIds = new Set(Object.values(store.snapshot.activeSessionIds));
    const boundSessions: AccountProjectSession[] = sessions.slice(0, 10).map((session) => ({
      id: session.id,
      title: session.title,
      active: activeSessionIds.has(session.id),
      hasThread: Boolean(session.threadId),
      updatedAt: session.updatedAt
    }));
    const respondingThreadIds = new Set(listAccounts(this.options.paths).flatMap((account) =>
      this.storeFor(account.accountId).listSessions().flatMap((session) =>
        session.threadId && this.isSessionResponding(account.accountId, session.id) ? [session.threadId] : []
      )
    ));
    const boundThreadIds = new Set(listAccounts(this.options.paths).flatMap((account) =>
      this.storeFor(account.accountId).listSessions().flatMap((session) => session.threadId ? [session.threadId] : [])
    ));
    const projectThreadIds = new Set(sessions.flatMap((session) => session.threadId ? [session.threadId] : []));
    const managedTasks: AccountProjectTask[] = sessions
      .filter((session) => this.isSessionResponding(accountId, session.id))
      .map((session) => ({
        id: `managed:${accountId}:${session.id}`,
        title: session.title,
        source: "managed",
        startedAt: session.updatedAt,
        updatedAt: session.updatedAt
      }));
    const workspace = canonicalWorkspace(project.workspace);
    const externalTasks: AccountProjectTask[] = [...this.externalCodexTasks.values()]
      .filter((task) =>
        canonicalWorkspace(task.workspace) === workspace
        && !respondingThreadIds.has(task.sessionId)
        && (!boundThreadIds.has(task.sessionId) || projectThreadIds.has(task.sessionId))
      )
      .map((task) => ({
        id: `codex:${task.sessionId}:${task.turnId}`,
        title: task.title,
        source: "codex",
        startedAt: task.startedAt,
        updatedAt: task.updatedAt
      }));
    const runningTasks = [...managedTasks, ...externalTasks]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      ...project,
      accountId,
      sessionCount: sessions.length,
      boundSessions,
      activeTaskCount: runningTasks.length,
      runningTasks
    };
  }

  private async notifyExternalCodexCompletion(completion: CodexSessionCompletion): Promise<void> {
    const accounts = listAccounts(this.options.paths);
    const stores = accounts.map((account) => ({ account, store: this.storeFor(account.accountId) }));
    const managedByService = stores.some(({ account, store }) =>
      store.listSessions().some((session) =>
        session.threadId === completion.sessionId
        && this.isSessionResponding(account.accountId, session.id)
      )
    );
    const completionKey = taskRuntimeKey(completion.sessionId, completion.turnId);
    if (managedByService || this.managedTurnCompletions.delete(completionKey)) return;
    const workspace = path.resolve(completion.workspace);
    const boundProjects = new Set(stores.flatMap(({ account, store }) =>
      store.listSessions().flatMap((session) =>
        session.threadId === completion.sessionId && session.projectId
          ? [`${account.accountId}\n${session.projectId}`]
          : []
      )
    ));
    await Promise.all(stores.flatMap(({ account, store }) =>
      store.listProjects()
        .filter((project) =>
          path.resolve(project.workspace) === workspace
          && (!boundProjects.size || boundProjects.has(`${account.accountId}\n${project.id}`))
        )
        .map((project) => this.sendProjectCompletion(
          project,
          completion.taskTitle,
          completion.text,
          completion.success,
          completion.sessionId
        ))
    ));
  }

  private async sendProjectCompletion(
    project: ManagedProject,
    taskTitle: string,
    resultText: string,
    success: boolean,
    threadId?: string
  ): Promise<void> {
    const targets = (project.notifications ?? []).filter((target) => target.enabled);
    if (!targets.length) return;
    const issue = threadId ? await this.issueForProjectThread(project, threadId) : undefined;
    if (success && issue && this.wasRecentlyNotified(issue)) return;
    const excerpt = resultText.replace(/\s+/g, " ").trim().slice(0, 500);
    const text = [
      success ? "【Codex 任务已完成】" : "【Codex 任务执行失败】",
      `项目：${project.name}`,
      ...(issue ? [`Issue：${issue.identifier} · ${formatTaskboardStatus(issue.status)}`] : []),
      `任务：${taskTitle.replace(/\s+/g, " ").trim().slice(0, 100) || "Codex 会话"}`,
      ...(excerpt ? [`${success ? "结果" : "错误"}：${excerpt}`] : [])
    ].join("\n");
    const card = issue ? createTaskCard(project.name, issue, {
      title: success ? "Codex 任务已完成" : "Codex 任务执行失败",
      note: excerpt ? `${success ? "结果" : "错误"}：${excerpt}` : undefined,
      template: success ? "green" : "red",
      taskboardBaseUrl: this.taskboardFor()?.baseUrl ?? this.configProvider().taskboardUrl
    }) : undefined;
    await this.sendNotificationTargets(targets, text, card);
  }

  async getTaskboardStatus(): Promise<TaskboardIntegrationStatus> {
    const config = this.configProvider();
    const managed = this.listProjects();
    if (!config.taskboardEnabled) {
      return { enabled: false, managed: true, available: false, url: config.taskboardUrl, projects: managed.map(taskboardProjectBase) };
    }
    try {
      const client = this.taskboardFor(config);
      if (!client) {
        return { enabled: true, managed: true, available: false, url: config.taskboardUrl, projects: managed.map(taskboardProjectBase) };
      }
      const projects = await client.listProjects();
      return {
        enabled: true,
        managed: true,
        available: true,
        url: client.baseUrl,
        projects: managed.map((project) => {
          const match = projects.find((candidate) => candidate.workspacePath !== null
            && canonicalWorkspace(candidate.workspacePath) === canonicalWorkspace(project.workspace));
          return {
            ...taskboardProjectBase(project),
            ...(match ? {
              taskboardProjectId: match.id,
              taskboardProjectName: match.name,
              issueCount: match.issueCount
            } : {})
          };
        })
      };
    } catch (error) {
      return {
        enabled: true,
        managed: true,
        available: false,
        url: config.taskboardUrl,
        error: error instanceof Error ? error.message : String(error),
        projects: managed.map(taskboardProjectBase)
      };
    }
  }

  async listTaskboardIssues(): Promise<TaskboardIssueSummary[]> {
    return this.taskboardWorkbench.listIssues();
  }

  async getTaskboardIssue(identifier: string): Promise<TaskboardIssueDetail> {
    return this.taskboardWorkbench.getIssue(identifier);
  }

  async commentTaskboardIssue(identifier: string, body: string): Promise<TaskboardComment> {
    return this.taskboardWorkbench.commentIssue(identifier, body);
  }

  async moveTaskboardIssue(
    identifier: string,
    status: TaskboardStatus,
    version: number,
    comment?: string
  ): Promise<TaskboardIssue> {
    return this.taskboardWorkbench.moveIssue(identifier, status, version, comment);
  }

  private taskboardFor(config = this.configProvider()): TaskboardClient | undefined {
    if (!config.taskboardEnabled) return undefined;
    if (!this.taskboard || this.taskboard.baseUrl !== config.taskboardUrl.replace(/\/$/, "")) {
      this.taskboard = this.taskboardClientFactory(config.taskboardUrl);
    }
    return this.taskboard;
  }

  private startTaskboardMonitor(): void {
    const client = this.taskboardFor();
    if (!client || this.taskboardTask) return;
    const controller = new AbortController();
    this.taskboardController = controller;
    this.taskboardTask = this.runTaskboardMonitor(client, controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        console.error(`[codex-im-gateway] Taskboard monitor stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private async runTaskboardMonitor(client: TaskboardClient, signal: AbortSignal): Promise<void> {
    let retryMs = 2_000;
    while (!signal.aborted) {
      try {
        await client.subscribe(signal, (event) => this.handleTaskboardEvent(event));
        retryMs = 2_000;
      } catch (error) {
        if (signal.aborted) return;
        console.warn(`[codex-im-gateway] Taskboard event stream unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      await waitForAbortOrTimeout(signal, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }

  private async handleTaskboardEvent(event: TaskboardEvent): Promise<void> {
    const issue = event.task;
    if (!["task.updated", "task.moved"].includes(event.type)
      || !issue
      || !["blocked", "in_review", "done"].includes(issue.status)) return;
    const key = taskboardNotificationKey(issue);
    if (this.recentTaskboardNotifications.has(key)) return;
    this.recentTaskboardNotifications.set(key, Date.now());
    this.pruneTaskboardNotifications();
    const taskboard = this.taskboard;
    if (!taskboard) return;
    const taskboardProjects = await taskboard.listProjects();
    const taskboardProject = taskboardProjects.find((project) => project.id === issue.projectId);
    if (!taskboardProject?.workspacePath) return;
    const latestComment = (await taskboard.listComments(issue.id)).at(-1)?.body;
    const workspace = canonicalWorkspace(taskboardProject.workspacePath);
    await Promise.all(listAccounts(this.options.paths).flatMap((account) => {
      const store = this.storeFor(account.accountId);
      return store.listProjects()
        .filter((project) => canonicalWorkspace(project.workspace) === workspace)
        .map((project) => this.sendTaskboardStatusNotification(project, issue, latestComment));
    }));
  }

  private async sendTaskboardStatusNotification(
    project: ManagedProject,
    issue: TaskboardIssue,
    latestComment?: string
  ): Promise<void> {
    const targets = (project.notifications ?? []).filter((target) => target.enabled);
    if (!targets.length) return;
    const excerpt = latestComment?.replace(/\s+/g, " ").trim().slice(0, 500);
    const text = [
      `【Taskboard · ${formatTaskboardStatus(issue.status)}】`,
      `项目：${project.name}`,
      `Issue：${issue.identifier} · ${issue.title}`,
      ...(excerpt ? [`最新记录：${excerpt}`] : [])
    ].join("\n");
    await this.sendNotificationTargets(targets, text, createTaskCard(project.name, issue, {
      latestComment: excerpt,
      taskboardBaseUrl: this.taskboardFor()?.baseUrl ?? this.configProvider().taskboardUrl
    }));
  }

  private async sendNotificationTargets(
    targets: ProjectNotificationTarget[],
    text: string,
    card?: ChannelTaskCard
  ): Promise<void> {
    const results = await Promise.allSettled(targets.map(async (target) => {
      const entry = this.entries.get(target.accountId);
      if (!entry?.client || entry.status !== "running") throw new Error(`Notification channel is not running: ${target.accountId}`);
      const contextToken = entry.store?.getContextToken(target.recipientId);
      const message = {
        recipientId: target.recipientId,
        text,
        ...(contextToken ? { contextToken } : {})
      };
      if (card && entry.client.sendTaskCard) await this.sendChannelTaskCard(entry, message, card);
      else await this.sendChannelText(entry, message);
    }));
    for (const result of results) {
      if (result.status === "rejected") console.error(`[codex-im-gateway] channel notification failed: ${String(result.reason)}`);
    }
  }

  private async issueForProjectThread(project: ManagedProject, threadId: string): Promise<TaskboardIssue | undefined> {
    try {
      const taskboard = this.taskboardFor();
      const taskboardProject = await taskboard?.projectForWorkspace(project.workspace);
      return taskboard && taskboardProject
        ? await taskboard.issueForThread(taskboardProject.id, threadId)
        : undefined;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return undefined;
    }
  }

  private wasRecentlyNotified(issue: TaskboardIssue): boolean {
    const at = this.recentTaskboardNotifications.get(taskboardNotificationKey(issue));
    return at !== undefined && Date.now() - at < 30_000;
  }

  private pruneTaskboardNotifications(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [key, at] of this.recentTaskboardNotifications) if (at < cutoff) this.recentTaskboardNotifications.delete(key);
  }

  private summary(account: ChannelAccount): AccountSummary {
    const entry = this.entries.get(account.accountId);
    const store = entry?.store ?? new RuntimeStateStore(accountStatePaths(this.options.paths, account.accountId));
    return {
      ...publicAccount(account),
      status: entry?.status ?? "stopped",
      ...(entry?.error ? { error: entry.error } : {}),
      pairedSenderIds: store.listPairedSenderIds(),
      lastActiveSenderId: store.getLastActiveSenderId(),
      lastActiveActorId: store.getLastActiveActorId(),
      lastAuthorizedSenderId: store.getLastAuthorizedSenderId(),
      lastAuthorizedActorId: store.getLastAuthorizedActorId(),
      sessionCount: store.listSessions().length
    };
  }

  private async sendChannelText(entry: RuntimeEntry, message: DirectChannelText): Promise<void> {
    if (!entry.client) throw new Error("Notification channel client is not available");
    const sent = await entry.client.sendText({
      toUserId: message.recipientId,
      text: message.text,
      ...(message.contextToken ? { contextToken: message.contextToken } : {})
    });
    entry.webhook?.publish({
      direction: "outbound",
      id: sent.messageId,
      recipientId: message.recipientId,
      text: message.text,
      attachments: []
    });
  }

  private async sendChannelTaskCard(
    entry: RuntimeEntry,
    message: DirectChannelText,
    card: ChannelTaskCard
  ): Promise<void> {
    if (!entry.client?.sendTaskCard) throw new Error("Notification channel card capability is not available");
    const sent = await entry.client.sendTaskCard({ toUserId: message.recipientId, card });
    entry.webhook?.publish({
      direction: "outbound",
      id: sent.messageId,
      recipientId: message.recipientId,
      text: message.text,
      attachments: []
    });
  }
}

function requireSession(store: RuntimeStateStore, sessionId: string): ManagedSession {
  const session = store.getSession(sessionId);
  if (!session) {
    throw new Error(`Managed session not found: ${sessionId}`);
  }
  return session;
}

function parseAssistantMessage(text: string): ReturnType<typeof parseActionBlocks> {
  try {
    return parseActionBlocks(text);
  } catch {
    return { visibleText: text.trim(), actions: { send: [], control: [], remember: [] } };
  }
}

function sessionAttachment(
  action: { type: "image" | "file" | "video"; path: string },
  index: number
): SessionAttachmentFile {
  let size: number | undefined;
  let available = false;
  try {
    const stat = fs.statSync(action.path);
    available = stat.isFile();
    if (available) size = stat.size;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Keep historical attachments visible even after their local file is moved.
  }
  return {
    index,
    type: action.type,
    path: action.path,
    name: path.basename(action.path),
    ...(size === undefined ? {} : { size }),
    available
  };
}

function uniqueFilePath(dir: string, fileName: string): string {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, fileName);
  for (let index = 2; fs.existsSync(candidate); index += 1) {
    candidate = path.join(dir, `${parsed.name}-${index}${parsed.ext}`);
  }
  return candidate;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "session";
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalWorkspace(workspace: string): string {
  const resolved = path.resolve(workspace);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sessionRuntimeKey(accountId: string, sessionId: string): string {
  return `${accountId}\n${sessionId}`;
}

function preferredThreadTitle(sessionTitle: string, promptPreview?: string): string {
  const genericSessionTitle = /^(?:会话\s*\d+|新会话|Codex 会话(?:\s+[\da-f-]+)?)$/i.test(sessionTitle.trim());
  return (genericSessionTitle ? promptPreview : sessionTitle) ?? promptPreview ?? sessionTitle;
}

function taskRuntimeKey(sessionId: string, turnId: string): string {
  return `${sessionId}\n${turnId}`;
}

function taskboardNotificationKey(issue: TaskboardIssue): string {
  return `${issue.id}\n${issue.version}\n${issue.status}`;
}

function knowledgeBaseOptionalPath(
  input: { engineRoot?: string | null; stateDir?: string | null },
  key: "engineRoot" | "stateDir",
  current: string | undefined
): Partial<Pick<ManagedKnowledgeBase, "engineRoot" | "stateDir">> {
  if (!Object.hasOwn(input, key)) return current ? { [key]: current } : {};
  const value = input[key];
  return value ? { [key]: path.resolve(value) } : {};
}

function taskboardProjectBase(project: AccountProject): TaskboardIntegrationStatus["projects"][number] {
  return {
    accountId: project.accountId,
    projectId: project.id,
    projectName: project.name,
    workspace: project.workspace
  };
}

function formatTaskboardStatus(status: TaskboardIssue["status"]): string {
  return ({
    backlog: "待规划",
    todo: "待处理",
    in_progress: "处理中",
    in_review: "待验收",
    blocked: "阻塞",
    done: "已完成",
    canceled: "已取消"
  } as Record<TaskboardIssue["status"], string>)[status];
}

function waitForAbortOrTimeout(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onAbort = () => {
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function uniqueAccountId(paths: StatePaths, preferred: string): string {
  const existing = new Set(listAccounts(paths).map((account) => account.accountId));
  if (!existing.has(preferred)) return preferred;
  for (let index = 2; ; index += 1) {
    const candidate = `${preferred}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function addProviderModelFamily(models: CodexModelOption[], provider?: string): CodexModelOption[] {
  if (provider?.toLowerCase() !== "ikuncoding") {
    return models;
  }
  const commonEfforts = ["low", "medium", "high", "xhigh", "max"];
  const descriptions: Record<string, { displayName: string; description: string; efforts: string[] }> = {
    "gpt-5.6-sol": {
      displayName: "GPT-5.6 Sol",
      description: "Frontier agentic coding model for complex work.",
      efforts: [...commonEfforts, "ultra"]
    },
    "gpt-5.6-terra": {
      displayName: "GPT-5.6 Terra",
      description: "Balanced agentic coding model for everyday work.",
      efforts: [...commonEfforts, "ultra"]
    },
    "gpt-5.6-luna": {
      displayName: "GPT-5.6 Luna",
      description: "Fast and efficient model for simpler coding tasks.",
      efforts: commonEfforts
    }
  };
  const family = Object.entries(descriptions).map(([model, details]) => ({
    model,
    displayName: details.displayName,
    description: details.description,
    isDefault: false,
    defaultEffort: "medium",
    supportedEfforts: details.efforts.map((effort) => ({ effort, description: "" }))
  }));
  return [
    ...family.filter((option) => !models.some((model) => model.model === option.model)),
    ...models
  ];
}
