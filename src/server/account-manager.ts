import { AdmissionService } from "../bridge/admission.js";
import crypto from "node:crypto";
import { migrateCardBootstrap } from "./migrate-card-bootstrap.js";
import { InboundReferenceStore } from "../bridge/inbound-references.js";
import fs from "node:fs";
import path from "node:path";

import { parseActionBlocks } from "../bridge/actions.js";
import { sessionExecutionScope } from "../bridge/session-execution.js";
import type {
  ChannelCapabilityNavigation,
  ChannelCapabilityProvider
} from "../bridge/channel-capability.js";
import { createInstalledSkillCapabilitiesProvider } from "../bridge/installed-skill-capabilities.js";
import { buildPromptPreview, parsePrompt } from "../bridge/format.js";
import type { PromptBufferItem } from "../bridge/prompt-buffer.js";
import { BridgeService } from "../bridge/service.js";
import type { ApprovalDeliveryResult } from "../bridge/approval.js";
import { SessionControlJournal, SessionControlQueue } from "../bridge/session-control.js";
import { TurnAudienceJournal } from "../bridge/turn-audience.js";
import { NativeQueueCoordinator } from "../bridge/native-queue.js";
import { InboundReceiptJournal } from "../bridge/inbound-receipts.js";
import { prepareTurnSubmission, TurnSubmission, TurnDeliveryError, TurnApplicationError } from "../bridge/turn-submission.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { InteractionRoutingJournal, type InteractionDestination, type InteractionRouteStatus } from "../bridge/interaction-routing.js";
import { ThreadEventHub, type ThreadSubscription } from "./thread-event-hub.js";
import { CapacityRecoveryCoordinator } from "./capacity-recovery.js";
import { SystemErrorRecoveryCoordinator, type SystemRecoveryScope } from "./system-error-recovery.js";
import { CodexInterventionError } from "../codex/backend.js";
import {
  userFacingMessageHandlingError,
  wasMessageHandlingErrorReported
} from "../bridge/errors.js";
import { channelFactoryWithLegacyOverrides, type ChannelAdapterFactory } from "../channels/factory.js";
import {
  normalizeChannelModeSettings,
  type ChannelModeSettingsUpdate
} from "../channels/channel-mode-settings.js";
import type { ChannelAdapter, ChannelClient, ChannelConnectionStatus, ChannelCapabilities } from "../channels/types.js";
import { createTaskCard, type ChannelTaskCard } from "../channels/task-card.js";
import type {
  CodexBridgeBackend,
  CodexHistoryMessage,
  CodexModelOption,
  CodexProjectCatalog,
  CodexRuntimeInfo
} from "../codex/backend.js";
import type { CodexThreadState } from "../codex/backend.js";
import { desktopSessionMembership } from "../codex/desktop-session-membership.js";
import { localProjectsAtWorkspace, nativeProjectForManaged } from "../state/project-identity.js";
import { assertCodexThreadRunnable, capacityFailureScope, CodexTurnExecutionError } from "../codex/backend.js";
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
  type CodexSessionActivity,
  type CodexSessionCompletion,
  type CodexSessionTask
} from "./codex-session-monitor.js";
import {
  CodexDesktopRequestMonitor,
  type CodexDesktopApproval,
  type CodexDesktopUserInput,
  type CodexDesktopRequestMonitorOptions
} from "./codex-desktop-request-monitor.js";
import type { CodexUserInputAnswer, CodexUserInputResult } from "../codex/backend.js";
import {
  RuntimeStateStore,
  type ManagedProject,
  type ManagedKnowledgeBase,
  type ManagedSession,
  type SessionBindingTarget,
  type ProjectNotificationTarget,
  type SessionRuntimeOverrides
} from "../state/runtime-state.js";
import {
  readCodexDesktopProjects,
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
import type { WeixinApiClient } from "../weixin/api.js";
import type { MonitorOptions } from "../weixin/monitor.js";
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
import { WorkspaceIDEManager, type IDEWorkspace } from "../ide/manager.js";
import { withIDEEntry } from "../ide/completion.js";
import { desktopIDEProjectId } from "../ide/project-identity.js";
import { IDEApprovalService } from "../ide/approval-service.js";
import { BindingExpiryCoordinator, type ExpiringBinding } from "./binding-expiry.js";
import type { BindingExpiry } from "../state/binding-expiry.js";

export class RuntimeConfigurationBusyError extends Error {
  constructor() { super("Gateway 正在处理消息、等待原生回执或应用配置；此次操作未提交、任务未中断，请稍后重试。"); }
}

export type AccountRunStatus = "stopped" | "starting" | "running" | "error";

export type AccountSummary = PublicWeixinAccount & {
  connection?: ChannelConnectionStatus;
  capabilities?: ChannelCapabilities;
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
  runtimeRecovery?: ReturnType<ThreadEventHub["status"]>["runtimeRecovery"];
  accountId: string;
  active: boolean;
  responding: boolean;
  binding: SessionBindingTarget & { bound: boolean; expiry?: BindingExpiry;
    conversation?: import("../channels/types.js").ChannelConversationIdentity;
    interaction?: InteractionRouteStatus; deliveryRoute?: "available" | "unconfirmed"; nativeUnavailable?: boolean };
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
    hostId?: string;
    sourceProjectId?: string;
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
  client?: ChannelClient;
  connection?: ChannelConnectionStatus;
  webhook?: ChannelMessageWebhook;
  error?: string;
};

type DirectChannelText = {
  readonly recipientId: string;
  readonly text: string;
  readonly contextToken?: string;
};

export type AccountManagerOptions = {
  adapterFactory?: ChannelAdapterFactory;
  paths: StatePaths;
  configProvider?: () => CodexImGatewayConfig;
  ideProjectsProvider?: () => readonly CodexProjectCandidate[];
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
      onTaskChanged: (task: CodexSessionTask) => void | Promise<void>;
      onActivity: (activity: CodexSessionActivity) => Promise<void>;
      onRecoveredCompletion?: (completion: CodexSessionCompletion) => Promise<void>;
    }
  ) => CodexSessionCompletionMonitor;
  codexDesktopApprovalMonitorFactory?: (
    handlers: CodexDesktopRequestMonitorOptions
  ) => CodexDesktopRequestMonitor;
  codexDesktopRequestMonitorFactory?: (
    handlers: CodexDesktopRequestMonitorOptions
  ) => CodexDesktopRequestMonitor;
  taskboardClientFactory?: (url: string) => TaskboardClient;
  llmWiki?: LlmWikiMcpClientPool;
  channelCapabilities?: ChannelCapabilityProvider;
};

export class AccountManager {
  private readonly accountOperations = new SessionControlQueue();
  private stoppingAll = false;
  readonly ide: WorkspaceIDEManager;
  readonly ideApprovals: IDEApprovalService;
  readonly admission: AdmissionService;
  private readonly userInputRoutes = new WeakMap<CodexDesktopUserInput, { service: BridgeService; recipientId: string }>();
  private readonly approvalRoutes = new WeakMap<CodexDesktopApproval, { service: BridgeService; recipientId: string }>();
  private readonly sessionApprovalRoutes = new WeakMap<CodexApprovalRequest, { service: BridgeService; recipientId: string }>();
  private readonly interactionRouting: InteractionRoutingJournal;
  private readonly unresolvedInteractions = new Set<string>();
  private readonly entries = new Map<string, RuntimeEntry>();
  /** Account lifecycle and Web requests share the same state owner, even while stopped. */
  private readonly stores = new Map<string, RuntimeStateStore>();
  private readonly inputReceipts = new Map<string, InboundReceiptJournal>();
  private readonly respondingSessions = new Map<string, number>();
  private readonly configProvider: () => CodexImGatewayConfig;
  private readonly adapterFactory: ChannelAdapterFactory;
  private readonly bridgeFactory: (input: ConstructorParameters<typeof BridgeService>[0]) => BridgeService;
  private readonly runnerFactory: (config: CodexImGatewayConfig) => CodexBridgeBackend;
  private readonly codexSessionMonitorFactory: NonNullable<AccountManagerOptions["codexSessionMonitorFactory"]>;
  private readonly codexDesktopRequestMonitorFactory: NonNullable<AccountManagerOptions["codexDesktopRequestMonitorFactory"]>;
  private readonly externalCodexTasks = new Map<string, CodexSessionTask>();
  private readonly membershipReads = new Map<string, Promise<CodexThreadState>>();
  private readonly ideProjectReads = new Map<string, Promise<CodexProjectCatalog>>();
  private readonly managedTurnCompletions = new Set<string>();
  private readonly threadEvents: ThreadEventHub;
  private readonly sessionControls: SessionControlJournal;
  private readonly turnAudience: TurnAudienceJournal;
  private readonly nativeQueue: NativeQueueCoordinator;
  private readonly capacityRecovery: CapacityRecoveryCoordinator;
  private readonly systemRecovery: SystemErrorRecoveryCoordinator;
  private readonly bindingExpiry: BindingExpiryCoordinator;
  private nativeQueueTimer?: NodeJS.Timeout;
  private readonly nativeQueueWarningAt = new Map<string, number>();
  private readonly taskboardClientFactory: (url: string) => TaskboardClient;
  private readonly taskboardWorkbench: TaskboardWorkbench;
  private readonly recentTaskboardNotifications = new Map<string, number>();
  private readonly llmWiki: LlmWikiMcpClientPool;
  private readonly channelCapabilities: ChannelCapabilityProvider;
  private runtimeConfigurationChanging = false;
  private runner?: CodexBridgeBackend;
  private codexSessionMonitor?: CodexSessionCompletionMonitor;
  private codexDesktopRequestMonitor?: CodexDesktopRequestMonitor;
  private taskboard?: TaskboardClient;
  private taskboardController?: AbortController;
  private taskboardTask?: Promise<void>;

  constructor(private readonly options: AccountManagerOptions) {
    const principalAccounts = () => listAccounts(options.paths).map(account => ({ accountId: account.accountId, channel: accountChannel(account),
      providerId: account.channel === "dingtalk" ? account.clientId : account.channel === "feishu" ? account.appId : account.botId ?? account.accountId }));
    this.ideApprovals = new IDEApprovalService({ root: options.paths.root,
      // Exact actor lookup only. Never use requireAccess(actor, conversation):
      // its group-wide ACL is intentionally insufficient for browser pairing.
      allowedPersonal: principal => this.storeFor(principal.accountId).listPairedSenderIds().includes(principal.actorId),
      accounts: principalAccounts });
    this.admission = new AdmissionService({ root: options.paths.root, accounts: principalAccounts,
      allowed: (accountId, actorId, conversationId) => {
        const paired = this.storeFor(accountId).listPairedSenderIds();
        const configured = this.configProvider().allowedSenderIds;
        return [...paired, ...configured].some(id => id === actorId || id === conversationId);
      }, allow: (accountId, target) => this.allowSender(accountId, target) });
    this.ide = new WorkspaceIDEManager({ root: options.paths.root, resolve: (accountId, sessionId) => this.ideWorkspace(accountId, sessionId),
      refresh: (accountId, sessionId) => this.refreshIDEWorkspace(accountId, sessionId) });
    this.interactionRouting = new InteractionRoutingJournal(path.join(options.paths.runtimeDir, "interaction-routing.json"));
    this.sessionControls = new SessionControlJournal(path.join(options.paths.runtimeDir, "session-controls.json"));
    this.turnAudience = new TurnAudienceJournal(path.join(options.paths.runtimeDir, "turn-audience.json"));
    this.nativeQueue = new NativeQueueCoordinator(path.join(options.paths.runtimeDir, "native-submissions.json"));
    migrateCardBootstrap(options.paths);
    this.threadEvents = new ThreadEventHub({
      legacyQueueTerminal: (sub, turnId) => {
        const [accountId, sessionId] = JSON.parse(sub.key) as string[];
        return this.nativeQueue.hasLegacyTerminal({ accountId, sessionId, hostId: sub.hostId, threadId: sub.threadId, turnId });
      },
      decorateProgress: (sub, text) => {
        let url: string | undefined;
        try {
          const [accountId, sessionId] = JSON.parse(sub.key) as string[];
          url = this.ide.entry(accountId, sessionId)?.url;
        } catch { /* Optional metadata fails closed, never reuse an old URL. */ }
        return withIDEEntry(text, url, { atEnd: true });
      },
      decorateFinal: async (sub, text) => {
        const [accountId, sessionId] = JSON.parse(sub.key) as string[];
        let url: string | undefined;
        try { url = (await this.ide.freshEntry(accountId, sessionId))?.url; } catch { /* Optional metadata fails closed. */ }
        return withIDEEntry(text, url);
      },
      onThreadState: (sub, state) => { this.observeThreadMembership(sub.hostId, state); },
      onSystemError: (sub, snapshot) => this.systemRecovery.offer(snapshot, sub.hostId),
      onRecoveryObservation: (sub, snapshot) => this.systemRecovery.offer(snapshot, sub.hostId),
      filePath: path.join(options.paths.runtimeDir, "thread-subscriptions.json"),
      turnAudience: this.turnAudience,
      subscriptions: () => this.threadSubscriptions(),
      backend: () => this.runnerFor(this.configProvider()),
      onCapacityFailure: scope => this.capacityRecovery.offer(scope),
      holdsCapacityStart: scope => this.capacityRecovery.holdsStart(scope),
      acceptedInputs: () => [ ...this.sessionControls.acceptedPresentationInputs(),
        ...[...this.entries.values()].flatMap(entry => entry.service?.acceptedPresentationInputs?.() ?? []) ]
    });
    this.systemRecovery = new SystemErrorRecoveryCoordinator({
      filePath: path.join(options.paths.runtimeDir, "system-error-recovery.json"),
      backend: () => this.runnerFor(this.configProvider()),
      lease: scope => this.systemRecoveryLease(scope),
      blocked: scope => this.capacityRecovery?.hasPending(scope.threadId, scope.hostId)
        || [...this.entries.keys()].some(accountId => this.nativeQueue.list(accountId).some(receipt => receipt.threadId === scope.threadId
          && receipt.hostId === scope.hostId && ["submitting", "starting", "running", "uncertain"].includes(receipt.status)))
        || [...this.inputReceipts.values()].some(journal => Object.values(journal.snapshot()).some(receipt => receipt.threadId === scope.threadId
          && (receipt.hostId ?? "local") === scope.hostId && ["submitting", "unconfirmed"].includes(receipt.phase))),
      notice: (scope, status, state, assertSource) => this.threadEvents.systemRecoveryNotice(scope, status, state, assertSource),
    });
    this.capacityRecovery = new CapacityRecoveryCoordinator({
      filePath: path.join(options.paths.runtimeDir, "capacity-recovery.json"),
      backend: () => this.runnerFor(this.configProvider()),
      eligible: scope => !this.runtimeConfigurationChanging && !this.stoppingAll && !this.systemRecovery.hasPendingRestore(scope.threadId, scope.hostId)
        && [...this.entries.values()].some(entry => entry.status === "running" && entry.store?.listSessions().some(session =>
        session.threadId === scope.threadId && session.follow !== false
        && (session.hostId ?? entry.store?.getProject(session.projectId ?? "")?.hostId ?? "local") === scope.hostId
        && entry.store?.getBoundSession(session.senderId)?.id === session.id)),
      notice: (scope, text) => this.threadEvents.capacityNotice(scope, text),
      retireProjection: (scope, text) => this.threadEvents.retireCapacityProjection(scope, text),
      accepted: (scope, turnId) => {
        this.interactionRouting.inheritTurn(scope.hostId, scope.threadId, scope.turnId, turnId);
        return this.threadEvents.capacityAccepted(scope, turnId);
      },
      progress: (scope, text) => this.threadEvents.activity(scope.hostId, scope.threadId, scope.turnId, text),
      handlers: scope => ({
        onApproval: request => {
          const route = this.interactionRouting.resolve(scope.hostId, scope.threadId, this.interactionDestinations(), request.turnId).destination;
          const session = route && this.entries.get(route.accountId)?.store?.getSession(route.sessionId);
          return route && session ? this.requestSessionApproval(route.accountId, session, request) : Promise.resolve("decline" as const);
        },
        onApprovalResult: (request, result) => this.reportSessionApprovalResult(request, result),
        onUserInput: request => {
          const route = this.interactionRouting.resolve(scope.hostId, scope.threadId, this.interactionDestinations(), request.turnId).destination;
          return route ? this.entries.get(route.accountId)?.service?.requestUserInput(route.recipientId, request, scope.hostId)
            ?? Promise.resolve(undefined) : Promise.resolve(undefined);
        },
        onUserInputResult: (request, result) => {
          const route = this.interactionRouting.resolve(scope.hostId, scope.threadId, this.interactionDestinations(), request.turnId).destination;
          return route ? this.entries.get(route.accountId)?.service?.reportUserInputResult(route.recipientId, request, result, scope.hostId) : undefined;
        }
      }),
      terminal: async (scope, text, outcome) => {
        await this.threadEvents.capacityTerminal(scope, parseActionBlocks(text, { strict: false }).visibleText.trim() || "处理完成。", outcome);
        const route = this.interactionRouting.resolve(scope.hostId, scope.threadId, this.interactionDestinations(), scope.turnId).destination;
        if (route) await this.entries.get(route.accountId)?.service?.applyRecoveredOutput(route.sessionId, text, scope);
      }
    });
    this.configProvider = options.configProvider ?? (() => loadConfig(options.paths));
    this.bindingExpiry = new BindingExpiryCoordinator({
      candidates: () => this.expiringBindings(), current: binding => this.bindingExpiryCurrent(binding),
      idle: binding => this.bindingExpiryIdle(binding),
      expire: async binding => {
        if (!this.bindingExpiryCurrent(binding)) return;
        const entry = this.entries.get(binding.accountId)!;
        if (!entry.store!.expireBinding(binding.sessionId, binding.expected, this.configProvider().bindingIdleDays)) return;
        entry.service?.clearConversationBindingState?.(binding.expected.conversationId);
        this.refreshDesktopRequestSubscriptions();
        await this.threadEvents.refresh();
      }
    });
    this.adapterFactory = options.adapterFactory ?? channelFactoryWithLegacyOverrides(options);
    this.bridgeFactory = options.bridgeFactory ?? ((input) => new BridgeService(input));
    this.runnerFactory = options.runnerFactory ?? ((config) => new CodexBackendRouter({
      backend: config.codexBackend,
      appServerTransport: config.codexAppServerTransport,
      codexBin: config.codexBin,
      execSandbox: config.codexExecSandbox,
      onThreadMutation: (threadId, hostId) => {
        if (this.systemRecovery.hasPendingRestore(threadId, hostId))
          throw new CodexInterventionError("原生会话正在恢复原活动状态，结果尚未确认；本条输入未提交，请查看系统恢复进展。");
        this.capacityRecovery.cancel(threadId, hostId); this.systemRecovery.cancel(threadId, hostId);
      }
    }));
    this.codexSessionMonitorFactory = options.codexSessionMonitorFactory
      ?? ((handlers) => new CodexSessionCompletionMonitor(handlers));
    this.codexDesktopRequestMonitorFactory = options.codexDesktopRequestMonitorFactory ?? options.codexDesktopApprovalMonitorFactory
      ?? ((handlers) => new CodexDesktopRequestMonitor(handlers));
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
    this.ensureCodexDesktopRequestMonitor();
    this.ensureCodexSessionMonitor();
    this.threadEvents.start();
    this.capacityRecovery.start();
    this.startTaskboardMonitor();
  }

  async stopAll(): Promise<void> {
    this.stoppingAll = true;
    const errors: unknown[] = [];
    const attempt = async (cleanup: () => unknown) => { try { await cleanup(); } catch (error) { errors.push(error); } };
    try {
      await attempt(() => this.bindingExpiry.stop());
      await attempt(() => this.capacityRecovery.stop());
      await attempt(() => this.systemRecovery.stop());
      // Abort all ingress before waiting for any observer or journal cleanup.
      const accounts = [...this.entries.keys()].map(id => attempt(() => this.accountOperations.run(id, () => this.stopRuntime(id))));
      this.taskboardController?.abort();
      await attempt(() => this.codexDesktopRequestMonitor?.stop());
      this.codexDesktopRequestMonitor = undefined;
      await attempt(() => this.codexSessionMonitor?.stop());
      this.codexSessionMonitor = undefined;
      this.externalCodexTasks.clear();
      this.unresolvedInteractions.clear();
      this.managedTurnCompletions.clear();
      await attempt(() => this.threadEvents.stop());
      await attempt(() => this.taskboardTask);
      this.taskboardController = undefined;
      this.taskboardTask = undefined;
      this.taskboard = undefined;
      this.recentTaskboardNotifications.clear();
      await Promise.all(accounts);
      await attempt(() => this.closeRunner());
      await attempt(() => this.llmWiki.close());
      if (errors.length) throw new AggregateError(errors, "Gateway 停止时部分资源清理失败；其余资源已继续清理。");
    } finally { this.stoppingAll = false; }
  }

  private assertRuntimeWritable(): void {
    if (this.runtimeConfigurationChanging || this.stoppingAll) throw new RuntimeConfigurationBusyError();
  }

  async reconfigureRuntime(update: () => Promise<void | (() => Promise<void>)>): Promise<void> {
    if (this.runtimeConfigurationChanging || this.stoppingAll || this.respondingSessions.size || this.capacityRecovery.hasInFlightWork() || this.systemRecovery.hasInFlightWork()
      || [...this.entries.values()].some(entry => entry.service?.hasInFlightWork?.())) throw new RuntimeConfigurationBusyError();
    this.runtimeConfigurationChanging = true;
    const accounts = [...this.entries].filter(([, entry]) => entry.controller && !entry.controller.signal.aborted).map(([id]) => id);
    let rollback: void | (() => Promise<void>) = undefined;
    try { rollback = await update(); await this.restartIdleRuntimes(accounts); }
    catch (error) {
      if (rollback) {
        try { await rollback(); await this.restartIdleRuntimes(accounts); }
        catch (restore) { throw new AggregateError([error, restore], "配置切换失败，旧运行态恢复也未完成，请检查服务状态。"); }
      }
      throw error;
    }
    finally { this.runtimeConfigurationChanging = false; }
  }

  async restartRunning(): Promise<void> { return this.reconfigureRuntime(async () => {}); }

  private async restartIdleRuntimes(accounts?: string[]): Promise<void> {
    const running = accounts ?? listAccounts(this.options.paths)
      .filter((account) => { const entry = this.entries.get(account.accountId); return entry?.controller && !entry.controller.signal.aborted; })
      .map((account) => account.accountId);
    await Promise.all(running.map(id => this.accountOperations.run(id, () => this.stopAccountOwned(id, false))));
    this.taskboardController?.abort();
    await this.taskboardTask;
    this.taskboardController = undefined;
    this.taskboardTask = undefined;
    this.taskboard = undefined;
    await this.closeRunner();
    await Promise.all(running.map(id => this.accountOperations.run(id, () => this.startAccountOwned(id, false))));
    this.startTaskboardMonitor();
  }

  async refreshAccount(accountId: string): Promise<AccountSummary> {
    accountId = loadAccount(this.options.paths, accountId).accountId;
    return this.accountOperations.run(accountId, async () => {
      this.assertRuntimeWritable();
      const account = loadAccount(this.options.paths, accountId);
      const existing = this.entries.get(account.accountId);
      if (existing?.status === "running" || existing?.status === "starting") {
        await this.stopAccountOwned(account.accountId, false);
      }
      return this.startAccountOwned(account.accountId, false);
    });
  }

  repairQueuedTerminal(accountId: string, sessionId: string, turnId: string): Promise<boolean> {
    const key = JSON.stringify([loadAccount(this.options.paths, accountId).accountId, sessionId]);
    return this.threadEvents.repairQueuedTerminal(key, turnId);
  }

  async startAccount(accountId: string, persist = true): Promise<AccountSummary> {
    accountId = loadAccount(this.options.paths, accountId).accountId;
    return this.accountOperations.run(accountId, () => {
      this.assertRuntimeWritable(); return this.startAccountOwned(accountId, persist);
    });
  }
  private async startAccountOwned(accountId: string, persist: boolean): Promise<AccountSummary> {
    const account = persist ? setAccountEnabled(this.options.paths, accountId, true) : loadAccount(this.options.paths, accountId);
    const existing = this.entries.get(account.accountId);
    if (existing?.status === "running" || existing?.status === "starting") {
      return this.summary(account);
    }

    const controller = new AbortController();
    const statePaths = accountStatePaths(this.options.paths, account.accountId);
    const store = this.storeFor(account.accountId);
    this.synchronizeManagedProjects(store);
    const channel = accountChannel(account);
    const webhook = new ChannelMessageWebhook({
      accountId: account.accountId,
      channel,
      ...(account.webhookUrl ? { webhookUrl: account.webhookUrl } : {}),
      ...(account.webhookProvider ? { webhookProvider: account.webhookProvider } : {})
    });
    const config = this.configProvider();
    store.prepareBindingExpiry(config.bindingIdleDays);
    const adapter = this.adapterFactory(account, { inboundDir: statePaths.inboundDir, maxInboundBytes: config.maxInboundBytes });
    const client = adapter.client;
    const runner = this.runnerFor(config);
    const service = this.bridgeFactory({
      assertRuntimeWritable: () => this.assertRuntimeWritable(),
      ideApprovals: this.ideApprovals,
      admission: this.admission,
      ideProviderId: account.channel === "dingtalk" ? account.clientId : account.channel === "feishu" ? account.appId : account.botId ?? account.accountId,
      ideEntry: async session => (await this.ide.freshEntry(account.accountId, session.id))?.url,
      ideProgressEntry: session => this.ide.entry(account.accountId, session.id)?.url,
      accountId: account.accountId,
      nativeQueue: this.nativeQueue,
      deferCapacityFailure: scope => this.capacityRecovery.offer(scope),
      requestCapacityRecovery: (scope, assertCurrent) => this.capacityRecovery.request(scope, assertCurrent),
      requestSystemRecovery: (scope, assertCurrent) => this.systemRecovery.request(scope, assertCurrent),
      sessionControls: this.sessionControls,
      turnAudience: this.turnAudience,
      onAcceptedInput: input => {
        this.capacityRecovery.cancel(input.threadId, input.hostId);
        this.systemRecovery.cancel(input.threadId, input.hostId);
        return this.threadEvents.acceptedInput(input);
      },
      sessionFollow: {
        status: (session) => this.threadEvents.status(JSON.stringify([account.accountId, session.id])),
        synchronize: async (session, recovery) => {
          if (store.getBoundSession(session.senderId)?.id !== session.id) return {
            status: "failed" as const, failure: { code: "binding-changed" as const, message: "当前对话已切换绑定，未同步旧会话。" }
          };
          this.ensureCodexSessionMonitor();
          this.refreshDesktopRequestSubscriptions();
          return this.threadEvents.synchronize(JSON.stringify([account.accountId, session.id]), recovery);
        }
      },
      sessionInteractions: {
        status: session => this.getSessionInteractionRoute(account.accountId, session.id),
        setPrimary: session => this.setSessionInteractionPrimary(account.accountId, session.id)
      },
      onSubscriptionsChanged: () => {
        this.ensureCodexSessionMonitor();
        this.refreshDesktopRequestSubscriptions();
        return this.threadEvents.refresh();
      },
      onTurnStarted: (session, turnId) => {
        this.rememberInteractionOrigin(account.accountId, session, turnId);
        this.ensureCodexSessionMonitor();
        this.refreshDesktopRequestSubscriptions();
        return this.threadEvents.managedTurnStarted({
          key: JSON.stringify([account.accountId, session.id]),
          hostId: session.hostId ?? store.getProject(session.projectId ?? "")?.hostId ?? "local",
          threadId: session.threadId ?? "", recipientId: session.senderId, client, managed: true
        }, turnId);
      },
      createTextStream: (session, acceptedTurnId) => this.threadEvents.prepareManagedStream({
        key: JSON.stringify([account.accountId, session.id]),
        hostId: session.hostId ?? store.getProject(session.projectId ?? "")?.hostId ?? "local",
        threadId: session.threadId ?? "", recipientId: session.senderId, client, managed: true,
        contextToken: store.getContextToken(session.senderId),
        onTextDelivered: (part) => webhook.publish({ direction: "outbound", id: part.messageId,
          recipientId: session.senderId, text: part.text, attachments: [] })
      }, acceptedTurnId),
      deliverTurnResult: (session, turnId, text) => this.threadEvents.managedCompletion({
        key: JSON.stringify([account.accountId, session.id]),
        hostId: session.hostId ?? store.getProject(session.projectId ?? "")?.hostId ?? "local",
        threadId: session.threadId ?? "", recipientId: session.senderId, client, managed: true,
        contextToken: store.getContextToken(session.senderId)
      }, turnId, text),
      config,
      stateStore: store,
      inputReceipts: this.receiptsFor(account.accountId),
      channel: client,
      inboundDir: statePaths.inboundDir,
      inboundReferences: new InboundReferenceStore(path.join(statePaths.inboundDir, "references.json")),
      userInputFilePath: path.join(this.options.paths.runtimeDir, account.accountId, "user-input.json"),
      runner,
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
    this.bindingExpiry.start();
    this.ensureNativeQueueRecovery();
    this.refreshDesktopRequestSubscriptions();

    const handleMessage = async (message: Parameters<BridgeService["handleMessage"]>[0]) => {
      if (controller.signal.aborted || this.entries.get(account.accountId) !== entry) throw new Error("渠道连接已更换，消息未提交。");
      const authorizedConversation = message.source === "native-menu"
        ? store.getAuthorizedConversation(message.senderId)
        : undefined;
      const messageWithConversation = authorizedConversation
        ? { ...message, replyTargetId: authorizedConversation }
        : message;
      {
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
      this.assertRuntimeWritable();
      await this.receiptsFor(account.accountId).handle(messageWithConversation, () => service.handleMessage(messageWithConversation));
    };
    const onMessageError = async (error: unknown, message: Parameters<BridgeService["handleMessage"]>[0]) => {
      this.receiptsFor(account.accountId).releasePreparation(message.id);
      if (wasMessageHandlingErrorReported(error)) return;
      await this.sendChannelText(entry, {
        recipientId: message.replyTargetId ?? message.senderId,
        text: userFacingMessageHandlingError(error),
        contextToken: store.getContextToken(message.replyTargetId ?? message.senderId)
      });
    };
    const task = adapter.monitor({
      signal: controller.signal,
      checkpoint: store.getSyncKey(),
      onCheckpoint: (checkpoint) => { if (!controller.signal.aborted && this.entries.get(account.accountId) === entry) store.setSyncKey(checkpoint); },
      onStatus: (connection) => {
        if (controller.signal.aborted || this.entries.get(account.accountId) !== entry) return;
        entry.connection = connection;
        entry.status = connection.state === "connected" ? "running"
          : connection.state === "stopped" ? "stopped" : connection.state === "error" ? "error" : "starting";
        entry.error = connection.state === "error" ? connection.detail : undefined;
      },
      claimMessage: (message) => {
        if (controller.signal.aborted || this.entries.get(account.accountId) !== entry) return false;
        const conversation = message.source === "native-menu" ? store.getAuthorizedConversation(message.senderId) : undefined;
        if (!this.receiptsFor(account.accountId).claim(conversation ? { ...message, replyTargetId: conversation } : message)) return false;
        // Compatibility tombstone for code rollback. The new journal, rather
        // than this legacy bounded list, decides preparation recovery.
        store.claimProcessedMessage(message.id);
        return true;
      },
      onMessage: handleMessage,
      onMessageError
    });
    entry.task = task.then(() => {
      entry.status = "stopped";
      entry.connection = { state: "stopped" };
    }).catch((error: unknown) => {
      if (controller.signal.aborted) {
        entry.status = "stopped";
        return;
      }
      entry.status = "error";
      entry.connection = { state: "error", detail: "Channel monitor failed" };
      entry.error = error instanceof Error ? error.message : String(error);
    });
    return this.summary(account);
  }

  async stopAccount(accountId: string, persist = true): Promise<AccountSummary> {
    accountId = loadAccount(this.options.paths, accountId).accountId;
    return this.accountOperations.run(accountId, () => {
      this.assertRuntimeWritable(); return this.stopAccountOwned(accountId, persist);
    });
  }
  private async stopAccountOwned(accountId: string, persist: boolean): Promise<AccountSummary> {
    const account = persist ? setAccountEnabled(this.options.paths, accountId, false) : loadAccount(this.options.paths, accountId);
    await this.stopRuntime(account.accountId);
    return this.summary(account);
  }
  private async stopRuntime(accountId: string): Promise<void> {
    const entry = this.entries.get(accountId);
    const errors: unknown[] = [];
    if (entry) {
      try { entry.service?.suspendUserInputs?.(); } catch (error) { errors.push(error); }
      try { entry.controller?.abort(); await entry.task; } catch (error) { errors.push(error); }
      finally { entry.status = "stopped"; entry.connection = { state: "stopped" }; }
    }
    try { if (!this.stoppingAll) this.refreshDesktopRequestSubscriptions(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "渠道账号停止时部分清理失败，其余资源已继续清理。");
  }

  async removeAccount(accountId: string, options: { retainHistory?: boolean } = {}): Promise<void> {
    accountId = loadAccount(this.options.paths, accountId).accountId;
    return this.accountOperations.run(accountId, async () => {
      this.assertRuntimeWritable();
      const account = loadAccount(this.options.paths, accountId);
      const retainHistory = options.retainHistory === true && accountChannel(account) === "weixin";
      await this.stopAccountOwned(accountId, false);
      if (retainHistory) {
        retainAccountHistory(this.options.paths, account as WeixinAccount);
      } else if (accountChannel(account) === "weixin" && (account as WeixinAccount).userId) {
        const weixin = account as WeixinAccount;
        const userId = weixin.userId;
        if (userId) forgetRetainedAccount(this.options.paths, { accountId: weixin.accountId, userId });
      }
      this.admission.forgetAccount(accountId);
      deleteAccount(this.options.paths, accountId);
      if (!retainHistory) {
        fs.rmSync(path.dirname(accountStatePaths(this.options.paths, account.accountId).statePath), {
          recursive: true,
          force: true
        });
      }
      this.entries.delete(account.accountId);
      this.stores.delete(account.accountId);
      this.inputReceipts.delete(account.accountId);
      this.interactionRouting.reconcileBindings([], [account.accountId]);
      this.refreshDesktopRequestSubscriptions();
    });
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
      return store.listSessions().map(session => this.sessionSummary(account.accountId, session,
        store.getBoundSession(session.senderId)?.id === session.id));
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Only already-managed project membership grants an IDE target. No caller
   * supplies a path; independent/QA sessions cannot inherit a nearby project. */
  ideWorkspace(accountId: string, sessionId: string): IDEWorkspace | undefined {
    try {
      const store = this.storeFor(accountId);
      let session = store.getSession(sessionId);
      if (!session?.projectId || session.projectBinding === "none" || session.mode === "qa") return;
      let project = store.getProject(session.projectId); if (!project) return;
      const hostId = session.hostId ?? project.hostId ?? "local";
      if (hostId !== (project.hostId ?? "local") || (project.projectKind === "remote" && hostId === "local")) return;
      // Cheap fresh Desktop membership check also protects already-issued local
      // URLs and proxy requests. cwd is never supplied as membership evidence.
      if (hostId === "local" && session.threadId && project.sourceProjectId && this.configProvider().codexBackend !== "exec") {
        const state = desktopSessionMembership()( { threadId: session.threadId, persistence: "active", runtimeStatus: "unknown", activeFlags: [] });
        if (!this.observeThreadMembership(hostId, state)) return;
        // Stopped accounts have disk-backed ephemeral stores, not a shared
        // running store. Re-read after reconciliation in either lifecycle.
        session = this.storeFor(accountId).getSession(sessionId);
        if (!session?.projectId || session.projectBinding === "none") return;
        project = this.storeFor(accountId).getProject(session.projectId); if (!project) return;
      }
      // Desktop can change project membership while Gateway is running. Read
      // its full root set, not just the thread cwd; never mix hosts or backends.
      const nativeProject = this.configProvider().codexBackend === "exec" ? undefined
        : this.ideProjects().find(candidate => (candidate.hostId ?? "local") === hostId
          && (project.sourceProjectId ? candidate.projectId === project.sourceProjectId : candidate.workspace === project.workspace));
      if (nativeProject?.available === false) return;
      const roots = nativeProject?.rootPaths ?? (nativeProject ? [nativeProject.workspace] : project.rootPaths);
      // A worktree session replaces its project's primary checkout, rather
      // than exposing both checkouts. Sibling roots remain explicit members.
      const rootPaths = roots?.length && !roots.includes(session.workspace)
        ? [session.workspace, ...roots.filter(root => root !== project.workspace)] : roots;
      return { owner: "gateway-owner", sessionId, hostId, workspace: session.workspace, projectName: project.name,
        projectId: project.id, nativeThreadId: session.threadId,
        ...(rootPaths && rootPaths.length > 1 ? { rootPaths: [...rootPaths] } : {}) };
    } catch { return; }
  }

  private async refreshIDEWorkspace(accountId: string, sessionId: string): Promise<IDEWorkspace | undefined> {
    const store = this.storeFor(accountId), session = store.getSession(sessionId);
    if (!session || session.mode === "qa") return;
    const hostId = session.hostId ?? store.getProject(session.projectId ?? "")?.hostId ?? "local";
    if (!session.threadId || this.configProvider().codexBackend === "exec") return this.ideWorkspace(accountId, sessionId);
    const state = await this.readMembership(session.threadId, hostId);
    if (state.persistence === "archived" || state.persistence === "missing") return;
    if (state.threadId !== session.threadId || state.internal || state.persistence !== "active" || !state.cwd
      || state.projectMembership === "unknown" || !this.observeThreadMembership(hostId, state))
      throw new Error("当前原生 session 的项目归属尚未核对，未开放 IDE");
    return this.ideWorkspace(accountId, sessionId);
  }

  private ideProjects() { return (this.options.ideProjectsProvider ?? readCodexDesktopProjects)(); }
  private readIDEProjects(hostId: string): Promise<CodexProjectCatalog> {
    const pending = this.ideProjectReads.get(hostId); if (pending) return pending;
    let timer: NodeJS.Timeout | undefined;
    const work = Promise.race([this.runnerFor().listProjects(hostId, { timeoutMs: 2_000 }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("原生项目目录核验超时")), 5_000);
    })]).finally(() => { if (timer) clearTimeout(timer); if (this.ideProjectReads.get(hostId) === work) this.ideProjectReads.delete(hostId); });
    this.ideProjectReads.set(hostId, work); return work;
  }
  private async ideMembershipIdentity(state: CodexThreadState, hostId: string): Promise<CodexThreadState> {
    if (state.persistence !== "active" || state.projectMembership !== "assigned" || !state.projectId) return state;
    const projects = this.ideProjects();
    if (projects.some(p => p.projectId === state.projectId && (p.hostId ?? "local") === hostId)
      || listAccounts(this.options.paths).some(account => this.storeFor(account.accountId).listProjects()
        .some(p => p.sourceProjectId === state.projectId && (p.hostId ?? "local") === hostId))) return state;
    const catalog = await this.readIDEProjects(hostId);
    const native = catalog.backend === "app-server" && catalog.projects.find(p => p.id === state.projectId);
    const projectId = native && desktopIDEProjectId(native, hostId, projects);
    return projectId ? { ...state, projectId } : state;
  }

  private readMembership(threadId: string, hostId: string): Promise<CodexThreadState> {
    const key = JSON.stringify([hostId, threadId]), pending = this.membershipReads.get(key);
    if (pending) return pending;
    let timer: NodeJS.Timeout | undefined;
    const work = Promise.race([this.runnerFor().inspectThread(threadId, hostId, { includeTurns: false, timeoutMs: 5_000 })
      .then(state => this.ideMembershipIdentity(state, hostId)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("无法核对原生 session 目录，未启动 IDE")), 15_000); })])
      .finally(() => { if (timer) clearTimeout(timer); if (this.membershipReads.get(key) === work) this.membershipReads.delete(key); });
    this.membershipReads.set(key, work);
    return work;
  }

  /** Membership is a host/thread fact, never an IM conversation property. Only
   * explicit observations reconcile durable edges; unknown leaves them intact. */
  private observeThreadMembership(hostId: string, state: CodexThreadState): boolean {
    if (state.internal || state.persistence !== "active" || state.projectMembership === "unknown"
      || !state.projectId && state.projectMembership !== "none") return false;
    const native = state.projectId ? this.ideProjects().find(p => p.projectId === state.projectId && (p.hostId ?? "local") === hostId) : undefined;
    for (const account of listAccounts(this.options.paths)) {
      const store = this.storeFor(account.accountId);
      const matching = store.listSessions().filter(s => s.threadId === state.threadId && s.mode !== "qa"
        && (s.hostId ?? store.getProject(s.projectId ?? "")?.hostId ?? "local") === hostId);
      if (!matching.length) continue;
      let project = state.projectId ? store.listProjects().find(p => p.sourceProjectId === state.projectId && (p.hostId ?? "local") === hostId) : undefined;
      if (state.projectId && !project && native?.available !== false && native) project = store.createProject(native.name, native.workspace,
        { sourceProjectId: native.projectId, hostId, projectKind: native.projectKind, rootPaths: native.rootPaths });
      if (state.projectId && !project) return false;
      store.reconcileThreadProject(state.threadId, hostId, project?.id, state.cwd);
    }
    return true;
  }

  listProjects(accountId?: string): AccountProject[] {
    const accounts = accountId ? [loadAccount(this.options.paths, accountId)] : listAccounts(this.options.paths);
    return accounts.flatMap((account) => {
      const store = this.storeFor(account.accountId);
      return store.listProjects().map((project) => this.projectSummary(account.accountId, project, store));
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listCodexProjects(runner = this.runnerFor(this.configProvider())): Promise<readonly CodexProjectCandidate[]> {
    return projectCandidatesFromBackendCatalog(await runner.listProjects());
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
    metadata: { sourceProjectId?: string; projectKind?: "local" | "remote"; hostId?: string; rootPaths?: readonly string[] } = {}
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

  /** Called only after the management boundary validates an exact live catalog
   * choice. Registration authorizes this project, without widening the global
   * arbitrary-workspace allowlist or requiring a two-file config transaction. */
  registerCodexProject(accountId: string, name: string, candidate: CodexProjectCandidate): AccountProject {
    const store = this.storeFor(accountId);
    const project = store.createProject(name, candidate.workspace, { sourceProjectId: candidate.projectId,
      rootPaths: candidate.rootPaths, projectKind: candidate.projectKind, hostId: candidate.hostId });
    this.ensureCodexSessionMonitor();
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
    if (!project && !isWorkspaceAllowed(targetWorkspace, config.allowedWorkspaces)) {
      throw new Error(`Workspace is not allowed: ${targetWorkspace}`);
    }
    const session = this.storeFor(accountId).createSession(senderId, targetWorkspace, title, project?.id);
    this.storeFor(accountId).setInteractionMode(senderId, "session");
    this.refreshDesktopRequestSubscriptions();
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

  getSessionInteractionRoute(accountId: string, sessionId: string): InteractionRouteStatus {
    const session = requireSession(this.storeFor(accountId), sessionId);
    const destination = this.interactionDestination(accountId, session);
    const status = this.interactionRouting.resolve(destination.hostId, destination.threadId, this.interactionDestinations());
    return { ...status, current: status.destination?.accountId === accountId && status.destination.sessionId === sessionId };
  }

  setSessionInteractionPrimary(accountId: string, sessionId: string): InteractionRouteStatus {
    const session = requireSession(this.storeFor(accountId), sessionId);
    if (!session.threadId || !this.threadSubscriptions().some(binding => binding.enabled
      && binding.key === JSON.stringify([accountId, sessionId]))) throw new Error("请选择当前启用跟随的会话绑定，再设置主交互对话。");
    if (["archived", "missing"].includes(this.threadEvents.status(JSON.stringify([accountId, sessionId])).runtime?.persistence ?? "")) {
      throw new Error("原生会话已归档或不存在，不能设为提问入口；绑定记录仍保留。");
    }
    if (this.entries.get(accountId)?.client?.deliveryRouteStatus?.(session.senderId) === "unconfirmed") {
      throw new Error("此 IM 对话的投递身份尚未核验，请先在该对话向机器人发送消息，再设为提问入口。");
    }
    this.interactionRouting.setPrimary(this.interactionDestination(accountId, session));
    this.refreshDesktopRequestSubscriptions();
    return this.getSessionInteractionRoute(accountId, sessionId);
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
      assertCodexThreadRunnable(await this.runnerFor().inspectThread(pending.threadId, pending.hostId ?? project?.hostId));
    }
    const session = store.activateSession(sessionId);
    store.setInteractionMode(session.senderId, session.mode === "qa" ? "qa" : "session");
    this.refreshDesktopRequestSubscriptions();
    return this.sessionSummary(accountId, session, true);
  }

  resetSession(accountId: string, sessionId: string): AccountSession {
    const session = this.storeFor(accountId).resetSession(sessionId);
    this.refreshDesktopRequestSubscriptions();
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  deleteSession(accountId: string, sessionId: string): void {
    this.storeFor(accountId).deleteSession(sessionId);
    this.respondingSessions.delete(sessionRuntimeKey(accountId, sessionId));
    this.refreshDesktopRequestSubscriptions();
  }

  async unbindSession(accountId: string, sessionId: string, expected: SessionBindingTarget): Promise<{ session: AccountSession; changed: boolean }> {
    const store = this.storeFor(accountId);
    const result = store.unbindSession(sessionId, expected);
    if (result.changed) this.entries.get(accountId)?.service?.clearConversationBindingState?.(result.session.senderId);
    this.ensureCodexSessionMonitor();
    this.refreshDesktopRequestSubscriptions();
    await this.threadEvents.refresh();
    return { session: this.sessionSummary(accountId, result.session, false), changed: result.changed };
  }

  setBindingIdleDays(accountId: string, sessionId: string, expected: SessionBindingTarget & { generation: string }, days: number | null): AccountSession {
    const store = this.storeFor(accountId);
    store.setBindingIdleDays(sessionId, expected, days, this.configProvider().bindingIdleDays);
    return this.sessionSummary(accountId, store.getSession(sessionId)!, true);
  }

  /** Exposed for deterministic local verification; never submits native input. */
  checkBindingExpiry(): Promise<void> { return this.bindingExpiry.runOnce(); }

  private bindingExpiryRelated(store: RuntimeStateStore, conversationId: string): ExpiringBinding["related"] {
    return store.selectedConversationSessions(conversationId).map(session => ({ sessionId: session.id,
      hostId: store.sessionBindingTarget(session).hostId, threadId: session.threadId ?? null }));
  }

  private expiringBindings(): ExpiringBinding[] {
    const result: ExpiringBinding[] = [], days = this.configProvider().bindingIdleDays;
    for (const [accountId, entry] of this.entries) {
      if (entry.status !== "running" || !entry.store) continue;
      entry.store.prepareBindingExpiry(days);
      for (const session of entry.store.listSessions()) {
        if (entry.store.getBoundSession(session.senderId)?.id !== session.id) continue;
        const expiry = entry.store.getBindingExpiry(session.senderId, days);
        if (expiry?.status !== "due") continue;
        result.push({ accountId, sessionId: session.id,
          expected: { ...entry.store.sessionBindingTarget(session), generation: expiry.generation },
          related: this.bindingExpiryRelated(entry.store, session.senderId) });
      }
    }
    return result;
  }

  private bindingExpiryCurrent(binding: ExpiringBinding): boolean {
    const entry = this.entries.get(binding.accountId), store = entry?.store;
    if (entry?.status !== "running" || !store || entry.service?.hasBindingWork?.(binding.expected.conversationId)) return false;
    const session = store.getBoundSession(binding.expected.conversationId);
    if (session?.id !== binding.sessionId || JSON.stringify(this.bindingExpiryRelated(store, session.senderId)) !== JSON.stringify(binding.related)) return false;
    const expiry = store.getBindingExpiry(session.senderId, this.configProvider().bindingIdleDays);
    if (expiry?.generation !== binding.expected.generation || expiry.status !== "due") return false;
    return binding.related.every(related => !this.isSessionResponding(binding.accountId, related.sessionId)
      && !(this.threadEvents.status(JSON.stringify([binding.accountId, related.sessionId])).resultDelivery?.pending)
      && (!related.threadId || !this.nativeQueue.hasUnsettledThread(related.threadId, related.hostId)
        && !this.capacityRecovery.hasPending(related.threadId, related.hostId)));
  }

  private async bindingExpiryIdle(binding: ExpiringBinding): Promise<boolean> {
    if (!this.bindingExpiryCurrent(binding)) return false;
    const backend = this.runnerFor();
    for (const related of binding.related) {
      if (!related.threadId) continue; // No native task exists for this slot yet.
      const caps = backend.backendInfo(related.hostId).capabilities;
      if (!caps.threadInspection) return false;
      const state = await backend.inspectThread(related.threadId, related.hostId);
      if (state.threadId !== related.threadId || state.persistence !== "active" || state.runtimeStatus !== "idle"
        || state.activeTurnId || state.pendingTurnWithoutId || state.activeFlags.length || state.latestTurnStatus === "inProgress") return false;
      if (caps.nativeQueue !== false) {
        if (!backend.listQueuedSubmissions) return false;
        const queue = await backend.listQueuedSubmissions(related.threadId, undefined, related.hostId);
        if (queue.data.length || queue.nextCursor) return false;
      }
    }
    return this.bindingExpiryCurrent(binding);
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
    const history = await this.runnerFor().getHistory(session.threadId, session.hostId ?? project?.hostId);
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
      const attachments = parsed.actions.send.map((action, index) => sessionAttachment(action, index, session.hostId ?? project?.hostId));
      const text = parsed.visibleText.trim();
      return text || attachments.length ? [{ ...message, text, attachments }] : [];
    });
  }

  async continueSession(
    accountId: string,
    sessionId: string,
    text: string,
    uploads: SessionUpload[] = [],
    onProgress?: (message: string) => Promise<void> | void,
    requestId: string = crypto.randomUUID()
  ): Promise<SessionChatResult> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) throw Error("Invalid Web request id");
    const session = requireSession(this.storeFor(accountId), sessionId);
    let result: SessionChatResult | undefined;
    await this.receiptsFor(accountId).handle({ id: `web:${requestId}`, senderId: "web-admin", replyTargetId: session.senderId }, async () => {
      result = await this.runWebSession(accountId, sessionId, text, uploads, onProgress);
    });
    if (!result) throw Error("这条 Web 请求已有接收记录；未重复提交，请刷新查看原会话状态。");
    return result;
  }

  private async runWebSession(accountId: string, sessionId: string, text: string, uploads: SessionUpload[],
    onProgress?: (message: string) => Promise<void> | void): Promise<SessionChatResult> {
    this.assertRuntimeWritable();
    const prompt = text.trim();
    if (!prompt && !uploads.length) {
      throw new Error("Message text or attachment is required");
    }
    const store = this.storeFor(accountId);
    const session = requireSession(store, sessionId);
    const project = session.projectId ? store.getProject(session.projectId) : undefined;
    const entry = this.entries.get(accountId);
    if (!entry?.service || !["starting", "running"].includes(entry.status)) {
      throw Error("请先启动此渠道账号再从 Web 继续会话，以确保审批和提问可以送达；消息未提交。");
    }
    if (store.getBoundSession(session.senderId)?.id !== session.id) throw Error("请先绑定此会话再继续，以确保问题投递到正确对话；消息未提交。");
    const binding = sessionExecutionScope(store, session);
    const stillCurrent = () => this.entries.get(accountId) === entry && ["starting", "running"].includes(entry.status) && binding.current();
    const config = this.configProvider();
    const submission = new TurnSubmission(this.receiptsFor(accountId), session.id);
    const attachments = this.saveSessionUploads(accountId, session.id, uploads);
    const promptPreview = buildPromptPreview(prompt, attachments);
    if (promptPreview) {
      store.setSessionPromptPreview(session.id, promptPreview);
    }
    this.setSessionResponding(accountId, session.id, true);
    try {
      if (session.threadId && typeof this.runnerFor(config).inspectThread === "function") {
        const hostId = session.hostId ?? project?.hostId ?? "local", threadId = session.threadId;
        const state = await this.runnerFor(config).inspectThread(threadId, hostId);
        const scope = capacityFailureScope(state, threadId, hostId);
        if (scope && await this.capacityRecovery.request(scope, () => {
          const current = store.getSession(session.id);
          if (current?.threadId !== threadId || (current.hostId ?? store.getProject(current.projectId ?? "")?.hostId ?? "local") !== hostId) {
            throw Error("Capacity recovery binding changed");
          }
        })) return { threadId, message: { id: crypto.randomUUID(), role: "assistant", createdAt: new Date().toISOString(), attachments: [],
          text: "已接入容量恢复流程，正在核对并继续原轮次；这条新消息未提交。恢复进展会回到绑定对话，执行结果以原生回执为准。" } };
        assertCodexThreadRunnable(state);
      }
      const prepared = await prepareTurnSubmission({ runner: this.runnerFor(config), session, project, config,
        accountId, conversationId: session.senderId, text: prompt, items: attachments, source: "Web",
        knowledge: store.relevantKnowledge(promptPreview ?? prompt, session.projectId) });
      const result = await submission.run(this.runnerFor(config), {
        ...prepared,
        onThreadCreated: (createdThreadId) => {
          if (stillCurrent()) binding.acceptThread(createdThreadId);
          this.ensureCodexSessionMonitor();
          this.refreshDesktopRequestSubscriptions();
        },
        onTurnStarted: ({ threadId, turnId }) => {
          if (stillCurrent()) this.rememberInteractionOrigin(accountId, { ...session, threadId }, turnId);
          this.refreshDesktopRequestSubscriptions();
        },
        onApproval: (request: CodexApprovalRequest) => this.requestSessionApproval(accountId, session, request),
        onApprovalResult: (request, result) => this.reportSessionApprovalResult(request, result),
        onUserInput: request => {
          if (!stillCurrent()) {
            throw new CodexCommunicationError("observation", "interaction/unavailable", request.threadId, request.turnId);
          }
          return entry.service!.requestUserInput(session.senderId, request, prepared.hostId);
        },
        onUserInputResult: (request, result) => entry.service!.reportUserInputResult(session.senderId, request, result, prepared.hostId),
        ...((session.streamReplies ?? config.streamReplies) && onProgress
          ? { onProgress }
          : {})
      }, () => {
        this.assertRuntimeWritable();
        if (!stillCurrent()) throw Error("会话、绑定或渠道状态已改变，消息未提交。");
      });
      const threadId = result.threadId ?? session.threadId;
      if (!threadId) {
        throw new Error("Codex did not return a thread id");
      }
      if (stillCurrent()) binding.acceptThread(threadId);
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
            const { path: _path, ...attachment } = sessionAttachment(action, index, session.hostId ?? project?.hostId);
            return attachment;
          })
        }
      };
      if (stillCurrent()) await this.notifyProjectCompletion(accountId, session.id, parsed.visibleText.trim(), true, result.turnId);
      return response;
    } catch (error) {
      error = submission.error(error);
      if (error instanceof TurnDeliveryError) throw error;
      if (error instanceof TurnApplicationError || error instanceof CodexCommunicationError && error.submission !== "not-submitted") {
        this.ensureCodexSessionMonitor();
        this.refreshDesktopRequestSubscriptions();
        throw error; // Transport uncertainty is not a native task failure.
      }
      if (error instanceof CodexTurnExecutionError) await this.notifyProjectCompletion(
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
    if (this.configProvider().codexBackend === "exec" || this.runner?.backendInfo?.().id === "exec") return project;
    const candidate = nativeProjectForManaged(project, readCodexDesktopProjects(), store.listProjects());
    if (!candidate?.projectId) return project;
    if (
      project.sourceProjectId === candidate.projectId
      && project.projectKind === candidate.projectKind
      && project.hostId === candidate.hostId
      && JSON.stringify(project.rootPaths) === JSON.stringify(candidate.rootPaths)
    ) return project;
    return store.updateProjectMetadata(project.id, {
      sourceProjectId: candidate.projectId,
      rootPaths: candidate.rootPaths,
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
    if (this.configProvider().allowedSenderIds.includes(senderId))
      throw new Error("此身份还在固定准入配置 allowedSenderIds 中；请先从该配置移除，再撤销个人准入。");
    this.ideApprovals.revokePersonalAccess(loadAccount(this.options.paths, accountId).accountId, senderId);
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
    let store = this.stores.get(account.accountId);
    if (!store) {
      store = new RuntimeStateStore(accountStatePaths(this.options.paths, account.accountId));
      this.stores.set(account.accountId, store);
    }
    store.refresh();
    return store;
  }

  private receiptsFor(accountId: string): InboundReceiptJournal {
    accountId = loadAccount(this.options.paths, accountId).accountId;
    const store = this.storeFor(accountId);
    let receipts = this.inputReceipts.get(accountId);
    if (!receipts) {
      receipts = new InboundReceiptJournal(path.join(this.options.paths.runtimeDir, accountId, "inbound-receipts.jsonl"), store.snapshot.processedMessageIds);
      this.inputReceipts.set(accountId, receipts);
    }
    return receipts;
  }

  private isActive(accountId: string, sessionId: string): boolean {
    const store = this.storeFor(accountId);
    const session = store.getSession(sessionId);
    return Boolean(session && store.getBoundSession(session.senderId)?.id === session.id);
  }

  private sessionSummary(accountId: string, session: ManagedSession, active: boolean): AccountSession {
    const expiry = this.storeFor(accountId).getBindingExpiry(session.senderId, this.configProvider().bindingIdleDays);
    const conversation = this.entries.get(accountId)?.client?.conversationIdentity?.(session.senderId);
    const runtimeRecovery = this.threadEvents.status(JSON.stringify([accountId, session.id])).runtimeRecovery;
    return {
      ...session,
      accountId,
      active,
      responding: this.isSessionResponding(accountId, session.id),
      ...(runtimeRecovery ? { runtimeRecovery } : {}),
      binding: { ...this.storeFor(accountId).sessionBindingTarget(session), bound: active,
        ...(conversation ? { conversation } : {}),
        ...(active && session.threadId ? { interaction: this.getSessionInteractionRoute(accountId, session.id),
          deliveryRoute: this.entries.get(accountId)?.client?.deliveryRouteStatus?.(session.senderId),
          nativeUnavailable: ["archived", "missing"].includes(this.threadEvents.status(JSON.stringify([accountId, session.id])).runtime?.persistence ?? "") } : {}),
        ...((active || expiry?.endedSessionId === session.id) ? { expiry } : {}) }
    };
  }

  private isSessionResponding(accountId: string, sessionId: string): boolean {
    return (this.respondingSessions.get(sessionRuntimeKey(accountId, sessionId)) ?? 0) > 0;
  }

  private systemRecoveryLease(scope: SystemRecoveryScope): (() => void) | undefined {
    const leases = this.threadSubscriptions().filter(sub => sub.enabled !== false && sub.hostId === scope.hostId && sub.threadId === scope.threadId)
      .flatMap(sub => {
        const [accountId, sessionId] = JSON.parse(sub.key) as string[];
        const entry = this.entries.get(accountId), session = entry?.store?.getSession(sessionId);
        if (!entry?.store || !session) return [];
        const lease = sessionExecutionScope(entry.store, session);
        return [() => entry.status === "running" && entry.client === sub.client && lease.current()
          && this.threadSubscriptions().some(current => current.key === sub.key && current.enabled !== false && current.client === sub.client
            && current.hostId === scope.hostId && current.threadId === scope.threadId)];
      });
    if (!leases.length) return;
    return () => {
      this.assertRuntimeWritable();
      if (!leases.some(current => current())) throw Error("System recovery binding changed");
    };
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
    this.refreshDesktopRequestSubscriptions();
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

  private async closeRunner(): Promise<void> {
    this.bindingExpiry.stop();
    if (this.nativeQueueTimer) clearInterval(this.nativeQueueTimer);
    this.nativeQueueTimer = undefined;
    const runner = this.runner;
    this.runner = undefined;
    await runner?.close();
  }

  private ensureNativeQueueRecovery(): void {
    if (this.nativeQueueTimer) return;
    const recover = () => {
      for (const [accountId, entry] of this.entries) {
        if (entry.status !== "running" || !entry.service?.recoverNativeQueue) continue;
        void entry.service.recoverNativeQueue().catch(() => {
          const now = Date.now();
          if (now - (this.nativeQueueWarningAt.get(accountId) ?? 0) < 60_000) return;
          this.nativeQueueWarningAt.set(accountId, now);
          console.warn("[codex-im-gateway] native queue recovery deferred; receipts preserved, no input replayed", {
            accountId, category: "native_queue_recovery"
          });
        });
      }
    };
    this.nativeQueueTimer = setInterval(recover, 5_000);
    this.nativeQueueTimer.unref();
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
    if (session.threadId && turnId && localManagedSession(session, ownerStore)) {
      this.managedTurnCompletions.add(taskRuntimeKey(session.threadId, turnId));
    }
    await this.sendProjectCompletion(project, session.title, resultText, success, session.threadId);
  }

  private ensureCodexSessionMonitor(): void {
    if (this.codexSessionMonitor || !this.hasManagedProjects()) return;
    this.ensureCodexDesktopRequestMonitor();
    this.codexSessionMonitor = this.codexSessionMonitorFactory({
      onCompletion: (completion) => this.notifyExternalCodexCompletion(completion),
      onTaskChanged: (task) => this.updateExternalCodexTask(task),
      onActivity: (activity) => this.notifyExternalCodexActivity(activity),
      onRecoveredCompletion: (completion) => this.threadEvents.recoverCompletion(
        "local", completion.sessionId, completion.turnId, completion.text, completion.outcome ?? (completion.success ? "completed" : "failed")
      )
    });
    this.codexSessionMonitor.start();
  }

  private hasManagedProjects(): boolean {
    return listAccounts(this.options.paths).some((account) =>
      this.storeFor(account.accountId).listProjects().length > 0 || this.storeFor(account.accountId).listSessions().some(s => s.threadId)
    );
  }

  private async updateExternalCodexTask(task: CodexSessionTask): Promise<void> {
    const key = `${task.sessionId}\n${task.turnId}`;
    if (task.status === "running") {
      this.externalCodexTasks.set(key, task);
      this.refreshDesktopRequestSubscriptions();
      await this.threadEvents.started("local", task.sessionId, task.turnId, task.startedAt);
    } else {
      this.externalCodexTasks.delete(key);
      this.refreshDesktopRequestSubscriptions();
    }
  }

  private async notifyExternalCodexActivity(activity: CodexSessionActivity): Promise<void> {
    await this.threadEvents.activity("local", activity.sessionId, activity.turnId, activity.text);
  }

  private threadSubscriptions(): ThreadSubscription[] {
    if (this.runner?.backendInfo?.().capabilities.liveFollow === false || this.configProvider().codexBackend === "exec") return [];
    const result: ThreadSubscription[] = [];
    for (const [accountId, entry] of this.entries) {
      // A temporary reconnect is not an unsubscribe. Keep persistent delivery
      // cursors/cards; REST delivery may still work while the receive socket reconnects.
      if ((entry.status !== "running" && entry.status !== "starting") || !entry.client || !entry.store) continue;
      const store = entry.store;
      for (const session of store.listSessions()) {
        const hostId = session.hostId ?? store.getProject(session.projectId ?? "")?.hostId ?? "local";
        if (this.runner?.backendInfo?.(hostId).capabilities.liveFollow === false) continue;
        const managed = this.isSessionResponding(accountId, session.id);
        if (!session.threadId && !managed) continue;
        result.push({
          key: JSON.stringify([accountId, session.id]), threadId: session.threadId ?? "",
          hostId,
          recipientId: session.senderId, client: entry.client,
          managed,
          enabled: store.getBoundSession(session.senderId)?.id === session.id && (managed || session.follow !== false),
          progressEnabled: session.streamReplies ?? this.configProvider().streamReplies,
          contextToken: store.getContextToken(session.senderId),
          onTextDelivered: (part) => entry.webhook?.publish({ direction: "outbound", id: part.messageId,
            recipientId: session.senderId, text: part.text, attachments: [] })
        });
      }
    }
    return result;
  }

  private ensureCodexDesktopRequestMonitor(): void {
    if (this.configProvider().codexBackend === "exec") return;
    if (this.codexDesktopRequestMonitor || !this.hasManagedProjects()
      && !this.threadSubscriptions().some(binding => binding.enabled && binding.threadId)) return;
    this.codexDesktopRequestMonitor = this.codexDesktopRequestMonitorFactory({
      onApproval: (approval) => this.handleDesktopApproval(approval),
      onResult: (approval, result) => this.reportDesktopApprovalResult(approval, result),
      onUserInput: (input) => this.handleDesktopUserInput(input),
      onUserInputResult: (input, result) => this.reportDesktopUserInputResult(input, result),
      onObservedUserInputAnswers: async receipts => {
        await Promise.all([...this.entries.values()].map(entry => entry.service?.observeNativeUserInputAnswers?.(receipts)));
      },
      onUnsupportedInteraction: async input => {
        this.interactionRouting.recordUnsupported(input);
        const binding = this.interactionBinding(input.threadId, input.turnId, input.hostId);
        if (!binding) { await this.notifyInteractionRouteConflict(input.hostId, input.threadId, input.turnId); return false; }
        // Deliberately omit native payloads: these may contain an OAuth URL,
        // verification challenge or credentials that must not enter an IM group.
        const text = input.reason === "authentication"
          ? `当前任务等待安全认证。${input.safeUrl ? `可在浏览器打开认证页面：${input.safeUrl}` : "原请求包含认证链接或验证信息，未将它发布到群聊；请从原工具提供的安全页面完成验证。"} 不需要把密码或验证码发到 IM；打开页面不等于批准或完成认证。`
          : "当前任务有待处理的原生交互，但该请求格式暂不能通过 IM 回答。Gateway 未代为批准，任务尚未完成；已记录脱敏的不支持类型，不能将它当作普通聊天忽略。";
        const sent = await binding.client.sendText({ toUserId: binding.recipientId, text, contextToken: binding.contextToken });
        binding.onTextDelivered?.({ messageId: sent.messageId, text });
        this.interactionRouting.recordUnsupported(input, true);
        return true;
      }
    });
    this.codexDesktopRequestMonitor.start();
    this.refreshDesktopRequestSubscriptions();
  }

  private refreshDesktopRequestSubscriptions(): void {
    for (const entry of this.entries.values()) entry.service?.reconcileUserInputs?.();
    const configured = [...this.entries].flatMap(([accountId, entry]) => (loadAccount(this.options.paths, accountId).enabled === false ? [] : entry.store?.listSessions()
      .filter(session => entry.store!.getBoundSession(session.senderId)?.id === session.id && session.follow !== false && session.threadId)
      .map(session => this.interactionDestination(accountId, session)) ?? []));
    this.interactionRouting.reconcileBindings(configured, [...this.entries].filter(([, entry]) => entry.store).map(([id]) => id));
    const monitor = this.codexDesktopRequestMonitor;
    if (!monitor) return;
    const threadIds = this.threadSubscriptions()
      .filter((binding) => binding.enabled && binding.threadId)
      .map((binding) => ({ hostId: binding.hostId, threadId: binding.threadId }));
    for (const task of this.externalCodexTasks.values()) {
      // Keep the legacy project-notification route for unbound Desktop tasks.
      if (!this.hasLocalThreadBinding(task.sessionId)
        && this.projectForExternalThread(task.sessionId, task.workspace)?.notifications?.some(target => target.enabled)) {
        threadIds.push({ hostId: "local", threadId: task.sessionId });
      }
    }
    monitor.setFollowedThreads(threadIds);
  }
  interactionHealth() {
    const bindings = this.listSessions().filter(session => session.active).map(session => ({
      accountId: session.accountId, sessionId: session.id, title: session.title, binding: session.binding
    }));
    return { bindings, unsupported: this.interactionRouting.diagnostics() };
  }

  listApprovals() {
    return [...this.entries].flatMap(([accountId, entry]) => entry.status === "running"
      ? (entry.service?.listApprovals() ?? []).map(request => ({ ...request, accountId })) : []);
  }
  decideApproval(accountId: string, recipientId: string, id: string, choice: string, version: string) {
    const entry = this.entries.get(accountId);
    if (!entry?.service || entry.status !== "running") throw new Error("审批所属渠道当前未运行");
    return entry.service.decideApproval(recipientId, id, choice, version);
  }

  private hasLocalThreadBinding(threadId: string): boolean {
    return listAccounts(this.options.paths).some(account => {
      const store = this.storeFor(account.accountId);
      return store.listSessions().some(session => session.threadId === threadId
        && (session.hostId ?? store.getProject(session.projectId ?? "")?.hostId ?? "local") === "local");
    });
  }

  private interactionDestination(accountId: string, session: ManagedSession): InteractionDestination {
    return { accountId, sessionId: session.id, recipientId: session.senderId,
      hostId: session.hostId ?? this.storeFor(accountId).getProject(session.projectId ?? "")?.hostId ?? "local",
      threadId: session.threadId ?? "" };
  }

  private interactionDestinations(): InteractionDestination[] {
    return this.threadSubscriptions().filter(binding => binding.enabled
      && !["archived", "missing"].includes(this.threadEvents.status(binding.key).runtime?.persistence ?? "")).map(binding => {
      const [accountId, sessionId] = JSON.parse(binding.key) as [string, string];
      return { accountId, sessionId, recipientId: binding.recipientId, hostId: binding.hostId, threadId: binding.threadId };
    });
  }

  private rememberInteractionOrigin(accountId: string, session: ManagedSession, turnId: string): void {
    if (session.threadId) this.interactionRouting.rememberTurn(this.interactionDestination(accountId, session), turnId);
  }

  private async reportDesktopApprovalResult(approval: CodexDesktopApproval, result: ApprovalDeliveryResult): Promise<void> {
    const route = this.approvalRoutes.get(approval);
    if (!route) return;
    this.approvalRoutes.delete(approval);
    await route.service.reportApprovalResult(route.recipientId, approval.request, result);
  }

  private interactionBinding(threadId: string, turnId: string, hostId = "local"): ThreadSubscription | undefined {
    const status = this.interactionRouting.resolve(hostId, threadId, this.interactionDestinations(), turnId);
    if (!status.destination) {
      const key = JSON.stringify([hostId, threadId, turnId, status.status]);
      if (!this.unresolvedInteractions.has(key)) {
        this.unresolvedInteractions.add(key);
        while (this.unresolvedInteractions.size > 500) this.unresolvedInteractions.delete(this.unresolvedInteractions.values().next().value!);
        console.warn(`[codex-im-gateway] interaction route unresolved ${JSON.stringify({ timestamp: new Date().toISOString(),
          hostId, threadId, turnId, code: status.status, bindingCount: status.bindingCount })}`);
      }
      return undefined;
    }
    const destination = status.destination;
    this.interactionRouting.pinInteraction(destination, turnId);
    return this.threadSubscriptions().find(binding => binding.enabled
      && binding.key === JSON.stringify([destination.accountId, destination.sessionId])
      && binding.hostId === destination.hostId && binding.threadId === destination.threadId && binding.recipientId === destination.recipientId);
  }

  private async notifyInteractionRouteConflict(hostId: string, threadId: string, turnId: string): Promise<void> {
    const candidates = this.threadSubscriptions().filter(binding => binding.enabled
      && binding.hostId === hostId && binding.threadId === threadId);
    const status = this.interactionRouting.resolve(hostId, threadId, this.interactionDestinations(), turnId);
    if (status.destination || !["ambiguous", "unavailable"].includes(status.status)) return;
    const unique = new Map(candidates.map(binding => {
      const [accountId] = JSON.parse(binding.key) as [string, string];
      return [JSON.stringify([accountId, binding.recipientId]), binding] as const;
    }));
    await Promise.all([...unique.values()].map(async binding => {
      const [accountId, sessionId] = JSON.parse(binding.key) as [string, string];
      const destination = { accountId, sessionId, recipientId: binding.recipientId, hostId, threadId };
      if (!this.interactionRouting.claimRouteNotice(destination, status.status as "ambiguous" | "unavailable")) return;
      if (!this.threadSubscriptions().some(current => current.enabled && current.key === binding.key
        && current.hostId === hostId && current.threadId === threadId && current.recipientId === binding.recipientId)) return;
      const text = status.status === "ambiguous"
        ? "当前绑定的 Codex 会话有待处理交互，但多个对话跟随且未确定主交互对话，题目未投递。控制者可在希望接收题目的对话设置主入口；仍待回答的问题会重新核对后投递。未代答、未启动或停止任务。\n\n```text\n/follow primary\n```"
        : "当前绑定的 Codex 会话有待处理交互，但原交互目标已解绑或切换，题目尚未投递，未改投其他对话。控制者可在目标对话设置主交互；只有仍有效且尚未归属其他对话的请求才会恢复投递。\n\n```text\n/follow primary\n```";
      try {
        // This is a neutral configuration notice, never a broadcast of the
        // native question/choices. Prefer plain text, not another progress card.
        const sent = await binding.client.sendText({ toUserId: binding.recipientId, text, contextToken: binding.contextToken });
        this.interactionRouting.reportRouteNotice(destination, status.status as "ambiguous" | "unavailable", true);
        binding.onTextDelivered?.({ messageId: sent.messageId, text });
      } catch {
        this.interactionRouting.reportRouteNotice(destination, status.status as "ambiguous" | "unavailable", false);
        console.warn("[codex-im-gateway] interaction route notice unconfirmed; bounded neutral-notice retry pending");
      }
    }));
  }

  private async handleDesktopUserInput(input: CodexDesktopUserInput): Promise<CodexUserInputAnswer | undefined> {
    let binding: ThreadSubscription | undefined;
    {
      // The previous destination is durable even if the in-memory origin was
      // lost on restart. Never broadcast the same prompt to every binding.
      const recovered = this.threadSubscriptions().filter(candidate => {
        if (!candidate.enabled || candidate.hostId !== input.hostId || candidate.threadId !== input.request.threadId) return false;
        const [accountId] = JSON.parse(candidate.key) as [string, string];
        return this.entries.get(accountId)?.service?.hasUserInput(candidate.recipientId, input.request);
      });
      if (recovered.length === 1) binding = recovered[0];
      else if (recovered.length > 1) return undefined;
    }
    binding ??= this.interactionBinding(input.request.threadId, input.request.turnId, input.hostId);
    if (!binding) {
      await this.notifyInteractionRouteConflict(input.hostId, input.request.threadId, input.request.turnId);
      return undefined;
    }
    const [accountId, sessionId] = JSON.parse(binding.key) as [string, string];
    this.interactionRouting.pinInteraction({ accountId, sessionId, recipientId: binding.recipientId,
      hostId: binding.hostId, threadId: binding.threadId }, input.request.turnId);
    const service = this.entries.get(accountId)?.service;
    if (!service) return undefined;
    this.userInputRoutes.set(input, { service, recipientId: binding.recipientId });
    const answers = await service.requestUserInput(binding.recipientId, input.request);
    if (!this.threadSubscriptions().some(candidate => candidate.key === binding!.key && candidate.enabled
      && candidate.threadId === binding!.threadId && candidate.hostId === input.hostId)) {
      await service.reportUserInputResult(binding.recipientId, input.request, "suspended");
      return undefined;
    }
    return answers;
  }

  private async reportDesktopUserInputResult(input: CodexDesktopUserInput, result: CodexUserInputResult): Promise<void> {
    const route = this.userInputRoutes.get(input);
    if (!route) return;
    this.userInputRoutes.delete(input);
    await route.service.reportUserInputResult(route.recipientId, input.request, result);
  }

  private async handleDesktopApproval(approval: CodexDesktopApproval): Promise<CodexApprovalDecision | undefined> {
    const hostId = approval.hostId ?? "local";
    const binding = this.interactionBinding(approval.request.threadId, approval.request.turnId, hostId);
    if (binding) {
      const [accountId] = JSON.parse(binding.key) as [string, string];
      const service = this.entries.get(accountId)?.service;
      if (!service) return undefined;
      this.approvalRoutes.set(approval, { service, recipientId: binding.recipientId });
      const decision = await service.requestApproval(binding.recipientId, approval.request);
      if (!this.threadSubscriptions().some(candidate => candidate.key === binding.key && candidate.enabled
        && candidate.threadId === binding.threadId && candidate.hostId === hostId)) {
        await this.reportDesktopApprovalResult(approval, "withdrawn");
        return undefined;
      }
      return decision;
    }
    await this.notifyInteractionRouteConflict(hostId, approval.request.threadId, approval.request.turnId);
    // A remote interaction never falls through to a local cwd/project route.
    if (hostId !== "local") return undefined;
    // Never route an inactive/ambiguous explicit binding by its working directory.
    if (this.hasLocalThreadBinding(approval.request.threadId)) {
      console.warn("[codex-im-gateway] approval has no unique active session binding; left for Desktop");
      return undefined;
    }
    const project = this.projectForExternalThread(approval.request.threadId, approval.request.cwd);
    if (!project) {
      console.warn(`[codex-im-gateway] no managed project found for Codex Desktop approval ${approval.requestId}`);
      return undefined;
    }
    const target = this.projectApprovalTarget(project);
    if (!target) return undefined;
    this.approvalRoutes.set(approval, target);
    return target.service.requestApproval(target.recipientId, approval.request);
  }

  private requestSessionApproval(
    accountId: string,
    session: ManagedSession,
    request: CodexApprovalRequest
  ): Promise<CodexApprovalDecision> {
    const entry = this.entries.get(accountId);
    if (!entry?.service || (entry.status !== "running" && entry.status !== "starting")) return Promise.resolve("decline");
    this.sessionApprovalRoutes.set(request, { service: entry.service, recipientId: session.senderId });
    return entry.service.requestApproval(session.senderId, request);
  }

  private reportSessionApprovalResult(request: CodexApprovalRequest, result: ApprovalDeliveryResult) {
    const route = this.sessionApprovalRoutes.get(request);
    this.sessionApprovalRoutes.delete(request);
    return route?.service.reportApprovalResult(route.recipientId, request, result);
  }

  private projectApprovalTarget(project: ManagedProject): { service: BridgeService; recipientId: string } | undefined {
    const targets = (project.notifications ?? [])
      .filter((candidate) => candidate.enabled)
      .filter((candidate) => {
        const entry = this.entries.get(candidate.accountId);
        return entry?.status === "running" && Boolean(entry.service);
      });
    const unique = new Map(targets.map(target => [JSON.stringify([target.accountId, target.recipientId]), target]));
    const target = unique.size === 1 ? [...unique.values()][0] : undefined;
    if (!target) {
      console.warn(`[codex-im-gateway] no running notification channel for approval in project ${project.name}`);
      return undefined;
    }
    const entry = this.entries.get(target.accountId);
    return entry?.service ? { service: entry.service, recipientId: target.recipientId } : undefined;
  }

  private externalProjectContexts(threadId: string, workspace?: string): Array<{ accountId: string; project: ManagedProject }> {
    const stores = listAccounts(this.options.paths).map(account => ({ accountId: account.accountId, store: this.storeFor(account.accountId) }));
    const bound = stores.flatMap(({ accountId, store }) => store.listSessions()
      .filter(session => session.threadId === threadId && localManagedSession(session, store))
      .map(session => ({ accountId, project: session.projectId ? store.getProject(session.projectId) : undefined })));
    // An explicit independent binding must not be converted to a project by cwd.
    if (bound.length) return bound.filter((entry): entry is { accountId: string; project: ManagedProject } => Boolean(entry.project)
      && (entry.project!.hostId ?? "local") === "local");
    if (!workspace) return [];
    const candidates = stores.flatMap(({ accountId, store }) => store.listProjects().map(project => ({ accountId, project })));
    const eligible = new Set(localProjectsAtWorkspace(workspace, candidates.map(entry => entry.project)));
    return candidates.filter(entry => eligible.has(entry.project));
  }

  private projectForExternalThread(threadId: string, workspace?: string): ManagedProject | undefined {
    const contexts = this.externalProjectContexts(threadId, workspace);
    // Approval fallback needs one destination, never the first registration.
    return contexts.length === 1 ? contexts[0].project : undefined;
  }

  private projectSummary(
    accountId: string,
    project: ManagedProject,
    store = this.storeFor(accountId)
  ): AccountProject {
    const sessions = store.listSessions().filter((session) => session.projectId === project.id);
    const boundSessions: AccountProjectSession[] = sessions.slice(0, 10).map((session) => ({
      id: session.id,
      title: session.title,
      active: store.getBoundSession(session.senderId)?.id === session.id,
      hasThread: Boolean(session.threadId),
      updatedAt: session.updatedAt
    }));
    const respondingThreadIds = new Set(listAccounts(this.options.paths).flatMap((account) => {
      const accountStore = this.storeFor(account.accountId);
      return accountStore.listSessions().flatMap(session => session.threadId && localManagedSession(session, accountStore)
        && this.isSessionResponding(account.accountId, session.id) ? [session.threadId] : []);
    }));
    const managedTasks: AccountProjectTask[] = sessions
      .filter((session) => this.isSessionResponding(accountId, session.id))
      .map((session) => ({
        id: `managed:${accountId}:${session.id}`,
        title: session.title,
        source: "managed",
        startedAt: session.updatedAt,
        updatedAt: session.updatedAt
      }));
    const externalTasks: AccountProjectTask[] = [...this.externalCodexTasks.values()]
      .filter((task) => !respondingThreadIds.has(task.sessionId)
        && this.externalProjectContexts(task.sessionId, task.workspace).some(entry => entry.accountId === accountId && entry.project.id === project.id))
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
    if (this.capacityRecovery.holdsStart({ hostId: "local", threadId: completion.sessionId, turnId: completion.turnId })) return;
    if (!completion.success && completion.failureCode === "model-capacity"
      && this.capacityRecovery.offer({ hostId: "local", threadId: completion.sessionId, turnId: completion.turnId })) return;
    const accounts = listAccounts(this.options.paths);
    const stores = accounts.map((account) => ({ account, store: this.storeFor(account.accountId) }));
    const managedByService = stores.some(({ account, store }) =>
      store.listSessions().some((session) =>
        session.threadId === completion.sessionId && localManagedSession(session, store)
        && this.isSessionResponding(account.accountId, session.id)
      )
    );
    const completionKey = taskRuntimeKey(completion.sessionId, completion.turnId);
    if (managedByService || this.managedTurnCompletions.delete(completionKey)) return;
    await this.finalizeExternalActivityStreams(completion);
    await Promise.all(this.externalProjectContexts(completion.sessionId, completion.workspace)
      .map(({ project }) => this.sendProjectCompletion(project, completion.taskTitle, completion.text,
        completion.success, completion.sessionId, completion.outcome)));
  }

  private async finalizeExternalActivityStreams(completion: CodexSessionCompletion): Promise<void> {
    const finalText = completion.success
      ? completion.text
      : completion.outcome === "interrupted" ? completion.text : `Codex 任务执行失败：${completion.text}`;
    await this.threadEvents.completion("local", completion.sessionId, completion.turnId, finalText,
      completion.outcome ?? (completion.success ? "completed" : "failed"));
  }

  private async sendProjectCompletion(
    project: ManagedProject,
    taskTitle: string,
    resultText: string,
    success: boolean,
    threadId?: string,
    outcome?: CodexSessionCompletion["outcome"]
  ): Promise<void> {
    const targets = (project.notifications ?? []).filter((target) => target.enabled);
    if (!targets.length) return;
    const issue = threadId ? await this.issueForProjectThread(project, threadId) : undefined;
    if (success && issue && this.wasRecentlyNotified(issue)) return;
    const excerpt = resultText.replace(/\s+/g, " ").trim().slice(0, 500);
    const title = success ? "Codex 任务已完成" : outcome === "interrupted" ? "Codex 任务已中断" : "Codex 任务执行失败";
    const label = success ? "结果" : outcome === "interrupted" ? "说明" : "错误";
    const text = [
      `【${title}】`,
      `项目：${project.name}`,
      ...(issue ? [`Issue：${issue.identifier} · ${formatTaskboardStatus(issue.status)}`] : []),
      `任务：${taskTitle.replace(/\s+/g, " ").trim().slice(0, 100) || "Codex 会话"}`,
      ...(excerpt ? [`${label}：${excerpt}`] : [])
    ].join("\n");
    const card = issue ? createTaskCard(project.name, issue, {
      title,
      note: excerpt ? `${label}：${excerpt}` : undefined,
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
            && localProjectsAtWorkspace(candidate.workspacePath, managed).some(item => item.accountId === project.accountId && item.id === project.id));
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
    const eligible = new Set(localProjectsAtWorkspace(taskboardProject.workspacePath, this.listProjects())
      .map(project => JSON.stringify([project.accountId, project.id])));
    await Promise.all(listAccounts(this.options.paths).flatMap((account) => {
      const store = this.storeFor(account.accountId);
      return store.listProjects()
        .filter((project) => eligible.has(JSON.stringify([account.accountId, project.id])))
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
      if (card && entry.client.capabilities.tasks === "available") await this.sendChannelTaskCard(entry, message, card);
      else await this.sendChannelText(entry, message);
    }));
    for (const result of results) {
      if (result.status === "rejected") console.error(`[codex-im-gateway] channel notification failed: ${String(result.reason)}`);
    }
  }

  private async issueForProjectThread(project: ManagedProject, threadId: string): Promise<TaskboardIssue | undefined> {
    try {
      if (!localProjectsAtWorkspace(project.workspace, this.listProjects()).some(item => item.id === project.id)) return undefined;
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
    const store = this.storeFor(account.accountId);
    return {
      ...publicAccount(account),
      status: entry?.status ?? "stopped",
      ...(entry?.connection ? { connection: entry.connection } : {}),
      ...(entry?.client ? { capabilities: entry.client.capabilities } : {}),
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
    return parseActionBlocks(text, { strict: false });
  } catch {
    return { visibleText: text.trim(), actions: { send: [], control: [], remember: [] } };
  }
}

function sessionAttachment(
  action: { type: "image" | "file" | "video"; path: string },
  index: number,
  hostId = "local"
): SessionAttachmentFile {
  let size: number | undefined;
  let available = false;
  try {
    if (hostId === "local") {
      const stat = fs.statSync(action.path);
      available = stat.isFile();
      if (available) size = stat.size;
    }
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
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
    workspace: project.workspace,
    hostId: project.hostId,
    sourceProjectId: project.sourceProjectId
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

function localManagedSession(session: ManagedSession, store: RuntimeStateStore): boolean {
  return (session.hostId ?? (session.projectId ? store.getProject(session.projectId)?.hostId : undefined) ?? "local") === "local";
}
