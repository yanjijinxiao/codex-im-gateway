import { AdmissionService, admissionPrincipal } from "./admission.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { localProjectsAtWorkspace, managedProjectForNative, nativeProjectForManaged } from "../state/project-identity.js";

import { AccessController, requiredCommandRole, roleAllows, type SessionRole } from "./access.js";
import { sessionExecutionScope } from "./session-execution.js";
import { observeStatus, STATUS_RPC_BUDGET_MS } from "./status-observation.js";
import { SessionControlJournal, SessionControlQueue } from "./session-control.js";
import type { AcceptedPresentationInput } from "./input-presentation.js";
import { TurnAudienceJournal, type TurnParticipantOrigin } from "./turn-audience.js";
import { ChannelTurnPresentation, type TurnReplyStream } from "../channels/turn-presentation.js";
import { completedCardForMentions } from "../channels/completion-mentions.js";
import { ideEntryLink, withIDEEntry } from "../ide/completion.js";
import { NativeQueueCoordinator, type QueueReceipt } from "./native-queue.js";
import { InboundReceiptJournal } from "./inbound-receipts.js";
import { prepareTurnSubmission, stageTurnAttachments, TurnSubmission, TurnDeliveryError, TurnApplicationError } from "./turn-submission.js";
import { CodexTurnExecutionError, CodexInterventionError } from "../codex/backend.js";
import { communicationError, CodexCommunicationError } from "../codex/communication-error.js";
import { codexRecoverySummary } from "../codex/turn-recovery.js";
import { ChannelApprovalController, type ApprovalDeliveryResult } from "./approval.js";
import { parseActionBlocks } from "./actions.js";
import {
  assertNeverChannelCapabilityResolution,
  buildChannelCapabilityPrompt,
  channelCapabilityAliases,
  resolveChannelCapabilityCommand,
  type ChannelCapabilityProvider,
  type ChannelCommandCapability
} from "./channel-capability.js";
import {
  channelHelpText,
  isReservedChannelCommandToken,
  parseCommand
} from "./channel-commands.js";
import {
  commandProjectRequirement,
  requiredModeForCommand
} from "./channel-command-policy.js";
import {
  type ChannelCommand
} from "./channel-intent.js";
import type { ChannelIntentResolver } from "./ai-channel-intent.js";
import { buildPromptParts, buildPromptPreview, parsePrompt } from "./format.js";
import { resultPages } from "../channels/result-pages.js";
import { copyableTaskCard } from "../channels/task-card-copy.js";
import { copyBlock, copyableChoices } from "../channels/copyable.js";
import { InboundReferenceStore, referenceContext } from "./inbound-references.js";
import { PromptBuffer } from "./prompt-buffer.js";
import { NEW_SESSION_USAGE, parseNewSessionTarget } from "./new-session.js";
import { selectChannelProject } from "./project-selection.js";
import { orderSessionCatalog, sessionHostLabel, type SessionCatalogRow } from "./session-catalog-order.js";
import { compactTableCell, renderTextTable, escapeTableMarkdown, type ChannelTable } from "../channels/table.js";
import { isSessionPageSize, MIN_SESSION_PAGE_SIZE, MAX_SESSION_PAGE_SIZE } from "../state/session-list-settings.js";
import { readSessionPurposes, SessionPurposeIndex } from "../state/session-purposes.js";
import { ChannelUserInputController } from "./user-input.js";
import { RestartWork } from "./restart-work.js";
import type { TurnResultAction } from "./turn-result-actions.js";
import { TaskboardChannelController } from "./taskboard-channel-controller.js";
import {
  conciseButtonLabel,
  createCommandSelectionCard,
  createMainMenuCard
} from "./interaction-cards.js";
import type {
  CodexDynamicToolCall,
  CodexBridgeBackend,
  CodexRunnerInput,
  CodexHistoryMessage,
  CodexModelOption,
  CodexRuntimeInfo,
  CodexInputReceipt,
  CodexThreadState,
  CodexThreadGoal,
  CodexThreadGoalStatus
} from "../codex/backend.js";
import { assertCodexThreadRunnable, capacityFailureScope, CodexBackendCapabilityError, CodexThreadStateError } from "../codex/backend.js";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../codex/approval.js";
import { CodexBackendRouter } from "../codex/runner.js";
import {
  LlmWikiMcpClientPool,
  llmWikiDynamicTools
} from "../knowledge/llm-wiki-mcp-client.js";
import type { CodexImGatewayConfig } from "../state/config.js";
import {
  normalizeChannelModeSettings,
  type ChannelModeSettings,
  type ProjectInteractionMode
} from "../channels/channel-mode-settings.js";
import {
  RuntimeStateStore,
  type ManagedKnowledgeBase,
  type ManagedProject,
  type ManagedSession
} from "../state/runtime-state.js";
import {
  projectCandidatesFromBackendCatalog,
  type CodexProjectCandidate,
  type CodexSessionCandidate
} from "../server/codex-projects.js";
import { ChannelContextExpiredError, ChannelPartialDeliveryError, InboundMediaTooLargeError } from "../channels/errors.js";
import { validateLocalAttachments } from "../channels/client.js";
import { adaptLegacyClient } from "../channels/legacy.js";
import { formatFollowStatus, type SessionFollowPort } from "./session-follow.js";
import { formatInteractionRoute, type SessionInteractionPort } from "./interaction-routing.js";
import { ideApprovalCommand, isIDEApprovalCommand } from "./ide-approval.js";
import type { IDEApprovalService } from "../ide/approval-service.js";
export { ChannelTurnTextStream, type ChannelStreamCheckpoint } from "../channels/progress.js";
import type { ChannelMessage } from "../channels/message.js";
import type { OutboundChannelMessage } from "../webhooks/channel-message-webhook.js";
import type { PromptBufferItem } from "./prompt-buffer.js";
import { formatAccountBalance, type CodexAccountBalance } from "../codex/account-balance.js";
import type { ChannelClient, ChannelTextClient, ChannelReceipt } from "../channels/types.js";
import {
  createChoiceCard,
  type ChannelActionCard,
  type ChannelChoice
} from "../channels/action-card.js";
import { createGoalFormCard } from "../channels/goal-form-card.js";
import { formatTaskboardStatus, type ChannelTaskCard } from "../channels/task-card.js";
import type { TaskboardClient, TaskboardIssue } from "../taskboard/client.js";
import {
  markMessageHandlingErrorReported,
  userFacingMessageHandlingError
} from "./errors.js";

export { parseCommand } from "./channel-commands.js";

class InboundAttachmentDownloadError extends Error {
  constructor() {
    super("Inbound attachment download failed");
    this.name = "InboundAttachmentDownloadError";
  }
}

type ProjectSessionChoice = {
  managed?: ManagedSession;
  candidate?: CodexSessionCandidate;
  title: string;
  updatedAt: string;
};

export type BridgeServiceOptions = {
  inputReceipts?: InboundReceiptJournal;
  ideApprovals?: IDEApprovalService;
  admission?: AdmissionService;
  /** Captured from the actual running adapter account, not mutable UI state. */
  ideProviderId?: string;
  ideEntry?: (session: ManagedSession) => string | undefined | Promise<string | undefined>;
  ideProgressEntry?: (session: ManagedSession) => string | undefined;
  deferCapacityFailure?: (scope: { hostId: string; threadId: string; turnId: string }) => boolean;
  requestCapacityRecovery?: (scope: { hostId: string; threadId: string; turnId: string }, assertCurrent: () => void) => Promise<boolean>;
  requestSystemRecovery?: (scope: { hostId: string; threadId: string; turnId: string }, assertCurrent: () => void) => Promise<CodexThreadState | undefined>;
  accountId?: string;
  nativeQueue?: NativeQueueCoordinator;
  sessionControls?: SessionControlJournal;
  turnAudience?: TurnAudienceJournal;
  createTextStream?: (session: ManagedSession, acceptedTurnId?: string) => TurnReplyStream | Promise<TurnReplyStream>;
  onAcceptedInput?: (input: AcceptedPresentationInput) => Promise<void>;
  deliverTurnResult?: (session: ManagedSession, turnId: string, text: string) => Promise<boolean>;
  onSubscriptionsChanged?: () => Promise<void>;
  sessionFollow?: SessionFollowPort;
  sessionInteractions?: SessionInteractionPort;
  onTurnStarted?: (session: ManagedSession, turnId: string, status?: import("../codex/backend.js").CodexTurnStatus) => Promise<void> | void;
  config: CodexImGatewayConfig;
  stateStore: RuntimeStateStore;
  channel?: ChannelClient;
  /** @deprecated Inject a channel adapter client instead. */
  weixin?: ChannelTextClient;
  runner?: CodexBridgeBackend;
  listCodexModels?: () => Promise<CodexModelOption[]>;
  getCodexBalance?: () => Promise<CodexAccountBalance>;
  llmWiki?: LlmWikiMcpClientPool;
  modeSettings?: ChannelModeSettings;
  listCodexProjects?: () => readonly CodexProjectCandidate[] | Promise<readonly CodexProjectCandidate[]>;
  inboundDir?: string;
  inboundReferences?: InboundReferenceStore;
  userInputFilePath?: string;
  cdnBaseUrl?: string;
  mediaFetch?: typeof globalThis.fetch;
  taskboard?: TaskboardClient;
  intentResolver?: ChannelIntentResolver;
  channelCapabilities?: ChannelCapabilityProvider;
  approvalTimeoutMs?: number;
  assertRuntimeWritable?: () => void;
  isRuntimeDraining?: () => boolean;
  onTurnStatus?: (status: { senderId: string; sessionId: string; active: boolean }) => void;
  onTurnCompleted?: (result: {
    senderId: string;
    sessionId: string;
    text: string;
    success: boolean;
    turnId?: string;
  }) => Promise<void> | void;
  onOutboundMessage?: (message: OutboundChannelMessage) => void;
};

export class BridgeService {
  private readonly channel: ChannelClient;
  private readonly sessionLists = new Map<string, {
    rows: SessionCatalogRow[];
    page: number; pageSize: number; createdAt: number; label: string; warnings: string[];
  }>();
  private readonly projectLists = new Map<string, { id: string; createdAt: number; codes: Map<string, { projectId?: string; candidate?: CodexProjectCandidate }> }>();

  private catalogActorKey(senderId: string): string {
    return JSON.stringify([senderId, this.actor.getStore() ?? senderId]);
  }

  private readonly actor = new AsyncLocalStorage<string>();
  private readonly participant = new AsyncLocalStorage<Pick<TurnParticipantOrigin, "actorId" | "conversationId" | "mention">>();
  private readonly conversationWork = new Map<string, number>();
  private readonly restartWork = new RestartWork();
  private readonly turnAudience: TurnAudienceJournal;
  private audienceSuspended = false;
  private readonly controls: SessionControlJournal;
  private readonly nativeQueue: NativeQueueCoordinator;
  private recoveringQueue = false;
  private lastQueueWarningAt = 0;
  private readonly runningSessions = new Set<string>();
  private readonly activePresentations = new Map<string, { hostId: string; threadId?: string; turnId?: string; stream: TurnReplyStream }>();
  private readonly catalogControls = new SessionControlQueue();
  private readonly turnDeliveries = new SessionControlQueue();
  private readonly historyPages = new Map<string, {
    threadId: string; hostId: string; cursor?: string; exhausted: boolean; pending: CodexHistoryMessage[];
  }>();
  private readonly historyRequests = new Map<string, symbol>();
  private get access(): AccessController {
    // Durable personal admission is the authority, including at the final
    // native-write fence. Never resurrect an externally revoked cached grant.
    this.options.stateStore.refresh();
    return new AccessController({ allowedSenderIds: this.options.config.allowedSenderIds,
      pairedSenderIds: this.options.stateStore.listPairedSenderIds() });
  }
  private readonly buffers: PromptBuffer;
  private readonly runner: CodexBridgeBackend;
  private readonly approvals: ChannelApprovalController;
  private readonly taskboardController: TaskboardChannelController;
  private readonly llmWiki: LlmWikiMcpClientPool;
  private readonly userInputs: ChannelUserInputController;
  private readonly cardInteraction = new AsyncLocalStorage<ChannelMessage["interaction"]>();
  private modeSettings: ChannelModeSettings;

  constructor(private readonly options: BridgeServiceOptions) {
    if (!options.channel && !options.weixin) throw new Error("A channel adapter client is required");
    this.channel = options.channel ?? adaptLegacyClient(options.weixin!, {
      inboundDir: options.inboundDir ?? path.join(options.config.defaultCwd, ".codex-im-gateway-inbound"),
      maxInboundBytes: options.config.maxInboundBytes, cdnBaseUrl: options.cdnBaseUrl, mediaFetch: options.mediaFetch
    });
    this.controls = options.sessionControls ?? new SessionControlJournal(options.stateStore.controlJournalPath);
    this.turnAudience = options.turnAudience ?? new TurnAudienceJournal(
      path.join(path.dirname(options.stateStore.controlJournalPath), "turn-audience.json"));
    this.nativeQueue = options.nativeQueue ?? new NativeQueueCoordinator(
      path.join(path.dirname(options.stateStore.controlJournalPath), "native-submissions.json"));
    this.buffers = new PromptBuffer({
      maxItems: options.config.maxBufferItems,
      ttlMs: options.config.promptBufferTtlMs
    });
    this.approvals = new ChannelApprovalController(
      (senderId, notice) => notice.card
        ? this.replyActionCard(senderId, notice.card)
        : this.reply(senderId, notice.text),
      options.approvalTimeoutMs,
      () => options.stateStore.allocateApprovalId(),
      options.stateStore.approvalJournalPath
    );
    this.runner = options.runner ?? new CodexBackendRouter({
      backend: options.config.codexBackend,
      appServerTransport: options.config.codexAppServerTransport,
      codexBin: options.config.codexBin,
      execSandbox: options.config.codexExecSandbox
    });
    this.llmWiki = options.llmWiki ?? new LlmWikiMcpClientPool();
    this.modeSettings = normalizeChannelModeSettings(options.modeSettings);
    this.userInputs = new ChannelUserInputController(
      async (senderId, card, mentions) => {
        const receipt = await this.channel.sendActionCard({ toUserId: senderId, card,
          ...(mentions?.length ? { mentions } : {}),
          contextToken: this.options.stateStore.getContextToken(senderId) });
        this.reportCardDelivery(senderId, receipt, card.fallbackText);
        return receipt;
      }, undefined, {
        filePath: options.userInputFilePath ?? path.join(path.dirname(options.stateStore.controlJournalPath), "user-input.json"),
        validate: (senderId, request) => {
          const session = this.executionSession(senderId);
          return session?.threadId === request.threadId && (this.sessionHostId(session) ?? "local") === request.hostId;
        },
        resolveMentions: (senderId, request) => {
          const session = this.executionSession(senderId);
          if (!session || session.threadId !== request.threadId || (this.sessionHostId(session) ?? "local") !== request.hostId) return;
          return this.turnAudience.mentions({ bindingKey: JSON.stringify([this.options.accountId ?? "standalone", session.id]),
            conversationId: senderId, ...request });
        },
        ...(this.channel.capabilities.cardUpdates === "available" ? {
          updateCard: (messageId: string, card: ChannelActionCard) => this.channel.updateActionCard({ messageId, card })
        } : {}),
        sendNotice: (senderId, text) => this.reply(senderId, text),
        holdAudience: (origin, request) => this.turnAudience.hold({ bindingKey: origin.bindingKey,
          conversationId: origin.conversationId, hostId: request.hostId, threadId: request.threadId, turnId: request.turnId }),
        onAcceptedInput: input => this.presentAcceptedInput(input)
      }
    );
    this.taskboardController = new TaskboardChannelController({
      client: options.taskboard,
      stateStore: options.stateStore,
      replyText: (senderId, text) => this.reply(senderId, text),
      sendCard: (message, card) => this.replyTaskCard(message, card),
      runWorkflow: (message, instruction) => this.runCodexTurn(message, taskboardSkillPrompt(instruction)),
      attachmentPaths: async (message) => {
        const items = await this.promptItemsFromMessageWithNotice(message);
        return items?.flatMap((item) => item.kind === "text" ? [] : [item.path]);
      }
    });
  }

  configureModeSettings(settings: ChannelModeSettings): void {
    this.modeSettings = normalizeChannelModeSettings(settings);
    for (const [senderId, mode] of Object.entries(this.options.stateStore.snapshot.interactionModes)) {
      if (!this.modeSettings.enabledModes.includes(mode)) {
        this.options.stateStore.setInteractionMode(senderId, this.modeSettings.defaultMode);
      }
    }
  }

  hasInFlightWork(): boolean {
    return this.conversationWork.size > 0 || this.runningSessions.size > 0 || this.recoveringQueue;
  }

  hasRestartBlockingWork(): boolean {
    return this.restartWork.hasBlockingWork(scope => this.runner.isIndependentObservation?.(scope) === true)
      || this.approvals.list().length > 0 || this.userInputs.hasRestartBlockingWork();
  }

  async handleMessage(message: ChannelMessage): Promise<void> {
    return this.restartWork.run(() => this.handleMessageNow(message));
  }

  private async handleMessageNow(message: ChannelMessage): Promise<void> {
    this.options.assertRuntimeWritable?.();
    if (this.audienceSuspended) throw new CodexInterventionError("渠道正在停止或重新配置，消息未提交，请稍后重试。");
    const conversationId = message.replyTargetId ?? message.senderId;
    const binding = () => {
      const session = this.executionSession(conversationId);
      const project = this.options.stateStore.getActiveProject(conversationId);
      return JSON.stringify([session?.id, session?.threadId, session?.follow, session?.streamReplies,
        project?.id, this.options.stateStore.getInteractionMode(conversationId)]);
    };
    const before = binding();
    this.conversationWork.set(conversationId, (this.conversationWork.get(conversationId) ?? 0) + 1);
    try {
      await this.participant.run({ actorId: message.senderId, conversationId,
        ...(message.mention ? { mention: message.mention } : {}) }, () => this.actor.run(message.senderId, () =>
        this.cardInteraction.run(message.interaction, () => this.handleInboundMessage(message))));
    } finally {
      const remaining = (this.conversationWork.get(conversationId) ?? 1) - 1;
      if (remaining) this.conversationWork.set(conversationId, remaining); else this.conversationWork.delete(conversationId);
      // All binding entry points (new, project, Taskboard, catalog and leave)
      // use the same subscription invalidation boundary.
      if (binding() !== before) await this.options.onSubscriptionsChanged?.();
    }
  }

  private role(conversationId: string, actorId = this.actor.getStore() ?? conversationId): SessionRole {
    return this.options.stateStore.roleFor(conversationId, actorId)
      ?? (this.access.isAllowed(actorId) ? "controller" : this.options.stateStore.roleFor(conversationId, "*") ?? "participant");
  }

  private async requireRole(conversationId: string, required: SessionRole): Promise<boolean> {
    if (roleAllows(this.role(conversationId), required)) return true;
    await this.reply(conversationId, `当前权限为 ${this.role(conversationId)}，此操作需要 ${required} 权限。`);
    return false;
  }

  private async handleInboundMessage(message: ChannelMessage): Promise<void> {
    const replyTargetId = message.replyTargetId ?? message.senderId;
    let scopedMessage = replyTargetId === message.senderId
      ? message
      : { ...message, senderId: replyTargetId };
    if (scopedMessage.contextToken) {
      this.options.stateStore.rememberContextToken(replyTargetId, scopedMessage.contextToken);
    }

    // Dedicated personal authority, before chat ACL/session gating. Source actor
    // and provider-confirmed conversation kind must never be rewritten to a room.
    const control = parseCommand(message.text);
    if (control && isIDEApprovalCommand(control.name, control.arg)) {
      const result = await ideApprovalCommand({ service: this.options.ideApprovals, accountId: this.options.accountId,
        providerId: this.options.ideProviderId, channel: this.channel.channel, message, arg: control.arg });
      if (typeof result === "string") await this.reply(replyTargetId, result);
      else await this.replyActionCard(replyTargetId, result);
      return;
    }
    const principal = admissionPrincipal(this.options.accountId, this.options.ideProviderId, this.channel.channel, message);
    if (control?.name === "access") {
      if (!principal || !this.options.admission) { await this.reply(replyTargetId, "无法核验个人来源或准入审批服务未就绪。请从机器人私聊或已核验群聊发送。"); return; }
      try {
        const result = this.options.admission.command(principal, replyTargetId, message.conversationKind as "direct" | "group", control.arg);
        if (typeof result === "string") await this.reply(replyTargetId, result); else await this.replyActionCard(replyTargetId, result);
      } catch (error) { await this.reply(replyTargetId, error instanceof Error ? error.message : "准入审批未完成，请重新查看申请。"); }
      return;
    }
    const access = this.access.requireAccess(message.senderId, replyTargetId);
    if (!access.allowed) {
      if (principal && this.options.admission) {
        try {
          const request = this.options.admission.observe(principal, replyTargetId, message.conversationKind as "direct" | "group");
          await this.reply(replyTargetId, `尚未获准使用 Gateway。准入申请已登记（${request.id}），请联系准入审批管理员在机器人会话发送 /access 处理，或在本机管理页「待审批」处理。原消息未提交；获准后请重新发送。`);
        } catch (error) { await this.reply(replyTargetId, `准入申请未能登记：${error instanceof Error ? error.message : String(error)}。原消息未提交，请管理员检查。`); }
        return;
      }
      await this.reply(replyTargetId, access.message);
      return;
    }
    this.options.stateStore.recordBindingHumanActivity(replyTargetId);
    const directCommand = parseCommand(scopedMessage.text);
    const diagnosticOnly = directCommand?.name === "status" || directCommand?.name === "queue" && ["", "list"].includes(directCommand.arg.trim());
    if (!diagnosticOnly) {
      scopedMessage = this.options.inboundReferences?.resolve(scopedMessage) ?? scopedMessage;
      scopedMessage = await this.channel.resolveReferences(scopedMessage);
    }
    if (message.unsupportedMessageType) {
      await this.reply(replyTargetId, `当前渠道适配器尚未实现 ${message.unsupportedMessageType} 消息，请改发文字或支持的附件。`);
      return;
    }

    // Only explicit control syntax enters Gateway routing. Ordinary language
    // belongs to Codex, including text mentioning projects, modes or skills.
    const builtIn = parseCommand(scopedMessage.text);
    // Core controls stay available even if installed-skill discovery stalls.
    // Help includes extension commands; other built-ins need no discovery.
    const channelCapabilities = builtIn && (builtIn.name === "help" || !isReservedChannelCommandToken(builtIn.name))
      ? await (this.options.channelCapabilities?.() ?? []) : [];
    const slashCommand = builtIn && isReservedChannelCommandToken(builtIn.name) ? builtIn
      : parseCommand(scopedMessage.text, channelCapabilityAliases(channelCapabilities));
    const commands = slashCommand ? [slashCommand] : undefined;
    if (commands) {
      for (const command of commands) {
        if (!await this.requireRole(replyTargetId, requiredCommandRole(command.name, command.arg))) return;
        const requiredMode = requiredModeForCommand(command);
        if (requiredMode && !this.modeSettings.enabledModes.includes(requiredMode)) {
          await this.replyModeUnavailable(replyTargetId, requiredMode);
          return;
        }
        const contextRequirement = commandProjectRequirement(command);
        if (contextRequirement === "session-or-project" && !this.executionSession(replyTargetId)) {
          await this.replySessionRequired(replyTargetId);
          return;
        }
        if (
          contextRequirement === "required"
          && !this.ensureBoundProjectContext(replyTargetId)
        ) {
          await this.replyProjectRequired(replyTargetId);
          return;
        }
        if (await this.handleCommand(scopedMessage, command, channelCapabilities) === false) return;
      }
      return;
    }

    if (!this.executionSession(replyTargetId)) {
      await this.replySessionRequired(replyTargetId);
      return;
    }

    if (!await this.requireRole(replyTargetId, "participant")) return;
    const items = await this.promptItemsFromMessageWithNotice(scopedMessage);
    if (!items) return;

    if (this.buffers.isActive(replyTargetId)) {
      for (const item of items) {
        this.buffers.append(replyTargetId, item);
      }
      await this.replyActionCard(replyTargetId, createChoiceCard({
        title: "消息已加入合并区",
        body: "可以继续发送内容；准备好后点击“提交合并消息”。",
        fallbackText: "Buffered. Send /prompt done when ready.",
        choices: [{ label: "提交合并消息", command: "prompt", arg: "done", style: "primary" }]
      }));
      return;
    }

    if (await this.handleActiveMessage(scopedMessage, items)) return;
    await this.runCodexTurn(scopedMessage, "", items);
  }

  private async handleCommand(
    message: ChannelMessage,
    command: ChannelCommand,
    channelCapabilities: readonly ChannelCommandCapability[]
  ): Promise<void | false> {
    // Command controllers own exact native receipts; an interrupted dispatch is
    // never replayed merely because the transport redelivers its source message.
    this.options.inputReceipts?.submitting();
    const capabilityResolution = isReservedChannelCommandToken(command.name)
      ? undefined
      : resolveChannelCapabilityCommand(command, channelCapabilities);
    if (capabilityResolution) {
      switch (capabilityResolution.kind) {
        case "reply":
          await this.reply(message.senderId, capabilityResolution.text);
          return;
        case "run_skill":
          await this.runCodexTurn(message, buildChannelCapabilityPrompt(capabilityResolution));
          return;
        default:
          return assertNeverChannelCapabilityResolution(capabilityResolution);
      }
    }
    switch (command.name) {
      case "ide": {
        const session = this.executionSession(message.senderId);
        const url = session && await this.options.ideEntry?.(session);
        await this.reply(message.senderId, url ? `${ideEntryLink(url)}\n登录后打开，不会启动新的 Codex 任务。`
          : "当前没有可用的 Web IDE 入口。请先绑定有项目的 session，并在 Gateway 网页端启用对应主机的 Web IDE。");
        return;
      }
      case "help":
      case "h":
        {
          const session = this.executionSession(message.senderId);
          let desktopOwned = false;
          if (session?.threadId && typeof this.runner.inspectThread === "function") {
            try { desktopOwned = (await this.runner.inspectThread(session.threadId, this.sessionHostId(session))).executionOwner === "desktop"; }
            catch { /* Help remains available during a backend outage. */ }
          }
          await this.replyActionCard(message.senderId, createMainMenuCard(channelHelpText(channelCapabilities, command.arg, {
            backendCapabilities: this.runner.backendInfo?.(session ? this.sessionHostId(session) : undefined).capabilities,
            desktopOwned, taskboardAvailable: Boolean(this.options.taskboard)
          })));
        }
        return;
      case "status":
      case "where":
        {
          const status = await this.statusText(message.senderId);
          await this.replyActionCard(message.senderId, createChoiceCard({
            title: "当前工作上下文",
            body: status.replace(/^当前工作上下文\n/, ""),
            fallbackText: status,
            choices: [
              { label: "切换模式", command: "mode", arg: "", style: "primary" },
              { label: "任务面板", command: "task", arg: "list" },
              { label: "会话", command: "sessions", arg: "" },
              { label: "目标", command: "goal", arg: "" }
            ]
          }));
        }
        return;
      case "balance":
        await this.handleBalanceCommand(message.senderId);
        return;
      case "memory":
      case "knowledge":
        await this.handleMemoryCommand(message.senderId, command.arg);
        return;
      case "project":
      case "projects":
        return await this.handleProjectCommand(message.senderId, command.arg) ? undefined : false;
      case "task":
        this.options.stateStore.setInteractionMode(message.senderId, "task");
        await this.taskboardController.handle(message, command.arg);
        return;
      case "mode":
      case "view":
        await this.handleModeCommand(message, command.arg);
        return;
      case "qa":
        await this.handleModeCommand(message, "qa");
        return;
      case "plan":
        await this.handlePlanCommand(message.senderId, command.arg);
        return;
      case "goal":
        await this.handleGoalCommand(message, command.arg);
        return;
      case "answer":
        await this.reply(message.senderId, this.userInputs.answer(message.senderId, command.arg,
          this.participantOrigin(this.executionSession(message.senderId))));
        return;
      case "skip":
        await this.reply(message.senderId, this.userInputs.skip(message.senderId, command.arg,
          this.participantOrigin(this.executionSession(message.senderId))));
        return;
      case "new":
        return await this.handleNewSessionCommand(message.senderId, command.arg) ? undefined : false;
      case "session":
      case "sessions":
        await this.handleSessionCommand(message.senderId, command.arg);
        return;
      case "history":
        await this.handleHistoryCommand(message.senderId, command.arg);
        return;
      case "follow":
      case "policy":
      case "leave":
      case "unbind":
      case "role":
        await this.handleInterventionSetting(message.senderId, command, message.text);
        return;
      case "intervene":
        await this.handleInterventionChoice(message, command.arg);
        return;
      case "steer":
        {
          const items = await this.promptItemsFromMessageWithNotice({ ...message, text: "" });
          const session = this.executionSession(message.senderId);
          if (items && session) await this.handleSteerCommand(message, buildPromptParts(command.arg,
            await this.stagePromptItems(items, session, message), channelPromptSource(this.channel.channel), []).prompt);
          else if (!session) await this.handleSteerCommand(message, command.arg);
        }
        return;
      case "queue":
        await this.handleQueueCommand(message, command.arg);
        return;
      case "model":
        await this.handleModelCommand(message.senderId, command.arg);
        return;
      case "effort":
        await this.handleEffortCommand(message.senderId, command.arg);
        return;
      case "stream":
        await this.handleStreamCommand(message.senderId, command.arg);
        return;
      case "prompt":
        await this.handlePromptCommand(message.senderId, command.arg);
        return;
      case "approve":
        await this.reply(message.senderId, this.approvals.decide(message.senderId, command.arg, "accept"));
        return;
      case "reject":
        await this.reply(message.senderId, this.approvals.decide(message.senderId, command.arg, "decline"));
        return;
      case "stop":
        {
        const session = this.executionSession(message.senderId);
        const assertCurrent = this.controlGuard(message.senderId, session, "controller");
        assertCurrent();
        this.approvals.declineAll(message.senderId);
        this.userInputs.cancelSender(message.senderId);
        let stopResult: "interrupted" | "not-active";
        {
          stopResult = session?.threadId
            ? await this.runner.stop(session.threadId, this.sessionHostId(session), assertCurrent)
            : "not-active";
        }
        await this.reply(
          message.senderId,
          stopResult === "interrupted" ? "已停止当前会话正在执行的任务。" : "当前会话没有正在执行的任务。"
        );
        return;
        }
      default:
        await this.replyActionCard(message.senderId, createMainMenuCard(
          `未知命令：/${command.name}。发送 /help 查看可用命令。`
        ));
    }
  }

  private async replyProjectRequired(senderId: string): Promise<void> {
    const fallbackText = "还没有绑定 Codex 项目。发送 /project 选择项目；如果只想继续已有会话，可直接用 /sessions 选择，无需先选项目。";
    await this.replyActionCard(senderId, createChoiceCard({
      title: "先添加一个 Codex 项目",
      body: "还没有绑定项目。点击下方按钮，从 Codex 历史项目中选择。",
      fallbackText,
      choices: [{ label: "选择历史项目", command: "project", arg: "add", style: "primary" }]
    }));
  }

  private async replySessionRequired(senderId: string): Promise<void> {
    const expired = this.options.stateStore.getBindingExpiry(senderId, this.options.config.bindingIdleDays)?.endedReason === "idle";
    await this.reply(senderId, copyableChoices(`${expired ? "此 IM 对话因长期没有人工消息已自动解绑；原 session 和任务均保留。\n\n" : ""}当前 IM 对话未绑定任何 session，这条消息未提交给 Codex。先查看会话列表，再使用列表给出的完整切换命令；不会自动恢复旧绑定或启动任务。`, [
      { label: "查看可绑定会话", value: "/sessions" }, { label: "在当前项目新建会话（需先选择项目）", value: "/new" },
      { label: "新建本机独立会话", value: "/new --standalone" }, { label: "查看绑定帮助", value: "/help session" }
    ]));
  }

  /** Local conversation state only; never resolve native approvals/questions. */
  clearConversationBindingState(senderId: string): void {
    this.historyPages.delete(senderId);
    this.historyRequests.delete(senderId);
    this.buffers.cancel(senderId);
  }

  private ensureBoundProjectContext(senderId: string): boolean {
    if (this.options.stateStore.getBoundSession(senderId)?.projectBinding === "none") return false;
    const projects = this.options.stateStore.listProjects();
    const activeProject = this.options.stateStore.getActiveProject(senderId);
    if (activeProject && projects.some((project) => project.id === activeProject.id)) {
      this.ensureEnabledMode(senderId);
      return true;
    }
    const project = projects[0];
    if (!project) return false;
    this.options.stateStore.activateProject(senderId, project.id);
    this.options.stateStore.setInteractionMode(senderId, this.modeSettings.defaultMode);
    return true;
  }

  private ensureEnabledMode(senderId: string): void {
    const currentMode = this.options.stateStore.getInteractionMode(senderId);
    if (!this.modeSettings.enabledModes.includes(currentMode)) {
      this.options.stateStore.setInteractionMode(senderId, this.modeSettings.defaultMode);
    }
  }

  private async handleNewSessionCommand(senderId: string, arg: string): Promise<boolean> {
    const assertCurrent = this.conversationControlGuard(senderId, "participant");
    const target = parseNewSessionTarget(arg);
    const store = this.options.stateStore;
    if (target.kind === "invalid" || target.kind === "help") {
      await this.reply(senderId, `${target.kind === "invalid" ? "参数无效；指定项目和独立会话不能同时使用。\n\n" : ""}${NEW_SESSION_USAGE}`);
      return false;
    }
    if (target.kind === "standalone") {
      // Never reuse the current project's cwd, and never allocate on an inferred remote host.
      fs.mkdirSync(store.standaloneWorkspacesDir, { recursive: true, mode: 0o700 });
      const workspace = fs.mkdtempSync(path.join(store.standaloneWorkspacesDir, "session-"));
      const session = store.createSession(senderId, workspace, undefined, undefined, "session", undefined, { standalone: true, hostId: "local" });
      store.setInteractionMode(senderId, "session");
      await this.reply(senderId, `已新建并绑定本机独立会话：${session.title}\n\n项目：无\n\n工作目录：${session.workspace}\n\n下一条消息将在这个新会话中开始；目录会持久保留。`);
      return true;
    }
    const project = target.kind === "project"
      ? await this.resolveSelectedProject(senderId, target.selector)
      : store.getActiveProject(senderId);
    if (!project) {
      if (target.kind === "current") {
        await this.replyActionCard(senderId, createChoiceCard({
          title: "选择新会话的位置",
          body: "当前没有项目。请选择项目，或新建本机独立会话。",
          fallbackText: `当前没有项目，不会自动选择其他项目。\n\n${NEW_SESSION_USAGE}`,
          choices: [
            { label: "选择项目", command: "project", arg: "list", style: "primary" },
            { label: "新建独立会话", command: "new", arg: "--standalone" }
          ]
        }));
      }
      return false;
    }
    if (target.kind === "current" && !await this.validateProjectRoute(senderId, project)) return false;
    assertCurrent();
    const session = store.createSession(senderId, project.workspace, undefined, project.id);
    store.setInteractionMode(senderId, "session");
    await this.reply(senderId, `已在${target.kind === "current" ? "当前" : "指定"}项目“${project.name}”新建并绑定会话：${session.title}\n\n主机：${project.hostId ?? "local"}\n\n工作目录：${session.workspace}\n\n下一条消息将在这个新会话中开始。`);
    return true;
  }

  private selectProject(senderId: string, selector: string, candidates: readonly CodexProjectCandidate[], projects: readonly ManagedProject[]) {
    let selected: ReturnType<typeof selectChannelProject>;
    const snapshot = this.projectLists.get(this.catalogActorKey(senderId));
    const nativeChoice = /^([pc][1-9]\d*)@([a-f0-9-]{36})$/i.exec(selector);
    if (nativeChoice) {
      if (nativeChoice[2] !== snapshot?.id) return {
        error: copyableChoices("这张项目卡片已被刷新，请从最新列表重新选择。", [{ label: "刷新项目列表", value: "/project" }])
      };
      selector = nativeChoice[1];
    }
    if (/^[pc][1-9]\d*$/i.test(selector) && !snapshot) return {
      error: copyableChoices("当前没有这份项目列表，请刷新后重新选择。", [{ label: "刷新项目列表", value: "/project" }])
    };
    if (/^[pc][1-9]\d*$/i.test(selector) && snapshot) {
      const saved = snapshot.codes.get(selector.toUpperCase());
      const project = saved?.projectId && projects.find(p => p.id === saved.projectId);
      const candidate = saved?.candidate && candidates.find(c => c.projectId === saved.candidate!.projectId
        && (c.hostId ?? "local") === (saved.candidate!.hostId ?? "local") && c.workspace === saved.candidate!.workspace);
      selected = Date.now() - snapshot.createdAt > 15 * 60_000 || (!project && !candidate) || (saved?.candidate && !candidate)
        ? { error: copyableChoices("项目列表已变化或过期，请刷新后重新选择。", [{ label: "刷新项目列表", value: "/project" }]) }
        : project ? { project } : { candidate: candidate! };
    } else selected = selectChannelProject(selector, projects, candidates, candidate => this.boundProjectForCandidate(candidate, projects));
    if (selected.candidate) {
      const bound = this.boundProjectForCandidate(selected.candidate, projects);
      if (bound) return { project: bound };
    }
    return selected;
  }

  private async resolveSelectedProject(senderId: string, selector: string, catalog?: readonly CodexProjectCandidate[]): Promise<ManagedProject | undefined> {
    const assertCurrent = this.conversationControlGuard(senderId, "participant");
    const candidates = catalog ?? await this.codexProjectCandidates();
    assertCurrent();
    this.synchronizeManagedProjects(candidates);
    const projects = this.options.stateStore.listProjects();
    const selected = this.selectProject(senderId, selector, candidates, projects);
    if (selected.error) {
      await this.reply(senderId, selected.error);
      return;
    }
    const target = selected.project ?? selected.candidate!;
    if (!await this.validateProjectRoute(senderId, target)) return;
    assertCurrent();
    return selected.project ?? this.options.stateStore.createProject(target.name, target.workspace, {
      sourceProjectId: selected.candidate!.projectId,
      rootPaths: selected.candidate!.rootPaths,
      projectKind: target.projectKind,
      hostId: target.hostId
    });
  }

  private async validateProjectRoute(senderId: string, target: Pick<ManagedProject, "name" | "projectKind" | "hostId">): Promise<boolean> {
    if (target.projectKind === "remote" && !target.hostId) {
      await this.reply(senderId, `远程项目「${target.name}」没有 hostId，暂时无法建立远程路由。`);
      return false;
    }
    if (target.hostId && target.hostId !== "local" && this.options.config.codexBackend === "exec") {
      await this.reply(senderId, "纯 CLI 后端不能创建远程项目会话，请切换为 app-server 后端。当前会话未改变。");
      return false;
    }
    return true;
  }

  private async handleProjectCommand(senderId: string, arg: string): Promise<boolean> {
    if (this.cardInteraction.getStore() && /^(?:switch\s+)?[pc][1-9]\d*$/i.test(arg.trim())) {
      await this.reply(senderId, "这张旧项目卡片缺少列表版本，请发送 /project 刷新后重新选择。");
      return false;
    }
    const assertCurrent = this.conversationControlGuard(senderId, requiredCommandRole("project", arg));
    const candidates = await this.codexProjectCandidates();
    assertCurrent();
    this.synchronizeManagedProjects(candidates);
    // add is a compatibility alias; discovery alone never creates bindings.
    const input = arg.trim().replace(/^(?:add|a)(?:\s+|$)/i, "");
    const addMatch = /^(c[1-9]\d*)$/i.exec(input);
    if (addMatch) {
      const project = await this.resolveSelectedProject(senderId, input, candidates);
      if (!project) return false;
      assertCurrent();
      this.options.stateStore.activateProject(senderId, project.id);
      this.options.stateStore.setInteractionMode(senderId, "session");
      await this.reply(
        senderId,
        `已绑定并切换 Codex 项目：${project.name}${project.hostId ? `\n远程主机：${project.hostId}` : ""}\n${project.workspace}`
      );
      return true;
    }
    const projects = this.options.stateStore.listProjects();
    const detail = /^detail\s+(.+)$/i.exec(input);
    if (detail) {
      const selected = this.selectProject(senderId, detail[1].trim(), candidates, projects);
      if (selected.error) { await this.reply(senderId, selected.error); return false; }
      const project = selected.project ?? selected.candidate!;
      await this.reply(senderId, [`项目详情 · ${project.name}（查看不会切换项目）`, `主机：${project.hostId ?? "local"}`,
        `目录：${project.workspace}`, ...("rootPaths" in project && project.rootPaths?.length ? [`项目根目录：${project.rootPaths.join("、")}`] : []),
        `项目 ID：${selected.project?.sourceProjectId ?? selected.candidate?.projectId ?? selected.project?.id}`].join("\n\n"));
      return false;
    }
    const renameMatch = /^(?:rename|rn)\s+(.+)$/i.exec(input);
    if (renameMatch) {
      const [rawCode, name] = renameMatch[1].split("|").map((value) => value.trim());
      const match = /^p([1-9]\d*)$/i.exec(rawCode ?? "");
      const snapshot = this.projectLists.get(this.catalogActorKey(senderId));
      const savedId = match && snapshot?.codes.get(`P${match[1]}`)?.projectId;
      const project = !match ? undefined : snapshot
        ? Date.now() - snapshot.createdAt <= 15 * 60_000 ? projects.find(p => p.id === savedId) : undefined
        : undefined;
      if (!project || !name) {
        await this.reply(senderId, "用法：/project rename P1|新名称");
        return false;
      }
      const renamed = this.options.stateStore.renameProject(project.id, name);
      await this.reply(senderId, `已修改 Gateway 项目显示名称：${renamed.name}\nCodex App 项目名称和磁盘目录未改变。`);
      return false;
    }
    const deleteMatch = /^(?:delete|d)\s+(.+)$/i.exec(input);
    if (deleteMatch) {
      const match = /^p([1-9]\d*)$/i.exec(deleteMatch[1].trim());
      const snapshot = this.projectLists.get(this.catalogActorKey(senderId));
      const savedId = match && snapshot?.codes.get(`P${match[1]}`)?.projectId;
      const project = !match ? undefined : snapshot
        ? Date.now() - snapshot.createdAt <= 15 * 60_000 ? projects.find(p => p.id === savedId) : undefined
        : undefined;
      if (!project) {
        await this.reply(senderId, "用法：/project delete P1");
        return false;
      }
      try {
        this.options.stateStore.deleteProject(project.id);
        await this.reply(senderId, `已移除 Gateway 项目登记：${project.name}\nCodex App 项目和磁盘目录未删除；刷新目录时仍可能发现该项目。`);
      } catch {
        await this.reply(senderId, "项目下还有任务，请先删除或迁移任务后再移除项目。");
      }
      return false;
    }
    const listingInput = /^(?:list|l|retained(?:\s+page\s+[1-9]\d*)?|page\s+[1-9]\d*)?$/i.exec(input);
    if (listingInput) {
      const retained = /^retained/i.test(input);
      const activeProjectId = this.options.stateStore.getActiveProject(senderId)?.id;
      const codes = new Map<string, { projectId?: string; candidate?: CodexProjectCandidate }>();
      const currentIds = new Set<string>();
      let nextAddIndex = 1;
      const rows = candidates.map(candidate => {
        const bound = this.boundProjectForCandidate(candidate, projects);
        if (bound) currentIds.add(bound.id);
        const code = bound ? `P${projects.findIndex(p => p.id === bound.id) + 1}` : `C${nextAddIndex++}`;
        codes.set(code, bound ? { projectId: bound.id, candidate } : { candidate });
        return { code, name: candidate.name, host: sessionHostLabel(candidate.hostId ?? "local"), workspace: candidate.workspace,
          status: bound && bound.id === activeProjectId ? "当前" : bound ? "已登记" : "可选择" };
      });
      // Historical native registrations remain durable, but do not masquerade
      // as projects currently present in the App or create false name matches.
      const historical = projects.filter(p => !currentIds.has(p.id));
      for (const p of historical) {
        const code = `P${projects.findIndex(item => item.id === p.id) + 1}`;
        codes.set(code, { projectId: p.id });
        if (retained || !p.sourceProjectId) rows.push({ code, name: p.name, host: sessionHostLabel(p.hostId ?? "local"), workspace: p.workspace,
          status: p.id === activeProjectId ? "当前 · 历史登记" : "历史登记" });
      }
      const displayed = retained ? rows.filter(row => row.status.includes("历史登记")) : rows;
      const pageSize = 10, pages = Math.max(1, Math.ceil(displayed.length / pageSize));
      const page = Math.min(pages, Number(/(?:^|\s)page\s+(\d+)$/i.exec(input)?.[1] ?? 1));
      const pageRows = displayed.slice((page - 1) * pageSize, page * pageSize);
      const key = this.catalogActorKey(senderId);
      const previous = this.projectLists.get(key);
      // Page navigation uses the exact same identities; refresh is explicit.
      if (/(?:^|\s)page/i.test(input) && (!previous || Date.now() - previous.createdAt > 15 * 60_000)) {
        await this.reply(senderId, copyableChoices("项目列表已过期，请刷新后翻页。", [{ label: "刷新项目列表", value: "/project" }])); return false;
      }
      if (/(?:^|\s)page/i.test(input) && previous) {
        if (codes.size !== previous.codes.size || [...codes].some(([code, value]) => JSON.stringify(value) !== JSON.stringify(previous.codes.get(code)))) {
          await this.reply(senderId, copyableChoices("项目目录已变化，请刷新后重新选择。", [{ label: "刷新项目列表", value: "/project" }])); return false;
        }
      }
      for (const [k,v] of this.projectLists) if (Date.now() - v.createdAt > 15 * 60_000 && k !== key) this.projectLists.delete(k);
      const snapshot = previous && /(?:^|\s)page/i.test(input)
        ? { id: previous.id, createdAt: previous.createdAt, codes }
        : { id: randomUUID(), createdAt: Date.now(), codes };
      this.projectLists.set(key, snapshot);
      const title = `${retained ? "历史项目登记" : "Codex 项目"} · ${displayed.length} 个 · ${page}/${pages} 页`;
      const table: ChannelTable = { columns: ["编号", "项目", "主机", "状态"].map(label => ({ label })),
        rows: pageRows.map(row => [row.code, compactTableCell(row.name, 32), row.host, row.status]) };
      const body = pageRows.length ? "" : "当前没有可选择的项目。";
      const note = (retained ? "历史登记不会被删除，也不参与当前项目的同名匹配。" : "来自当前 Codex 目录；手工登记及历史项目单独标明。") + "\n查看路径：/project detail 项目编号。";
      const navigation = [
        ...(page > 1 ? [{ label: "上一页", value: `/project ${retained ? "retained " : ""}page ${page - 1}` }] : []),
        ...(page < pages ? [{ label: "下一页", value: `/project ${retained ? "retained " : ""}page ${page + 1}` }] : []),
        ...(!retained && historical.some(p => p.sourceProjectId) ? [{ label: "查看历史登记", value: "/project retained" }] : [])
      ];
      await this.replyActionCard(senderId, createChoiceCard({ title, body, table, note,
        fallbackText: [title, body, renderTextTable(table), note].filter(Boolean).join("\n\n"),
        copyChoices: [...(pageRows.length ? [{ label: "选择项目模板（将“项目编号”替换为上表的 P 或 C 编号）", value: "/project 项目编号" }] : []), ...navigation],
        choices: [...pageRows.map(row => ({ label: `${row.code} ${row.name}`, command: "project" as const, arg: `${row.code}@${snapshot.id}`, copyValue: `/project ${row.code}` })),
          ...navigation.map(item => ({ label: item.label, command: "project" as const, arg: item.value.slice(9) }))] }));
      return false;
    }
    const requestedProject = /^(?:switch)\s+(.+)$/i.exec(input)?.[1]?.trim() ?? input;
    const project = await this.resolveSelectedProject(senderId, requestedProject, candidates);
    if (!project) return false;
    assertCurrent();
    this.options.stateStore.activateProject(senderId, project.id);
    this.options.stateStore.setInteractionMode(senderId, this.modeSettings.defaultMode);
    const fallbackText = [
      `已切换 Codex 项目：${project.name}`,
      project.workspace,
      "请选择接下来要进入的工作模式。"
    ].join("\n");
    await this.replyActionCard(senderId, createChoiceCard({
      title: `已切换到 ${conciseButtonLabel(project.name, 28)}`,
      template: "green",
      body: `${project.workspace}\n\n请选择此渠道已开放的工作模式。`,
      fallbackText,
      choices: this.modeChoices(this.modeSettings.defaultMode)
    }));
    return true;
  }

  private async handleModeCommand(message: ChannelMessage, arg: string): Promise<void> {
    const senderId = message.senderId;
    const assertCurrent = this.conversationControlGuard(senderId, requiredCommandRole("mode", arg));
    const project = this.options.stateStore.getActiveProject(senderId);
    if (!project) {
      await this.replyActionCard(senderId, createChoiceCard({
        title: "先选择项目",
        body: "三种工作模式都归属于当前项目。",
        fallbackText: "请先选择项目。",
        choices: [{ label: "选择项目", command: "project", arg: "list", style: "primary" }]
      }));
      return;
    }
    const requested = normalizeMode(arg);
    if (!requested) {
      await this.replyModeCard(senderId, project);
      return;
    }
    if (!this.modeSettings.enabledModes.includes(requested)) {
      await this.replyModeUnavailable(senderId, requested);
      return;
    }
    if (requested === "task") {
      this.options.stateStore.setInteractionMode(senderId, "task");
      await this.taskboardController.handle(message, "list");
      return;
    }
    if (requested === "session") {
      const existing = this.options.stateStore.listSessions()
        .filter((session) => (
          session.senderId === senderId && session.projectId === project.id && session.mode !== "qa"
        ))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const session = existing
        ? this.options.stateStore.activateSession(existing.id)
        : this.options.stateStore.createSession(senderId, project.workspace, undefined, project.id);
      this.options.stateStore.setSessionCollaborationMode(session.id, "default");
      this.options.stateStore.setInteractionMode(senderId, "session");
      await this.replyActionCard(senderId, createChoiceCard({
        title: "已进入会话模式",
        template: "green",
        body: `项目：${project.name}\n会话：${session.title}\n\n直接发送自然语言即可继续协作。`,
        fallbackText: `已进入会话模式：${project.name} / ${session.title}`,
        choices: [
          { label: "选择会话", command: "sessions", arg: "", style: "primary" },
          { label: "计划模式", command: "plan", arg: "toggle" },
          { label: "查看目标", command: "goal", arg: "" }
        ]
      }));
      return;
    }
    const knowledgeBase = this.resolveQaContext(project);
    if (!knowledgeBase) {
      await this.replyActionCard(senderId, createChoiceCard({
        title: "尚未绑定 llm-wiki",
        body: `项目“${project.name}”还没有绑定知识库。请先在渠道后台的“知识库”页面完成绑定。`,
        fallbackText: `项目“${project.name}”尚未绑定 llm-wiki，请在渠道后台完成绑定。`,
        choices: [
          { label: "切换项目", command: "project", arg: "list", style: "primary" },
          ...this.modeChoices().filter((choice) => choice.arg !== "qa")
        ]
      }));
      return;
    }
    try {
      await this.llmWiki.inspect(knowledgeBase);
    } catch (error) {
      await this.replyActionCard(senderId, createChoiceCard({
        title: "知识库暂不可用",
        template: "red",
        body: `${knowledgeBase.name}\n${error instanceof Error ? error.message : String(error)}`,
        fallbackText: `知识库“${knowledgeBase.name}”暂不可用。`,
        choices: [
          { label: "重试", command: "mode", arg: "qa", style: "primary" },
          ...this.modeChoices().filter((choice) => choice.arg !== "qa")
        ]
      }));
      return;
    }
    const current = this.options.stateStore.getActiveQaSession(senderId);
    assertCurrent();
    const reusable = current?.projectId === project.id && current.knowledgeBaseId === knowledgeBase.id
      ? current
      : this.options.stateStore.listSessions()
        .filter((session) => (
          session.senderId === senderId
          && session.projectId === project.id
          && session.mode === "qa"
          && session.knowledgeBaseId === knowledgeBase.id
        ))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const session = reusable
      ? this.options.stateStore.activateSession(reusable.id)
      : this.options.stateStore.createSession(
          senderId,
          project.workspace,
          `问答 · ${knowledgeBase.name}`,
          project.id,
          "qa",
          knowledgeBase.id
        );
    this.options.stateStore.setInteractionMode(senderId, "qa");
    await this.replyActionCard(senderId, createChoiceCard({
      title: "已进入问答模式",
      template: "green",
      body: `当前项目：${project.name}\n知识库：${knowledgeBase.name}\n\nCodex 会在项目目录中工作，并按问题自主调用 llm-wiki 的只读检索工具。`,
      fallbackText: `已进入问答模式：项目 ${project.name}，知识库 ${knowledgeBase.name}`,
      choices: [
        { label: "查看当前上下文", command: "status", arg: "", style: "primary" },
        ...this.modeChoices("qa").filter((choice) => choice.arg !== "qa")
      ]
    }));
  }

  private async replyModeCard(senderId: string, project: ManagedProject): Promise<void> {
    const active = this.options.stateStore.getInteractionMode(senderId);
    const knowledgeBase = this.resolveQaContext(project);
    await this.replyActionCard(senderId, createChoiceCard({
      title: `当前项目 · ${conciseButtonLabel(project.name, 24)}`,
      body: [
        project.workspace,
        `当前模式：${formatInteractionMode(active)}`,
        `问答知识库：${knowledgeBase?.name ?? "未绑定"}`
      ].join("\n"),
      fallbackText: `当前项目 ${project.name}，当前模式 ${formatInteractionMode(active)}`,
      choices: this.modeChoices(active)
    }));
  }

  private modeChoices(active?: ProjectInteractionMode): ChannelChoice[] {
    return this.modeSettings.enabledModes.map((mode): ChannelChoice => {
      switch (mode) {
        case "session":
          return { label: "会话模式", command: "mode", arg: mode, style: active === mode ? "primary" : "default" };
        case "task":
          return { label: "任务模式", command: "mode", arg: mode, style: active === mode ? "primary" : "default" };
        case "qa":
          return { label: "问答模式", command: "mode", arg: mode, style: active === mode ? "primary" : "default" };
        default:
          return assertNeverMode(mode);
      }
    });
  }

  private async replyModeUnavailable(senderId: string, requested: ProjectInteractionMode): Promise<void> {
    const active = this.options.stateStore.getInteractionMode(senderId);
    await this.replyActionCard(senderId, createChoiceCard({
      title: "此渠道未开放该模式",
      template: "orange",
      body: `${formatInteractionMode(requested)}未在渠道配置中启用。可直接选择当前渠道开放的模式。`,
      fallbackText: `${formatInteractionMode(requested)}未在渠道配置中启用。`,
      choices: this.modeChoices(active)
    }));
  }

  private async handlePlanCommand(senderId: string, arg: string): Promise<void> {
    this.assertSessionCapability(senderId, "collaborationModes");
    const session = this.executionSession(senderId);
    if (!session) {
      await this.replyActionCard(senderId, createChoiceCard({
        title: "尚未进入可执行会话",
        body: "先进入会话或问答模式，再切换 Codex 的计划模式。",
        fallbackText: "请先进入会话或问答模式。",
        choices: [{ label: "会话模式", command: "mode", arg: "session", style: "primary" }]
      }));
      return;
    }
    const input = arg.trim().toLowerCase();
    if (input && !["on", "plan", "off", "default", "toggle"].includes(input)) {
      await this.reply(senderId, "用法：/plan [on|off|toggle]。未更改当前计划模式。");
      return;
    }
    const mode = input === "on" || input === "plan"
      ? "plan"
      : input === "off" || input === "default"
        ? "default"
        : session.collaborationMode === "plan" ? "default" : "plan";
    this.options.stateStore.setSessionCollaborationMode(session.id, mode);
    await this.replyActionCard(senderId, createChoiceCard({
      title: mode === "plan" ? "已开启计划模式" : "已回到普通对话",
      template: mode === "plan" ? "blue" : "green",
      body: mode === "plan"
        ? "下一条消息起，Codex 会在同一会话中使用原生计划能力，并正常回复澄清问题和方案。"
        : "已移除计划协作状态。下一条消息起使用不附加任何模式的普通对话。",
      fallbackText: mode === "plan" ? "已开启 Codex 计划模式。" : "已回到普通对话。",
      choices: [
        { label: mode === "plan" ? "回到普通对话" : "切到计划模式", command: "plan", arg: "toggle", style: "primary" },
        { label: "查看目标", command: "goal", arg: "" }
      ]
    }));
  }

  private async handleGoalCommand(message: ChannelMessage, arg: string): Promise<void> {
    const senderId = message.senderId;
    this.assertSessionCapability(senderId, "goals");
    const session = this.executionSession(senderId);
    if (!session?.threadId) {
      await this.replyActionCard(senderId, createChoiceCard({
        title: "当前项目尚未开始会话",
        body: "Codex 目标绑定到具体会话。先选择工作模式并开始协作，创建 thread 后即可用原生目标卡片设置。",
        fallbackText: "当前项目尚未创建 Codex thread，暂时不能设置目标。",
        choices: [
          { label: "会话模式", command: "mode", arg: "session", style: "primary" },
          { label: "问答模式", command: "mode", arg: "qa" }
        ]
      }));
      return;
    }
    const input = arg.trim();
    const assertCurrent = this.controlGuard(senderId, session, "participant");
    if (/^(?:new|form|set)$/i.test(input)) {
      const project = this.options.stateStore.getActiveProject(senderId);
      await this.replyTaskCard(message, createGoalFormCard(project?.name ?? "当前项目"));
      return;
    }
    if (/^clear$/i.test(input)) {
      assertCurrent();
      await this.runner.clearGoal(session.threadId, this.sessionHostId(session), assertCurrent);
      await this.reply(senderId, "已清除当前 Codex 目标。");
      return;
    }
    const statusMatch = /^(pause|resume|complete)$/i.exec(input);
    if (statusMatch) {
      const status = ({ pause: "paused", resume: "active", complete: "complete" } as const)[
        statusMatch[1].toLowerCase() as "pause" | "resume" | "complete"
      ];
      assertCurrent();
      const goal = await this.runner.setGoal(session.threadId, { status }, this.sessionHostId(session), assertCurrent);
      await this.replyGoalCard(message, goal);
      return;
    }
    const setMatch = /^(?:set\s+)?(.+)$/is.exec(input);
    if (setMatch && input) {
      const objective = setMatch[1].trim();
      assertCurrent();
      const goal = await this.runner.setGoal(
        session.threadId,
        { objective, status: "active" },
        this.sessionHostId(session),
        assertCurrent
      );
      await this.replyGoalCard(message, goal);
      return;
    }
    await this.replyGoalCard(message, await this.runner.getGoal(session.threadId, this.sessionHostId(session)));
  }

  private async replyGoalCard(message: ChannelMessage, goal: CodexThreadGoal | undefined): Promise<void> {
    const senderId = message.senderId;
    if (!goal) {
      const project = this.options.stateStore.getActiveProject(senderId);
      await this.replyTaskCard(message, createGoalFormCard(project?.name ?? "当前项目"));
      return;
    }
    await this.replyActionCard(senderId, createChoiceCard({
      title: `目标 · ${formatGoalStatus(goal.status)}`,
      template: goal.status === "complete" ? "green" : goal.status === "blocked" ? "red" : "blue",
      body: [
        goal.objective,
        `已使用 ${goal.tokensUsed} tokens · ${formatDuration(goal.timeUsedSeconds)}`,
        goal.tokenBudget ? `预算 ${goal.tokenBudget} tokens` : "未设置 token 预算",
        "继续直接发送消息，Codex 会在这个目标下正常回复；清除目标后回到无目标的普通对话。"
      ].join("\n\n"),
      fallbackText: `Codex 目标：${goal.objective}（${formatGoalStatus(goal.status)}）`,
      choices: goal.status === "active"
          ? [
            { label: "暂停目标", command: "goal", arg: "pause", style: "primary" },
            { label: "标记完成", command: "goal", arg: "complete" },
            { label: "修改目标", command: "goal", arg: "form" },
            { label: "清除目标", command: "goal", arg: "clear" }
          ]
        : [
            { label: "继续目标", command: "goal", arg: "resume", style: "primary" },
            { label: "修改目标", command: "goal", arg: "form" },
            { label: "清除目标", command: "goal", arg: "clear" }
          ]
    }));
  }

  private executionSession(senderId: string): ManagedSession | undefined {
    const session = this.options.stateStore.getBoundSession(senderId);
    if (!session) return undefined;
    const project = this.options.stateStore.getActiveProject(senderId);
    const mode = this.options.stateStore.getInteractionMode(senderId);
    if (mode === "qa" && (!project || session.knowledgeBaseId !== this.resolveQaContext(project)?.id)) return undefined;
    return session;
  }

  private controlGuard(conversationId: string, session: ManagedSession | undefined, required: SessionRole): () => void {
    const actorId = this.actor.getStore() ?? conversationId;
    const binding = session && sessionExecutionScope(this.options.stateStore, session, conversationId);
    return () => {
      this.options.assertRuntimeWritable?.();
      if (this.audienceSuspended || (binding ? !binding.current() : !!this.executionSession(conversationId))
        || !this.access.requireAccess(actorId, conversationId).allowed
        || !roleAllows(this.role(conversationId, actorId), required))
        throw new CodexInterventionError("会话绑定、准入或角色权限已改变，控制操作未提交。");
    };
  }

  /** An asynchronous configuration/selection query cannot later retarget its
   * mutation to a newer binding, or revive a binding explicitly left meanwhile. */
  private conversationControlGuard(senderId: string, required: SessionRole): () => void {
    const originalSession = this.executionSession(senderId);
    const assertCurrent = this.controlGuard(senderId, originalSession, required);
    const projectId = this.options.stateStore.getActiveProject(senderId)?.id;
    const mode = this.options.stateStore.getInteractionMode(senderId);
    // An unbound query has no session execution generation. Existing detach
    // and activity facts fence a later leave or bind/leave round trip without
    // invalidating bound controls for unrelated human activity.
    const detached = this.options.stateStore.isSessionDetached(senderId);
    const unboundGeneration = !originalSession ? this.options.stateStore.getBindingExpiry(senderId, 0)?.generation : undefined;
    return () => {
      assertCurrent();
      if (this.options.stateStore.getActiveProject(senderId)?.id !== projectId
        || this.options.stateStore.getInteractionMode(senderId) !== mode
        || !originalSession && (this.options.stateStore.isSessionDetached(senderId) !== detached
          || this.options.stateStore.getBindingExpiry(senderId, 0)?.generation !== unboundGeneration))
        throw new CodexInterventionError("查询期间项目或模式已改变，旧控制操作未应用，请重新操作。");
    };
  }

  private async recoverSystemPreflight(senderId: string, session: ManagedSession, state: CodexThreadState): Promise<CodexThreadState> {
    if (state.runtimeStatus !== "systemError" || !state.lastTurnFailure || state.lastTurnFailure.code === "model-capacity"
      || !this.options.requestSystemRecovery) return state;
    const recovered = await this.options.requestSystemRecovery({ hostId: this.sessionHostId(session), threadId: state.threadId,
      turnId: state.lastTurnFailure.turnId }, this.controlGuard(senderId, session, "participant"));
    if (recovered) return recovered;
    const progress = this.options.sessionFollow?.status(session).runtimeRecovery;
    throw new CodexThreadStateError("system-error", state.threadId,
      `${progress?.turnId === state.lastTurnFailure.turnId ? progress.message : "systemError 恢复检查尚未确认成功，请查看恢复进展。"}\n本条输入尚未提交到 Codex。`, state.lastTurnFailure,
      progress?.turnId === state.lastTurnFailure.turnId ? progress.phase : "recovering");
  }

  private assertSessionCapability(senderId: string, capability: "liveFollow" | "collaborationModes" | "goals" | "progress"): void {
    const session = this.executionSession(senderId);
    const info = this.runner.backendInfo?.(session ? this.sessionHostId(session) : undefined);
    if (info && !info.capabilities[capability]) throw new CodexBackendCapabilityError(capability, info.id);
  }

  private updateExecutionRuntime(
    senderId: string,
    overrides: { model?: string | null; effort?: string | null; streamReplies?: boolean | null }
  ): void {
    let session = this.executionSession(senderId);
    const project = this.options.stateStore.getActiveProject(senderId);
    if (!session && project) {
      const knowledgeBase = this.options.stateStore.getInteractionMode(senderId) === "qa"
        ? this.resolveQaContext(project)
        : undefined;
      session = knowledgeBase
        ? this.ensureQaSession(senderId, project, knowledgeBase)
        : this.ensureConversationSession(senderId, project);
    }
    if (!session) throw new Error("No active session for current mode");
    this.options.stateStore.updateSessionRuntime(session.id, overrides);
  }

  private async handleSessionCommand(senderId: string, arg: string): Promise<void> {
    return this.catalogControls.run(senderId, () => this.handleSessionCatalog(senderId, arg));
  }

  private async handleSessionCatalog(senderId: string, arg: string): Promise<void> {
    const actorId = this.actor.getStore() ?? senderId;
    const key = JSON.stringify([senderId, actorId]);
    let input = arg.trim();
    let resized = false;
    let listing = this.sessionLists.get(key);
    if (/^size(?:\s|$)/i.test(input)) {
      const size = /^size\s+(\d+)$/i.exec(input);
      if (!size || !isSessionPageSize(Number(size[1]))) {
        await this.reply(senderId, `用法：/sessions size ${MIN_SESSION_PAGE_SIZE}-${MAX_SESSION_PAGE_SIZE}，例如 /sessions size 50；当前每页 ${this.options.stateStore.getSessionPageSize(senderId, actorId)} 条。`);
        return;
      }
      const pageSize = Number(size[1]);
      this.options.stateStore.setSessionPageSize(senderId, actorId, pageSize);
      if (listing && Date.now() - listing.createdAt <= 15 * 60_000) {
        // Retain the current anchor, filter, ordering and R identities without rediscovery.
        listing.page = Math.floor(listing.page * listing.pageSize / pageSize);
        listing.pageSize = pageSize;
        resized = true;
      }
      input = "";
    }
    const detail = /^detail\s+r([1-9]\d*)$/i.exec(input);
    if (/^detail(?:\s|$)/i.test(input) && !detail) {
      await this.reply(senderId, copyableChoices("请先获取当前会话列表，再使用列表提供的详情命令；查看详情不会切换会话。", [{ label: "获取当前会话编号", value: "/sessions" }])); return;
    }
    if (/^(search|page)$/i.test(input)) {
      await this.reply(senderId, "用法：/sessions search 关键词；/sessions page 页码；/sessions 查看全部会话。");
      return;
    }
    if (/^\d+$/.test(input)) { await this.reply(senderId, "请使用 R 开头的切换编号，例如 /session R1，或完整的会话 ID。"); return; }
    const numbered = /^r([1-9]\d*)$/i.exec(input);
    const navigation = /^(more|next|prev|page\s+\d+)$/i.test(input);
    if (numbered || navigation || detail || resized) {
      if (!listing || Date.now() - listing.createdAt > 15 * 60_000) {
        await this.reply(senderId, copyableChoices("会话列表已过期，请刷新后重新选择。", [{ label: "刷新会话列表", value: "/sessions" }])); return;
      }
      if (detail) {
        const row = listing.rows[Number(detail[1]) - 1];
        if (!row) { await this.reply(senderId, copyableChoices("没有这个编号，请查看当前会话列表。", [{ label: "查看会话列表", value: "/sessions" }])); return; }
        const { state, hostId, group } = row;
        await this.reply(senderId, [
          `会话详情 · R${detail[1]}（列表快照，不切换会话）`,
          `标题：${compactTableCell(state.title ?? state.preview ?? "未命名", 400)}`,
          `归属：${group?.name ?? "无项目"}${state.workspaceProjectId && !state.projectId ? "（CLI 工作目录分组，非原生项目绑定）" : ""}`,
          `主机：${hostId}`, `目录：${state.cwd}`, `ID：${state.threadId}`,
          `状态：${projectSessionChoiceStateLabel({ title: state.title ?? "", updatedAt: state.updatedAt ?? "", candidate: codexThreadStateCandidate(state, state.cwd ?? "") })}`,
          `更新：${state.updatedAt ? formatSessionTime(state.updatedAt) : "时间未知"}`,
          `继续此会话：\n\n${copyBlock(`/session R${detail[1]}`)}`
        ].join("\n\n"));
        return;
      }
      if (numbered) {
        const row = listing.rows[Number(numbered[1]) - 1];
        if (!row) { await this.reply(senderId, copyableChoices("没有这个编号，请查看当前会话列表。", [{ label: "查看会话列表", value: "/sessions" }])); return; }
        await this.bindCatalogSession(senderId, row.state.threadId, row.hostId); return;
      }
      const requested = /(?:^|\s)page\s+(\d+)$/i.exec(input);
      if (!resized) listing.page = requested ? Number(requested[1]) - 1 : listing.page + (/^prev$/i.test(input) ? -1 : 1);
      listing.page = Math.min(Math.max(0, Math.ceil(listing.rows.length / listing.pageSize) - 1), Math.max(0, listing.page));
    } else if (input && !/^(all|unbound|unassigned|project|search\s+.+)$/i.test(input)) {
      const direct = /^(\S+)(?:\s+--host\s+(\S+))?$/.exec(input);
      if (!direct) { await this.reply(senderId, "用法：/sessions [all|unbound|project|search 关键词|more|prev]；/session <会话ID> [--host 主机ID]"); return; }
      await this.bindCatalogSession(senderId, direct[1], direct[2]); return;
    } else {
      const activeProject = this.options.stateStore.getActiveProject(senderId);
      const projectOnly = input.toLowerCase() === "project";
      if (projectOnly && !activeProject) { await this.reply(senderId, copyableChoices("当前没有选择项目，可以选择已有会话或项目。", [{ label: "查看已有会话", value: "/sessions" }, { label: "选择项目", value: "/project" }])); return; }
      const query = /^search\s+(.+)$/i.exec(input)?.[1].toLocaleLowerCase();
      const unassigned = /^(unbound|unassigned)$/i.test(input);
      const hosts = new Set(["local"]);
      const warnings: string[] = [];
      let purposes = new SessionPurposeIndex();
      try { purposes = readSessionPurposes(this.options.stateStore.sessionPurposeRegistryPath); }
      catch { warnings.push("会话用途配置无法读取，本次未隐藏探活记录；请检查 session-purposes.json 后刷新。"); }
      const hiddenProbes = new Set<string>();
      const catalogInput = { persistence: "active" as const, ...(projectOnly ? { cwd: activeProject!.workspace, projectId: activeProject!.sourceProjectId } : {}), ...(unassigned ? { unassigned: true } : {}) };
      const firstHost = projectOnly ? activeProject?.hostId ?? "local" : "local";
      // Resolve the catalog backend before optional project-name enrichment.
      // In auto mode a failed enrichment must not select a different backend.
      const firstCatalog = this.runner.listSessionCatalog?.(catalogInput, firstHost);
      if (firstCatalog) await firstCatalog.catch(() => undefined); // Report once in the host loop below.
      let projectCatalog: readonly CodexProjectCandidate[] = [];
      try { projectCatalog = await this.codexProjectCandidates(); }
      catch { warnings.push("项目目录暂不可用，项目名称及远程主机列表可能不完整；仍保留可读取的会话。"); }
      if (projectOnly) { hosts.clear(); hosts.add(activeProject?.hostId ?? "local"); }
      else if (this.options.config.codexBackend !== "exec") {
        for (const p of projectCatalog) if (p.hostId) hosts.add(p.hostId);
        if (!projectCatalog.length) for (const p of this.options.stateStore.listProjects()) if (p.hostId) hosts.add(p.hostId);
      }
      const rows: NonNullable<typeof listing>["rows"] = [];
      const visitedHosts = new Set<string>();
      while ([...hosts].some(host => !visitedHosts.has(host))) {
      await Promise.all([...hosts].filter(host => !visitedHosts.has(host)).map(async (hostId) => {
        visitedHosts.add(hostId);
        try {
          // Kept only for legacy embedded integrations; both concrete backends
          // implement the catalog boundary and never take this compatibility path.
          const catalog = hostId === firstHost && firstCatalog ? await firstCatalog
            : this.runner.listSessionCatalog ? await this.runner.listSessionCatalog(catalogInput, hostId) : undefined;
          const states = catalog?.threads ?? await this.runner.listThreads(catalogInput, hostId);
          if (catalog) {
            warnings.push(...catalog.warnings);
            if (!catalog.complete && !catalog.warnings.length) warnings.push(`${hostId} 的会话目录尚未同步完整，请稍后刷新。`);
            if (!projectOnly && catalog.backend === "app-server") for (const host of catalog.hostIds) hosts.add(host);
          }
          for (const state of states) {
            if (state.persistence !== "active" || state.internal || (unassigned && state.projectId)) continue;
            if (query && !`${state.title ?? ""} ${state.preview ?? ""} ${state.threadId} ${state.cwd ?? ""}`.toLocaleLowerCase().includes(query)) continue;
            if (purposes.isProbe(state.threadId, hostId)) {
              hiddenProbes.add(JSON.stringify([hostId, state.threadId]));
              continue;
            }
            rows.push({ state, hostId });
          }
        } catch (error) {
          console.warn(`[codex-im-gateway] session catalog unavailable for ${hostId}: ${String(error)}`);
          warnings.push(`${hostId} 的会话列表暂不可用，请稍后刷新；未切换到其他后端。`);
        }
      }));
      }
      if (hiddenProbes.size) warnings.push(`已隐藏 ${hiddenProbes.size} 个已确认的探活会话（未删除、未归档）。`);
      const unique = [...new Map(rows.map(row => [JSON.stringify([row.hostId, row.state.threadId]), row])).values()];
      const ordered = orderSessionCatalog(unique, projectCatalog, this.options.stateStore.listProjects(), activeProject);
      listing = { rows: ordered, page: 0, pageSize: this.options.stateStore.getSessionPageSize(senderId, actorId), createdAt: Date.now(), label: projectOnly ? `项目 ${activeProject!.name}` : unassigned ? "无项目" : query ? `搜索：${query}` : "全部", warnings: [...new Set(warnings)] };
      for (const [k,v] of this.sessionLists) if (Date.now() - v.createdAt > 15 * 60_000) this.sessionLists.delete(k);
      this.sessionLists.set(key, listing);
    }
    const start = listing.page * listing.pageSize;
    const pageRows = listing.rows.slice(start, start + listing.pageSize);
    const active = this.options.stateStore.getActiveSession(senderId);
    const title = `可绑定会话 · ${compactTableCell(listing.label, 32)} · ${listing.rows.length} 个 · 第 ${listing.page + 1}/${Math.max(1, Math.ceil(listing.rows.length / listing.pageSize))} 页`;
    const table: ChannelTable = { columns: ["编号", "会话", "归属", "状态"].map(label => ({ label })), rows: pageRows.map(({state,hostId,group}, index) => {
      const current = active?.threadId === state.threadId && this.sessionHostId(active) === hostId;
      const name = state.title || codexSessionCandidatePreview(codexThreadStateCandidate(state, state.cwd ?? "")) || "未命名";
      const status = projectSessionChoiceStateLabel({ title: name, updatedAt: state.updatedAt ?? "", candidate: codexThreadStateCandidate(state, state.cwd ?? "") });
      return [`R${start + index + 1}`, compactTableCell(`${state.catalogOrder?.pinnedIndex !== undefined ? "📌 " : ""}${current ? "【当前】 " : ""}${name}`, 28),
        group?.label ?? `无项目${hostId !== "local" ? ` · ${compactTableCell(sessionHostLabel(hostId), 15)}` : ""}`,
        status.replace("Desktop 已打开", "已打开").replace("上次执行失败", "上次失败").replace("上次已停止", "已停止").replace("状态未知", "未知")];
    }) };
    const body = [...(!pageRows.length ? ["没有符合条件的未归档会话。"] : []), ...listing.warnings].join("\n\n");
    const note = `置顶 → 项目目录顺序 → 其他会话；组内遵循 App 排序 · 每页 ${listing.pageSize} 条。\n查看详情：/sessions detail R编号。`;
    const text = [title, body, renderTextTable(table), note].filter(Boolean).join("\n\n");
    await this.replyActionCard(senderId, createChoiceCard({ title, body: escapeTableMarkdown(body), ...(pageRows.length ? { table } : {}), note, fallbackText: text,
      copyChoices: [
        ...(pageRows.length ? [{ label: "选择会话模板（将“编号”替换为上表数字）", value: "/session R编号" }] : []),
        ...(listing.page > 0 ? [{ label: "上一页", value: "/sessions prev" }] : []),
        ...(start + listing.pageSize < listing.rows.length ? [{ label: "下一页", value: "/sessions more" }] : [])],
      choices: [...pageRows.map(({state,hostId}, i): ChannelChoice => ({ label: `R${start+i+1}`, command: "session", arg: `${state.threadId} --host ${hostId}`, copyValue: `/session R${start+i+1}` })),
        ...(listing.page > 0 ? [{ label: "上一页", command: "sessions" as const, arg: "prev" }] : []),
        ...(start + listing.pageSize < listing.rows.length ? [{ label: "下一页", command: "sessions" as const, arg: "more" }] : [])] }));
  }

  private async bindCatalogSession(senderId: string, threadId: string, hostId?: string): Promise<void> {
    if (!await this.requireRole(senderId, "participant")) return;
    const assertCurrent = this.conversationControlGuard(senderId, "participant");
    // An unqualified ID already known to this chat must retain its host; IDs
    // alone are not a globally unique routing key. Never probe/resume writers
    // on another backend to guess ownership.
    if (!hostId) {
      const knownHosts = new Set(this.options.stateStore.listSessions()
        .filter(session => session.senderId === senderId && session.threadId === threadId)
        .map(session => this.sessionHostId(session) ?? "local"));
      if (knownHosts.size > 1) {
        await this.reply(senderId, copyableChoices("这个会话 ID 对应多个主机，请明确选择要绑定的主机。", [...knownHosts].map(hostId => ({
          label: `绑定主机 ${hostId} 上的会话`, value: `/session ${threadId} --host ${hostId}`
        }))));
        return;
      }
      hostId = knownHosts.values().next().value ?? "local";
    }
    let state: CodexThreadState;
    try { state = await this.runner.inspectThread(threadId, hostId); }
    catch (error) {
      if (!/thread not loaded:/i.test(String(error))) throw error;
      await this.reply(senderId, `主机 ${hostId} 尚未加载这个会话，未更改原绑定。若会话在远端，请使用 /session ${threadId} --host <主机ID>，或通过 /sessions 列表选择。绑定和查看历史不会启动任务。`);
      return;
    }
    const reason = unavailableProjectSessionChoiceReason({ title: state.title ?? threadId, updatedAt: state.updatedAt ?? "", candidate: codexThreadStateCandidate(state, state.cwd ?? "") });
    if (state.persistence !== "active" || state.internal || reason) { await this.reply(senderId, reason ?? "此会话不可绑定，请选择未归档的普通会话。"); return; }
    if (!state.cwd || !path.isAbsolute(state.cwd)) { await this.reply(senderId, "该会话没有可确认的工作目录，未建立绑定。"); return; }
    const store = this.options.stateStore;
    assertCurrent();
    const existing = store.listSessions().find(s => s.senderId === senderId && s.mode !== "qa" && s.threadId === threadId && this.sessionHostId(s) === hostId);
    let project = state.projectId ? managedProjectForNative({ projectId: state.projectId, hostId, workspace: state.cwd }, store.listProjects()) : undefined;
    if (!project && state.projectId) {
      project = store.createProject(path.basename(state.cwd), state.cwd, { sourceProjectId: state.projectId, hostId, projectKind: hostId === "local" ? "local" : "remote" });
    }
    if (existing) {
      // Explicit native membership supersedes old edges even with follow off.
      // Unknown membership preserves the edge; cwd itself is still observed.
      const observedProjectId = state.projectId || state.projectMembership === "none" ? project?.id : existing.projectId;
      store.reconcileThreadProject(threadId, hostId, observedProjectId, state.cwd);
    }
    const session = existing ? store.activateSession(existing.id) : store.createSession(senderId, state.cwd, state.title || `会话 ${threadId.slice(0,8)}`, project?.id, "session", undefined, { standalone: !project, hostId });
    if (!existing) store.setSessionThread(session.id, threadId);
    const canFollow = this.runner.backendInfo?.(hostId).capabilities.liveFollow ?? this.options.config.codexBackend !== "exec";
    if (!canFollow) store.setSessionFollow(session.id, false);
    store.setInteractionMode(senderId, "session");
    await this.reply(senderId, `已绑定会话：${session.title}\n\n主机：${hostId}\n\n工作目录：${state.cwd}\n\n下一条消息将继续这个会话；/history 查看历史，/leave 退出绑定。`);
    await this.handleHistoryCommand(senderId, "6");
  }


  private async handleHistoryCommand(senderId: string, arg: string): Promise<void> {
    const session = this.executionSession(senderId);
    if (!session?.threadId) {
      await this.reply(senderId, copyableChoices("当前会话还没有 Codex 历史。先发送一条消息，或选择已有会话。", [{ label: "查看已有会话", value: "/sessions" }]));
      return;
    }
    const more = arg.trim().toLowerCase() === "more";
    const requested = more || !arg.trim() ? 8 : Number(arg.trim());
    if (!Number.isInteger(requested) || requested < 1 || requested > 20) {
      await this.reply(senderId, copyableChoices("历史条数支持 1–20；请选择可直接发送的查询命令。", [{ label: "最近 10 条", value: "/history 10" }, { label: "更早的对话", value: "/history more" }]));
      return;
    }
    const hostId = this.sessionHostId(session) ?? "local";
    const token = Symbol("history");
    this.historyRequests.set(senderId, token);
    const assertCurrent = this.controlGuard(senderId, session, "viewer");
    const current = () => {
      if (this.historyRequests.get(senderId) !== token) return false;
      try { assertCurrent(); return true; } catch { return false; }
    };
    let page = this.historyPages.get(senderId);
    if (!more || !page || page.threadId !== session.threadId || page.hostId !== hostId) {
      page = { threadId: session.threadId, hostId, exhausted: false, pending: [] };
    } else page = structuredClone(page);
    for (let reads = 0; page.pending.length < requested && !page.exhausted && reads < 10; reads++) {
      if (typeof this.runner.getHistoryPage === "function") {
        try {
          const response = await this.runner.getHistoryPage(session.threadId, {
            cursor: page.cursor, limit: 10, sortDirection: "desc"
          }, hostId);
          if (!current()) return;
          page.pending.push(...visibleConversationHistory(response.messages).reverse());
          page.exhausted = !response.nextCursor || response.nextCursor === page.cursor;
          page.cursor = response.nextCursor;
          continue;
        } catch (error) {
          if (!/unsupported|method not found|unknown method|not implemented/i.test(String(error))) throw error;
        }
      }
      const messages = await this.runner.getHistory(session.threadId, hostId);
      if (!current()) return;
      page.pending.push(...visibleConversationHistory(messages).reverse());
      page.exhausted = true;
    }
    if (!current()) return;
    const visible = page.pending.splice(0, requested).reverse();
    this.historyPages.set(senderId, page);
    await this.reply(senderId, visible.length
      ? [`会话“${session.title}”${more ? "更早的" : "最近"} ${visible.length} 条对话：`,
          formatConversationHistory(visible),
          !page.exhausted || page.pending.length ? `查看更早的对话：\n\n${copyBlock("/history more")}` : "已到达最早的对话。"].join("\n\n")
      : "没有更早的可显示对话。");
  }

  private async handleSteerCommand(message: ChannelMessage, arg: string, expectedTurnId?: string): Promise<void> {
    const prompt = arg.trim();
    if (!prompt) {
      await this.reply(message.senderId, "用法：/steer <要补充或纠正的要求>");
      return;
    }
    const session = this.executionSession(message.senderId);
    if (!session?.threadId) {
      await this.reply(message.senderId, "当前会话还没有正在运行的 Codex 任务，直接发送消息即可开始。");
      return;
    }
    const hostId = this.sessionHostId(session);
    const binding = sessionExecutionScope(this.options.stateStore, session, message.senderId);
    const actorId = this.actor.getStore() ?? message.senderId;
    const assertCurrent = () => {
      this.options.assertRuntimeWritable?.();
      if (this.audienceSuspended || !binding.current() || !this.access.requireAccess(actorId, message.senderId).allowed
        || !roleAllows(this.role(message.senderId, actorId), "participant")) throw new CodexInterventionError("会话或准入已改变，介入消息未提交。");
    };
    if (this.runner.backendInfo?.(hostId).capabilities.turnSteering === false) {
      await this.reply(message.senderId, "当前后端不支持介入正在执行的轮次，消息未提交。原生队列也需要后端支持；可在 Codex 中操作。");
      return;
    }
    let state: Awaited<ReturnType<NonNullable<CodexBridgeBackend["inspectThread"]>>>;
    try { state = await this.runner.inspectThread(session.threadId, hostId); }
    catch (error) { throw communicationError(error, { phase: "preflight", operation: "thread/read", threadId: session.threadId }); }
    if (state.executionOwner === "desktop") {
      await this.reply(message.senderId, "当前 Desktop 转发协议不支持指定轮次的安全介入，消息未提交。请在 Codex App 中介入或排队，或改用共享 App Server 会话。");
      return;
    }
    if (state.persistence !== "active" || state.runtimeStatus === "systemError") {
      const reason = unavailableProjectSessionChoiceReason({
        managed: session,
        title: session.title,
        updatedAt: session.updatedAt,
        candidate: codexThreadStateCandidate(state, session.workspace)
      });
      await this.reply(message.senderId, reason ?? "当前 Codex 会话不可介入，请重新选择会话。");
      return;
    }
    if (state.runtimeStatus !== "active" || !state.activeTurnId) {
      await this.replyActionCard(message.senderId, createChoiceCard({
        title: "当前没有运行中的任务",
        body: "这条补充无法介入已经结束的任务，可以作为下一轮消息发送。",
        fallbackText: `当前任务已经结束。可发送：/queue ${prompt}`,
        choices: [{ label: "作为下一轮发送", command: "queue", arg: prompt, style: "primary" }]
      }));
      return;
    }
    if (expectedTurnId && state.activeTurnId !== expectedTurnId) {
      await this.reply(message.senderId, copyableChoices("目标任务已结束或发生切换，未发送这条介入。核对历史后再发送新的要求。", [{ label: "核对当前会话历史", value: "/history" }]));
      return;
    }
    this.options.inputReceipts?.submitting({ sessionId: session.id, hostId: hostId ?? "local", threadId: session.threadId });
    const result = await this.observeControlAudience(session, state.activeTurnId, () => this.controls.steer(
      JSON.stringify([hostId ?? "local", session.threadId]),
      JSON.stringify([session.id, message.senderId, this.actor.getStore(), message.id]),
      () => this.runner.steer({
      threadId: session.threadId!,
      expectedTurnId: state.activeTurnId,
      prompt,
      cwd: session.workspace,
      clientUserMessageId: message.id,
      assertCurrent
    }, hostId), hostId ?? "local", this.participantOrigin(session)));
    this.options.stateStore.setSessionPromptPreview(session.id, prompt);
    await this.reply(message.senderId, [
      "已介入当前正在执行的 Codex 任务。",
      `Turn：${result.turnId}`,
      `补充要求：${boundedProgressText(prompt, 800)}`
    ].join("\n"));
  }

  private async handleInterventionSetting(senderId: string, command: ChannelCommand, sourceText = ""): Promise<void> {
    const arg = command.arg.trim();
    if (command.name === "unbind" || command.name === "leave") {
      if (arg) { await this.reply(senderId, "用法：/unbind（兼容 /leave）；仅解绑当前 IM 对话。"); return; }
      const session = this.executionSession(senderId);
      if (session) this.options.stateStore.unbindSession(session.id, this.options.stateStore.sessionBindingTarget(session));
      else this.options.stateStore.leaveSession(senderId);
      this.clearConversationBindingState(senderId);
      await this.reply(senderId, copyableChoices("当前 IM 对话已解绑，停止本对话跟随；不会删除 session、停止原任务或取消原生队列，其他对话绑定不变。解绑状态会在重启后保留。", [{ label: "选择已有会话", value: "/sessions" }, { label: "新建会话", value: "/new" }]));
      return;
    }
    if (command.name === "role") {
      if (!arg) {
        await this.reply(senderId, [
          "你的权限：" + this.role(senderId),
          "viewer：查看；participant：续聊与介入；controller：另可停止、审批和管理权限。",
          "设置：/role <用户ID|*> <viewer|participant|controller>（* 表示群默认权限）"
        ].join("\n\n"));
        return;
      }
      const [target, role, extra] = arg.split(/\s+/);
      if (!target || extra || !["viewer", "participant", "controller"].includes(role)) {
        await this.reply(senderId, "用法：/role <用户ID|*> <viewer|participant|controller>");
        return;
      }
      this.options.stateStore.setRole(senderId, target, role as SessionRole);
      await this.reply(senderId, "已设置 " + target + " 的权限为 " + role + "。");
      return;
    }
    const session = this.executionSession(senderId);
    if (!session) { await this.reply(senderId, copyableChoices("请先选择会话。", [{ label: "查看可绑定会话", value: "/sessions" }])); return; }
    if (command.name === "follow") {
      if (arg === "primary") {
        if (!await this.requireRole(senderId, "controller")) return;
        if (!this.options.sessionInteractions) { await this.reply(senderId, "当前部署未接入交互路由；未修改绑定。"); return; }
        const route = this.options.sessionInteractions.setPrimary(session);
        await this.reply(senderId, `${formatInteractionRoute(route)}\n\n已保存，Gateway 重启后保留。仅更改新轮次的默认提问/审批目标；原交互仍归原轮次所有，其他跟随绑定未变。`);
        return;
      }
      const retryDelivery = arg === "sync --retry-delivery";
      const action = retryDelivery ? "sync" : arg;
      if (retryDelivery && !/^\/follow\s+sync\s+--retry-delivery\s*$/i.test(sourceText.trim())) {
        await this.reply(senderId, copyableChoices("未知投递可能重复通知，未尝试投递。仅在明确接受重复通知风险时，发送以下完整命令。", [{ label: "明确重试原实例的未知投递（可能重复通知）", value: "/follow sync --retry-delivery" }]));
        return;
      }
      if (action && !["on", "off", "sync"].includes(action)) {
        await this.reply(senderId, copyableChoices("请选择跟随操作。primary 需要控制者权限，会将当前对话设为主交互目标；普通同步不创建新任务。", [{ label: "查看同步状态", value: "/follow" }, { label: "开启并同步", value: "/follow on" }, { label: "关闭跟随", value: "/follow off" }, { label: "立即同步", value: "/follow sync" }, { label: "将本对话设为主交互目标", value: "/follow primary" }]));
        return;
      }
      if (retryDelivery && !await this.requireRole(senderId, "controller")) return;
      if (action === "on" || action === "sync") this.assertSessionCapability(senderId, "liveFollow");
      if (action === "on" || action === "off") this.options.stateStore.setSessionFollow(session.id, action === "on");
      const current = this.options.stateStore.getSession(session.id)!;
      const enabled = current.follow !== false;
      if (action === "sync" && !enabled) {
        await this.reply(senderId, copyableChoices("实时跟随已关闭，未执行同步。开启后才会同步；不会改变绑定。", [{ label: "开启实时跟随并同步", value: "/follow on" }]));
        return;
      }
      const supported = this.runner.backendInfo?.(this.sessionHostId(current)).capabilities.liveFollow !== false;
      const status = (action === "on" || action === "sync") && current.threadId && this.options.sessionFollow
        ? await this.options.sessionFollow.synchronize(current, retryDelivery ? { confirmUncertainDelivery: true } : undefined)
        : this.options.sessionFollow?.status(current);
      await this.reply(senderId, [
        `实时跟随：${enabled ? "已开启" : "已关闭"}${supported ? "" : "（当前后端不支持）"}。`,
        ...(this.options.sessionInteractions ? [formatInteractionRoute(this.options.sessionInteractions.status(current))] : []),
        ...(!current.threadId ? ["当前绑定尚未创建 Codex thread，暂时没有可同步的任务。"]
          : supported && status ? formatFollowStatus(status) : supported ? ["同步状态：当前部署未接入跟随协调器，未确认同步成功。"] : []),
        ...(action === "on" || action === "sync" ? ["未创建新任务、未介入或停止原任务。"] : [copyableChoices("可选择同步或开启过程进度。", [
          { label: "同步当前状态", value: "/follow sync" }, { label: "开启过程进度", value: "/stream on" }
        ])])
      ].join("\n\n"));
      return;
    }
    if (arg && !["ask", "steer", "queue"].includes(arg)) {
      await this.reply(senderId, copyableChoices("请选择运行中消息的处理方式；查看状态不会改变设置。", [
        { label: "查看当前策略", value: "/policy" }, { label: "插入当前轮次", value: "/policy steer" },
        { label: "排到下一轮", value: "/policy queue" }, { label: "每次询问", value: "/policy ask" }
      ]));
      return;
    }
    const assertPolicyCurrent = this.conversationControlGuard(senderId, requiredCommandRole("policy", arg));
    if (arg === "steer") {
      const hostId = this.sessionHostId(session);
      const desktopOwned = session.threadId && typeof this.runner.inspectThread === "function"
        && (await this.runner.inspectThread(session.threadId, hostId)).executionOwner === "desktop";
      if ((desktopOwned && !this.runner.submitThreadMessage) || this.runner.backendInfo?.(hostId).capabilities.turnSteering === false) {
        await this.reply(senderId, "当前后端不支持安全介入，处理策略未改变。请在实际持有会话的 Codex 中操作，或等当前任务完成后发送。");
        return;
      }
    }
    if (arg === "queue") {
      const hostId = this.sessionHostId(session);
      if (this.runner.backendInfo?.(hostId).capabilities.nativeQueue === false
        || typeof this.runner.addQueuedSubmission !== "function") {
        await this.reply(senderId, "当前后端不支持可靠的原生队列，处理策略未改变。请在实际持有会话的 Codex 中排队。");
        return;
      }
    }
    if (arg) {
      assertPolicyCurrent();
      this.options.stateStore.setActiveMessagePolicy(session.id, arg as "ask" | "steer" | "queue");
    }
    await this.reply(senderId, "运行中消息处理方式：" + (arg || session.activeMessagePolicy || this.options.config.activeMessagePolicy || "steer") + "（ask 询问，steer 介入，queue 原生排队）。");
  }

  private async handleActiveMessage(message: ChannelMessage, items: PromptBufferItem[]): Promise<boolean> {
    const session = this.executionSession(message.senderId);
    if (!session?.threadId || session.mode === "qa") return false;
    if (typeof this.runner.inspectThread !== "function") return false;
    const hostId = this.sessionHostId(session);
    let state: Awaited<ReturnType<NonNullable<CodexBridgeBackend["inspectThread"]>>>;
    try { state = await this.runner.inspectThread(session.threadId, hostId); }
    catch (error) { throw communicationError(error, { phase: "preflight", operation: "thread/read", threadId: session.threadId }); }
    if (state.threadId !== session.threadId || state.persistence !== "active" || state.internal) {
      await this.reply(message.senderId, copyableChoices("绑定的会话当前不可接收消息，未提交；绑定未删除。", [{ label: "核对当前状态", value: "/status" }]));
      return true;
    }
    if (await this.recoverCapacityPreflight(message.senderId, session, state)) return true;
    state = await this.recoverSystemPreflight(message.senderId, session, state);
    assertCodexThreadRunnable(state);
    if (state.pendingTurnWithoutId && state.runtimeStatus !== "active") {
      await this.reply(message.senderId, copyableChoices("Codex App 存在未确认轮次，实际任务已空闲，消息未提交。请重新加载 App 后核对状态。", [{ label: "核对状态", value: "/status" }]));
      return true;
    }
    if (state.runtimeStatus !== "active") {
      if (this.runningSessions.has(session.id)) {
        await this.reply(message.senderId, "上一条消息正在提交，尚未确认活动轮次；这条消息未提交。请稍后发送，或显式 /queue 排到下一轮。");
        return true;
      }
      return false;
    }
    const canSteer = Boolean(state.activeTurnId)
      && state.executionOwner !== "desktop" && this.runner.backendInfo?.(hostId).capabilities.turnSteering !== false;
    const canQueue = this.runner.backendInfo?.(hostId).capabilities.nativeQueue !== false
      && typeof this.runner.addQueuedSubmission === "function";
    const policy = session.activeMessagePolicy ?? this.options.config.activeMessagePolicy ?? "steer";
    if (policy === "queue") {
      await this.enqueueNativeMessage(message, "", items);
      return true;
    }
    const prompt = buildPromptParts("", await this.stagePromptItems(items, session, message), channelPromptSource(this.channel.channel), []).prompt;
    if (policy === "steer") {
      if (state.executionOwner === "desktop" && this.runner.submitThreadMessage) {
        await this.submitActiveThreadMessage(message, session, prompt, state.activeTurnId);
        return true;
      }
      await this.handleSteerCommand(message, prompt, state.activeTurnId);
      return true;
    }
    if (!canSteer && !canQueue) {
      await this.reply(message.senderId, "当前后端不支持安全介入或可靠的原生队列，这条消息未提交。请在实际持有会话的 Codex 中操作，或等当前任务完成后发送。");
      return true;
    }
    const choice = this.controls.createChoice({
      actorId: this.actor.getStore() ?? message.senderId, conversationId: message.senderId,
      sessionId: session.id, threadId: session.threadId, hostId: hostId ?? "local",
      turnId: state.activeTurnId ?? "", prompt, items
    });
    await this.replyActionCard(message.senderId, createChoiceCard({
      title: "当前任务正在执行",
      body: "如何处理这条新消息？\n\n" + boundedProgressText(buildPromptPreview("", items) ?? "", 500),
      choices: [
        ...(canSteer ? [{ label: "介入当前任务", command: "intervene" as const, arg: choice.id + " steer", style: "primary" as const }] : []),
        ...(canQueue ? [{ label: "排到下一轮", command: "intervene" as const, arg: choice.id + " queue" }] : []),
        { label: "取消", command: "intervene", arg: choice.id + " cancel" }
      ],
      fallbackText: "发送 /intervene " + choice.id + " " + [
        ...(canSteer ? ["steer 介入"] : []), ...(canQueue ? ["queue 原生排队"] : []), "cancel 取消"
      ].join("，") + "。"
    }));
    return true;
  }

  private async recoverCapacityPreflight(senderId: string, session: ManagedSession, state: import("../codex/backend.js").CodexThreadState): Promise<boolean> {
    if (!session.threadId) return false;
    const hostId = this.sessionHostId(session) ?? "local", threadId = session.threadId;
    const scope = capacityFailureScope(state, threadId, hostId);
    if (!scope || !this.options.requestCapacityRecovery) return false;
    const assertCurrent = () => {
      const current = this.executionSession(senderId);
      if (current?.id !== session.id || current.threadId !== threadId || (this.sessionHostId(current) ?? "local") !== hostId) {
        throw Error("Capacity recovery binding changed");
      }
    };
    if (!await this.options.requestCapacityRecovery(scope, assertCurrent)) return false;
    await this.reply(senderId, "已接入容量恢复流程，正在核对并继续原轮次；这条新消息未提交。恢复进展会回到本对话，执行结果以原生回执为准。");
    return true;
  }

  private async submitActiveThreadMessage(message: ChannelMessage, session: ManagedSession, prompt: string, expectedTurnId?: string): Promise<void> {
    const hostId = this.sessionHostId(session);
    const actorId = this.actor.getStore() ?? message.senderId;
    const binding = sessionExecutionScope(this.options.stateStore, session, message.senderId);
    const assertCurrent = () => {
      this.options.assertRuntimeWritable?.();
      const current = this.executionSession(message.senderId);
      if (!binding.current() || current?.id !== session.id || current.threadId !== session.threadId
        || current.projectId !== session.projectId || current.projectBinding !== session.projectBinding || current.workspace !== session.workspace
        || (this.sessionHostId(current) ?? "local") !== (hostId ?? "local")) {
        throw new CodexInterventionError("绑定已切换，未向旧会话提交消息，请重新发送。");
      }
      if (this.audienceSuspended || !this.access.requireAccess(actorId, message.senderId).allowed
        || !roleAllows(this.role(message.senderId, actorId), "participant"))
        throw new CodexInterventionError("当前准入或角色权限已改变，消息未提交。");
    };
    assertCurrent();
    this.options.inputReceipts?.submitting({ sessionId: session.id, hostId: hostId ?? "local", threadId: session.threadId });
    const result = await this.observeControlAudience(session, expectedTurnId, () => this.controls.submit(
      JSON.stringify([hostId ?? "local", session.threadId]),
      JSON.stringify([session.id, message.senderId, this.actor.getStore(), message.id]),
      async () => {
        assertCurrent();
        const receipt = await this.runner.submitThreadMessage!({ threadId: session.threadId!, prompt, cwd: session.workspace,
          clientUserMessageId: message.id, assertCurrent }, hostId);
        if (receipt.status !== "accepted" || receipt.threadId !== session.threadId || !receipt.turnId) {
          throw new CodexCommunicationError("submission", "thread/message", session.threadId, undefined,
            { code: "InvalidAcknowledgement" });
        }
        return receipt;
      }, hostId ?? "local", this.participantOrigin(session)));
    this.options.stateStore.setSessionPromptPreview(session.id, prompt);
    await this.reply(message.senderId, `消息已由原 Codex 会话接收。\nTurn：${result.turnId}\n继续跟随原会话；未新建任务或自动排队。`);
  }

  private async handleInterventionChoice(message: ChannelMessage, arg: string): Promise<void> {
    const [id, action, extra] = arg.trim().split(/\s+/);
    if (!id || extra || !["steer", "queue", "cancel"].includes(action)) {
      await this.reply(message.senderId, "用法：/intervene <编号> <steer|queue|cancel>");
      return;
    }
    const choice = this.controls.claimChoice(id, this.actor.getStore() ?? message.senderId, message.senderId, action === "cancel");
    if (action === "cancel") { await this.reply(message.senderId, "已取消这条消息。"); return; }
    const session = this.executionSession(message.senderId);
    if (session?.id !== choice.sessionId || session.threadId !== choice.threadId
      || (this.sessionHostId(session) ?? "local") !== choice.hostId) {
      await this.reply(message.senderId, "绑定的会话已切换，未发送旧卡片中的消息。请重新发送。");
      return;
    }
    if (action === "steer") await this.handleSteerCommand({ ...message, id: choice.id }, choice.prompt, choice.turnId);
    else await this.enqueueNativeMessage({ ...message, id: choice.id }, "", choice.items);
  }

  private async handleQueueCommand(message: ChannelMessage, arg: string): Promise<void> {
    const value = arg.trim();
    if (!value || value === "list") {
      let warning: string | undefined;
      const checked = await observeStatus(() => this.nativeQueue.reconcile(this.options.accountId ?? "standalone", this.runner, { conversationId: message.senderId }));
      if (!checked.available) warning = "后端未在查询预算内完成核对，以下为持久化回执，不代表已确认的当前状态。";
      const rows = this.nativeQueue.list(this.options.accountId ?? "standalone", message.senderId);
      const replies = rows.filter(r => r.status === "queued" && (r.actorId === (this.actor.getStore() ?? message.senderId) || this.role(message.senderId) === "controller"))
        .slice(-20).map(r => ({ label: `请求取消待执行消息 ${r.queuedSubmissionId ?? r.clientUserMessageId}`, value: `/queue cancel ${r.queuedSubmissionId ?? r.clientUserMessageId}` }));
      await this.reply(message.senderId, copyableChoices(rows.length ? ["本聊天的原生队列回执（任务内容与顺序由 Codex 保存）：",
        ...(warning ? [warning] : []),
        ...rows.slice(-20).map(r => `${r.queuedSubmissionId ?? r.clientUserMessageId} · ${r.status}${r.status === "completed" ? r.delivered ? " · 结果已处理" : " · 结果未确认投递" : ""}\nSession：${r.threadId}${r.reason ? "\n" + r.reason : ""}`),
        "下方只列出当前可请求取消的待执行项；是否取消以原生队列回执为准。发送新内容排队时，使用 /queue 加实际内容，不要发送占位符。"].join("\n\n")
        : "本聊天暂无原生队列回执。需要排队时，发送 /queue 加实际内容，不要发送占位符。", [{ label: "刷新队列回执", value: "/queue list" }, ...replies]));
      return;
    }
    if (/^cancel(?:\s|$)/.test(value)) {
      const [, id, extra] = value.split(/\s+/);
      if (!id || extra) { await this.reply(message.senderId, "用法：/queue cancel <队列ID>"); return; }
      const controller = this.role(message.senderId) === "controller";
      const assertCurrent = this.controlGuard(message.senderId, this.executionSession(message.senderId), controller ? "controller" : "participant");
      const cancelled = await this.nativeQueue.cancel(this.options.accountId ?? "standalone", message.senderId,
        this.actor.getStore() ?? message.senderId, id, this.runner, controller, assertCurrent);
      await this.reply(message.senderId, cancelled ? "已从 Codex 原生队列取消待执行消息。" : copyableChoices("队列项已不在待执行列表中，未停止任务、未重发消息。", [{ label: "核对队列回执", value: "/queue list" }]));
      return;
    }
    const items = await this.promptItemsFromMessageWithNotice({ ...message, text: "" });
    if (items) await this.enqueueNativeMessage(message, value, items);
  }

  private async enqueueNativeMessage(message: ChannelMessage, text: string, items: PromptBufferItem[]): Promise<void> {
    const actorId = this.actor.getStore() ?? message.senderId;
    const session = this.executionSession(message.senderId);
    if (!session?.threadId || session.mode === "qa") {
      await this.reply(message.senderId, "原生队列需要已绑定且已创建的普通 session；请先绑定会话。QA 和首次创建不支持原生排队。");
      return;
    }
    const binding = sessionExecutionScope(this.options.stateStore, session, message.senderId);
    const hostId = this.sessionHostId(session) ?? "local";
    const state = await this.recoverSystemPreflight(message.senderId, session,
      await this.runner.inspectThread(session.threadId, hostId));
    assertCodexThreadRunnable(state);
    if (state.pendingTurnWithoutId && state.runtimeStatus !== "active") {
      await this.reply(message.senderId, "会话存在未确认轮次，消息未入队；请先重新加载 Codex App 并核对状态。"); return;
    }
    const preview = buildPromptPreview(text, items) ?? text;
    const knowledge = this.options.stateStore.relevantKnowledge(preview, session.projectId);
    const { prompt } = buildPromptParts(text, await this.stagePromptItems(items, session, message), channelPromptSource(this.channel.channel), knowledge);
    this.options.inputReceipts?.submitting({ sessionId: session.id, hostId: this.sessionHostId(session) ?? "local", threadId: session.threadId });
    const assertCurrent = () => {
      this.options.assertRuntimeWritable?.();
      const current = this.executionSession(message.senderId);
      if (this.audienceSuspended || !binding.current() || current?.id !== session.id || current.threadId !== session.threadId || (this.sessionHostId(current) ?? "local") !== hostId)
        throw new CodexInterventionError("渠道或会话绑定已改变，排队消息未提交。");
      if (!this.access.requireAccess(actorId, message.senderId).allowed || !roleAllows(this.role(message.senderId, actorId), "participant"))
        throw new CodexInterventionError("当前准入或角色权限已改变，排队消息未提交。");
    };
    assertCurrent();
    const receipt = await this.nativeQueue.enqueue({
      accountId: this.options.accountId ?? "standalone", conversationId: message.senderId,
      actorId, messageId: message.id,
      sessionId: session.id, hostId, backend: this.runner.backendInfo(hostId).id, threadId: session.threadId,
      ...(this.participant.getStore()?.mention ? { mention: this.participant.getStore()!.mention } : {})
    }, prompt, this.runner, {
      assertCurrent,
      onApproval: request => this.approvals.request(message.senderId, request),
      onApprovalResult: (request, result) => this.approvals.reportResult(message.senderId, request, result),
      onUserInput: request => this.requestUserInput(message.senderId, request, hostId),
      onUserInputResult: (request, result) => this.reportUserInputResult(message.senderId, request, result, hostId)
    });
    this.options.stateStore.setSessionPromptPreview(session.id, preview);
    await this.reply(message.senderId, receipt.status === "queued" || receipt.status === "running"
      ? `已由 Codex 接收${receipt.status === "running" ? "，任务已开始" : "并加入原生队列"}。\n队列ID：${receipt.queuedSubmissionId}\nGateway 重启后只核对回执，不重发消息。任务继承该会话的原生执行设置。`
      : copyableChoices(`这条消息已有 ${receipt.status} 回执，未重复提交。`, [{ label: "核对队列回执", value: "/queue list" }]));
    void this.recoverNativeQueue().catch(() => {
      this.warnNativeQueueRecovery();
    });
  }

  /** Called by the shared account lifecycle, not by an IM-specific scheduler. */
  async recoverNativeQueue(): Promise<void> {
    if (this.recoveringQueue) return;
    this.options.assertRuntimeWritable?.();
    this.recoveringQueue = true;
    const accountId = this.options.accountId ?? "standalone";
    try {
      try {
        await this.nativeQueue.reconcile(accountId, this.runner);
      } catch {
        // An unavailable host/thread must not starve other reconciled receipts.
        this.warnNativeQueueRecovery();
      }
      await this.nativeQueue.dispatch(accountId, this.runner, async (receipt, starting, started, item) => {
        return this.restartWork.run(async () => {
        if (!this.access.requireAccess(receipt.actorId, receipt.conversationId).allowed) {
          throw new Error("Queued origin access was revoked; native item preserved");
        }
        const currentRole = this.options.stateStore.roleFor(receipt.conversationId, receipt.actorId)
          ?? (this.access.isAllowed(receipt.actorId) ? "controller" : this.options.stateStore.roleFor(receipt.conversationId, "*") ?? "participant");
        if (!roleAllows(currentRole, "participant")) {
          throw new Error("Queued origin role was revoked; native item preserved");
        }
        const session = this.options.stateStore.getSession(receipt.sessionId);
        if (!session || session.threadId !== receipt.threadId || (this.sessionHostId(session) ?? "local") !== receipt.hostId) {
          throw new Error("Queued session identity changed; native item was not started");
        }
        await this.actor.run(receipt.actorId, () => this.runCodexTurn({
          id: receipt.messageId, senderId: receipt.conversationId, text: "", attachments: [], raw: {}
        }, item?.input.map(x => x.type === "text" ? x.text ?? "" : "").join("\n") ?? "", [], { receipt, starting, started }));
        });
      });
    } finally { this.recoveringQueue = false; }
  }

  private warnNativeQueueRecovery(): void {
    const now = Date.now();
    if (now - this.lastQueueWarningAt < 60_000) return;
    this.lastQueueWarningAt = now;
    console.warn("[codex-im-gateway] native queue recovery deferred; receipts preserved, no input replayed", {
      accountId: this.options.accountId ?? "standalone", category: "native_queue_recovery"
    });
  }


  private async sessionPromptPreview(session: ManagedSession): Promise<string> {
    if (session.lastPromptPreview) return session.lastPromptPreview;
    if (!session.threadId) return "尚未开始对话";
    try {
      const history = await this.runner.getHistory(session.threadId, this.sessionHostId(session));
      const lastUserMessage = [...history].reverse().find((message) => message.role === "user");
      if (!lastUserMessage) return "暂无内容摘要";
      const parsed = parsePrompt(lastUserMessage.text);
      const preview = buildPromptPreview(parsed.text, parsed.attachments);
      if (!preview) return "暂无内容摘要";
      this.options.stateStore.setSessionPromptPreview(session.id, preview);
      return preview;
    } catch (error) {
      console.warn(`Unable to read Codex history for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      return "历史摘要暂不可用";
    }
  }

  private async handlePromptCommand(senderId: string, arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase();
    if (sub === "start" || sub === "s") {
      const result = this.buffers.start(senderId);
      await this.reply(senderId, result.status === "started" ? "Prompt buffer started." : "Prompt buffer is already active.");
      return;
    }
    if (sub === "done" || sub === "d") {
      const flushed = this.buffers.done(senderId);
      if (flushed.status === "empty") {
        await this.reply(senderId, "Prompt buffer is empty.");
        return;
      }
      await this.runCodexTurn({ id: "buffer", senderId, text: "", attachments: [], raw: {} }, "", flushed.items);
      return;
    }
    await this.replyActionCard(senderId, createChoiceCard({
      title: "消息合并",
      body: this.buffers.isActive(senderId)
        ? "消息合并已开启。可以继续发送内容，完成后点击提交。"
        : "开启后，可以连续发送多条文字或附件，再一次性提交给 Codex。",
      fallbackText: "Usage: /prompt start or /prompt done",
      choices: this.buffers.isActive(senderId)
        ? [{ label: "提交合并消息", command: "prompt", arg: "done", style: "primary" }]
        : [{ label: "开始合并消息", command: "prompt", arg: "start", style: "primary" }]
    }));
  }

  private async handleModelCommand(senderId: string, arg: string): Promise<void> {
    if (this.cardInteraction.getStore() && /^\d+$/.test(arg.trim())) {
      await this.reply(senderId, "这张旧模型卡片只保留了序号，请发送 /model 刷新后重新选择。");
      return;
    }
    const assertCurrent = this.conversationControlGuard(senderId, requiredCommandRole("model", arg));
    const models = await this.listCodexModels();
    const explicitId = arg.trim().startsWith("--id ");
    const input = explicitId ? arg.trim().slice(5).trim() : arg.trim();
    if (!input) {
      const runtime = await this.effectiveRuntime(senderId);
      const session = this.executionSession(senderId);
      const lines = [
        `当前模型：${runtime.model ?? "Codex 默认"}${session?.model ? "（本会话）" : "（继承 Web/Codex 设置）"}`
      ];
      if (models.length) {
        lines.push("", "可用模型：", ...models.map((model, index) => `${index + 1}. ${model.displayName}（${model.model}）`));
        lines.push("", "发送 /model <序号或模型 ID> 切换；/model default 恢复继承设置。");
      } else {
        lines.push("", "暂时无法读取模型列表。仍可发送 /model <完整模型 ID> 切换。", "/model default 恢复继承设置。");
      }
      await this.replyActionCard(senderId, createCommandSelectionCard({
        title: "选择模型",
        body: models.length
          ? models.map((model) => `${model.model === runtime.model ? `**当前 · ${model.displayName}**` : `**${model.displayName}**`}\n${model.model}`).join("\n\n")
          : `当前模型：${runtime.model ?? "Codex 默认"}\n\n模型列表暂时不可用。`,
        command: "model",
        choices: models.map((model) => ({
          label: conciseButtonLabel(model.displayName),
          arg: /^(?:\d+|default)$/i.test(model.model) ? `--id ${model.model}` : model.model,
          active: model.model === runtime.model
        })),
        includeDefault: true,
        fallbackText: lines.join("\n")
      }));
      return;
    }
    if (!explicitId && input.toLowerCase() === "default") {
      assertCurrent();
      this.updateExecutionRuntime(senderId, { model: null });
      const runtime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 模型设置。\n当前模型：${runtime.model ?? "Codex 默认"}`);
      return;
    }

    const selected = explicitId ? models.find(model => model.model === input) : selectModel(models, input);
    if (!selected && (models.length || !isPlausibleModelId(input))) {
      const fallbackText = "模型不存在。发送 /model 查看可用模型，或使用 /model default 恢复继承设置。";
      await this.replyActionCard(senderId, createChoiceCard({
        title: "模型不存在",
        body: `没有找到“${input}”，请重新选择模型。`,
        fallbackText,
        choices: [{ label: "重新选择模型", command: "model", arg: "", style: "primary" }]
      }));
      return;
    }
    const currentRuntime = await this.effectiveRuntime(senderId);
    assertCurrent();
    const model = selected?.model ?? input;
    this.updateExecutionRuntime(senderId, { model });
    let adjustedEffort: string | undefined;
    if (currentRuntime.effort && selected?.supportedEfforts.length && !selected.supportedEfforts.some((option) => option.effort === currentRuntime.effort)) {
      adjustedEffort = selected.supportedEfforts.some((option) => option.effort === selected.defaultEffort)
        ? selected.defaultEffort
        : selected.supportedEfforts[0]?.effort;
      this.updateExecutionRuntime(senderId, { effort: adjustedEffort });
    }
    await this.reply(senderId, [
      `本会话模型已切换为：${selected?.displayName ?? model}（${model}）`,
      ...(adjustedEffort ? [`原来的推理强度不受该模型支持，已自动调整为：${formatEffort(adjustedEffort)}`] : []),
      "下一条消息开始生效。"
    ].join("\n"));
  }

  private async handleEffortCommand(senderId: string, arg: string): Promise<void> {
    if (this.cardInteraction.getStore() && /^\d+$/.test(arg.trim())) {
      await this.reply(senderId, "这张旧推理强度卡片只保留了序号，请发送 /effort 刷新后重新选择。");
      return;
    }
    const assertCurrent = this.conversationControlGuard(senderId, requiredCommandRole("effort", arg));
    const models = await this.listCodexModels();
    const runtime = await this.effectiveRuntime(senderId);
    const model = models.find((option) => option.model === runtime.model);
    const efforts = availableEfforts(model, models);
    const input = arg.trim();
    if (!input) {
      const session = this.executionSession(senderId);
      const fallbackText = [
        `当前推理强度：${formatEffort(runtime.effort)}${session?.effort ? "（本会话）" : "（继承 Web/Codex 设置）"}`,
        `当前模型：${runtime.model ?? "Codex 默认"}`,
        "",
        "可用推理强度：",
        ...efforts.map((effort, index) => `${index + 1}. ${formatEffort(effort)}`),
        "",
        "发送 /effort <序号或英文值> 切换；/effort default 恢复继承设置。"
      ].join("\n");
      await this.replyActionCard(senderId, createCommandSelectionCard({
        title: "选择推理强度",
        body: `当前模型：${runtime.model ?? "Codex 默认"}\n\n${efforts.map((effort) => effort === runtime.effort
          ? `**当前 · ${formatEffort(effort)}**`
          : formatEffort(effort)
        ).join("\n")}`,
        command: "effort",
        choices: efforts.map((effort) => ({
          label: conciseButtonLabel(formatEffort(effort)),
          arg: effort,
          active: effort === runtime.effort
        })),
        includeDefault: true,
        fallbackText
      }));
      return;
    }
    if (input.toLowerCase() === "default") {
      assertCurrent();
      this.updateExecutionRuntime(senderId, { effort: null });
      const nextRuntime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 推理强度设置。\n当前推理强度：${formatEffort(nextRuntime.effort)}`);
      return;
    }
    const effort = selectEffort(efforts, input);
    if (!effort) {
      const fallbackText = "该模型不支持这个推理强度。发送 /effort 查看可用选项。";
      await this.replyActionCard(senderId, createChoiceCard({
        title: "推理强度不可用",
        body: "当前模型不支持这个推理强度，请重新选择。",
        fallbackText,
        choices: [{ label: "重新选择", command: "effort", arg: "", style: "primary" }]
      }));
      return;
    }
    assertCurrent();
    this.updateExecutionRuntime(senderId, { effort });
    await this.reply(senderId, `本会话推理强度已切换为：${formatEffort(effort)}\n下一条消息开始生效。`);
  }

  private async handleStreamCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim().toLowerCase();
    if (input === "on") this.assertSessionCapability(senderId, "progress");
    const session = this.executionSession(senderId);
    const inherited = this.options.config.streamReplies;
    if (!input) {
      const effective = session?.streamReplies ?? inherited;
      const source = typeof session?.streamReplies === "boolean" ? "本会话设置" : "继承全局";
      const fallbackText = `当前过程进度：${effective ? "开启" : "关闭"}（${source}）\n发送 /stream on、/stream off 或 /stream default 切换。`;
      await this.replyActionCard(senderId, createCommandSelectionCard({
        title: "过程进度",
        body: `当前状态：**${effective ? "开启" : "关闭"}**（${source}）`,
        command: "stream",
        choices: [
          { label: "开启", arg: "on", active: effective },
          { label: "关闭", arg: "off", active: !effective }
        ],
        includeDefault: true,
        fallbackText
      }));
      return;
    }
    if (input === "default") {
      this.updateExecutionRuntime(senderId, { streamReplies: null });
      await this.reply(senderId, `已恢复继承全局设置。当前过程进度：${inherited ? "开启" : "关闭"}。`);
      return;
    }
    if (input !== "on" && input !== "off") {
      const fallbackText = "用法：/stream on、/stream off 或 /stream default";
      await this.replyActionCard(senderId, createCommandSelectionCard({
        title: "过程进度",
        body: "请选择本会话是否显示执行过程。",
        command: "stream",
        choices: [{ label: "开启", arg: "on" }, { label: "关闭", arg: "off" }],
        includeDefault: true,
        fallbackText
      }));
      return;
    }
    const enabled = input === "on";
    this.updateExecutionRuntime(senderId, { streamReplies: enabled });
    await this.reply(senderId, `本会话过程进度已${enabled ? "开启" : "关闭"}。`);
  }

  private async handleMemoryCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim();
    const normalized = input.toLowerCase();
    if (["on", "1", "off", "0"].includes(normalized)) {
      const enabled = normalized === "on" || normalized === "1";
      this.options.stateStore.setKnowledgeEnabled(enabled);
      await this.reply(senderId, `个人知识库自动沉淀已${enabled ? "开启" : "关闭"}。`);
      return;
    }
    if (normalized === "clear confirm" || normalized === "c confirm") {
      this.options.stateStore.clearKnowledge();
      await this.reply(senderId, "已清空此微信账号的个人知识库。");
      return;
    }
    if (normalized === "clear" || normalized === "c") {
      const fallbackText = "这会清空此微信账号的全部个人知识。确认请发送 /memory clear confirm";
      await this.replyActionCard(senderId, createChoiceCard({
        title: "确认清空个人知识库",
        template: "red",
        body: "此操作会删除当前账号沉淀的全部偏好、技巧、知识点和流程。",
        fallbackText,
        choices: [
          {
            label: "确认清空",
            command: "memory",
            arg: "clear confirm",
            style: "danger",
            confirm: "确认清空全部个人知识？"
          },
          { label: "返回知识库", command: "memory", arg: "" }
        ]
      }));
      return;
    }
    const entries = this.options.stateStore.listKnowledge();
    const forgetMatch = /^(?:forget|f)\s+(\S+)$/i.exec(input);
    if (forgetMatch) {
      const entry = entries.find(candidate => candidate.id === forgetMatch[1]);
      if (!entry) {
        await this.replyActionCard(senderId, createChoiceCard({
          title: "知识条目不存在",
          body: "该条目可能已经被删除，或使用了会随排序变化的旧编号，请刷新知识库后选择删除。",
          fallbackText: "未删除任何内容。请发送 /memory 刷新后使用该条目的删除操作。",
          choices: [{ label: "刷新知识库", command: "memory", arg: "", style: "primary" }]
        }));
        return;
      }
      this.options.stateStore.deleteKnowledge(entry.id);
      await this.reply(senderId, `已删除：${entry.title}`);
      return;
    }
    if (input) {
      await this.replyActionCard(senderId, createChoiceCard({
        title: "个人知识库",
        body: "请选择要进行的知识库操作。",
        fallbackText: "用法：/memory、/memory on、/memory off、/memory forget 条目ID、/memory clear",
        choices: [{ label: "查看知识库", command: "memory", arg: "", style: "primary" }]
      }));
      return;
    }
    const knowledgeEnabled = this.options.stateStore.isKnowledgeEnabled();
    const status = knowledgeEnabled ? "开启" : "关闭";
    if (!entries.length) {
      const fallbackText = `个人知识库（自动沉淀：${status}）\n暂无内容。后续对话会自动提炼可复用的偏好、技巧、知识点和流程。`;
      await this.replyActionCard(senderId, createChoiceCard({
        title: "个人知识库",
        body: `自动沉淀：**${status}**\n\n暂无内容。后续对话会自动提炼可复用信息。`,
        fallbackText,
        choices: [{
          label: knowledgeEnabled ? "关闭自动沉淀" : "开启自动沉淀",
          command: "memory",
          arg: knowledgeEnabled ? "off" : "on",
          style: "primary"
        }]
      }));
      return;
    }
    const projectNames = new Map(this.options.stateStore.listProjects().map((project) => [project.id, project.name]));
    const visibleEntries = entries.slice(0, 20);
    const fallbackText = [
      `个人知识库（自动沉淀：${status}，共 ${entries.length} 条）`,
      ...visibleEntries.map((entry, index) =>
        `[K${index + 1}] ${formatKnowledgeKind(entry.kind)} · ${entry.scope === "project" ? `项目：${projectNames.get(entry.projectId ?? "") ?? "已移除项目"}` : "账号"}\n标题：${entry.title}\n内容：${entry.content}`
      ),
      "删除单条：使用下方对应的删除操作，操作固定指向该条目。"
    ].join("\n\n");
    const choices: ChannelChoice[] = [{
      label: knowledgeEnabled ? "关闭自动沉淀" : "开启自动沉淀",
      command: "memory",
      arg: knowledgeEnabled ? "off" : "on",
      style: "primary"
    }];
    choices.push(...visibleEntries.map((entry, index): ChannelChoice => ({
      label: conciseButtonLabel(`删除 K${index + 1} · ${entry.title}`),
      command: "memory",
      arg: `forget ${entry.id}`,
      style: "danger",
      confirm: `确认删除“${entry.title}”？`
    })));
    choices.push({
      label: "清空全部",
      command: "memory",
      arg: "clear",
      style: "danger"
    });
    await this.replyActionCard(senderId, createChoiceCard({
      title: "个人知识库",
      body: `自动沉淀：**${status}** · 共 ${entries.length} 条\n\n${visibleEntries.map((entry, index) =>
        `**K${index + 1} · ${entry.title}**\n\n${entry.content}`
      ).join("\n\n")}`,
      fallbackText,
      choices
    }));
  }

  private async promptItemsFromMessage(message: ChannelMessage): Promise<PromptBufferItem[]> {
    const items: PromptBufferItem[] = [];
    if (message.text.trim()) {
      items.push({ kind: "text", text: message.text });
    }
    const context = referenceContext(message);
    if (context) items.push({ kind: "text", text: context });
    const attachments = [...(message.attachments ?? []), ...(message.references ?? []).flatMap(ref => ref.attachments)];
    if (!attachments.length) {
      this.options.inboundReferences?.remember(message, []);
      return items;
    }
    try {
      const rootDir = this.options.inboundDir ?? path.join(this.options.config.defaultCwd, ".codex-im-gateway-inbound");
      const downloaded = validateLocalAttachments(await this.channel.resolveAttachments(message), rootDir, this.options.config.maxInboundBytes);
      this.options.inboundReferences?.remember(message, downloaded);
      for (const attachment of downloaded) {
        items.push({
          kind: attachment.kind,
          path: attachment.path,
          label: attachment.label
        });
      }
    } catch (error) {
      if (error instanceof InboundMediaTooLargeError) throw error;
      console.error(
        `[codex-im-gateway] inbound attachment download failed for message ${message.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw new InboundAttachmentDownloadError();
    }
    return items;
  }

  private async stagePromptItems(items: PromptBufferItem[], session: ManagedSession, message: ChannelMessage): Promise<PromptBufferItem[]> {
    return stageTurnAttachments(this.runner, items, { accountId: this.options.accountId,
      conversationId: message.senderId, sessionId: session.id, hostId: this.sessionHostId(session), maxBytes: this.options.config.maxInboundBytes });
  }

  private async promptItemsFromMessageWithNotice(message: ChannelMessage): Promise<PromptBufferItem[] | undefined> {
    try {
      return await this.promptItemsFromMessage(message);
    } catch (error) {
      if (error instanceof InboundMediaTooLargeError) {
        const maxMiB = Math.floor(error.maxBytes / (1024 * 1024));
        await this.reply(message.senderId, `附件超过 ${maxMiB} MiB 上限，请压缩或裁剪后重新发送。`);
        return undefined;
      }
      if (error instanceof InboundAttachmentDownloadError) {
        await this.reply(message.senderId, "收到附件，但当前渠道下载或读取失败。请重新发送；如果仍失败，请检查该渠道的文件权限和连接状态。");
        return message.text.trim() ? [{ kind: "text", text: message.text },
          { kind: "text", text: "本轮附件下载失败，未取得附件正文。不要声称已读取文件或图片；请用户直接重发。" }] : undefined;
      }
      throw error;
    }
  }

  private async runCodexTurn(message: ChannelMessage, text: string, attachments: PromptBufferItem[] = [], queued?: {
    receipt: QueueReceipt; starting: () => void; started: (turnId: string) => void;
  }): Promise<void> {
    const currentSession = this.executionSession(message.senderId);
    if (!queued && !currentSession) {
      await this.replySessionRequired(message.senderId);
      return;
    }
    const pinned = queued ? this.options.stateStore.getSession(queued.receipt.sessionId) : undefined;
    const activeProject = queued ? this.options.stateStore.getProject(pinned?.projectId ?? "") : this.options.stateStore.getActiveProject(message.senderId);
    const activeSession = pinned ?? currentSession;
    const standalone = !activeProject && activeSession?.projectBinding === "none" ? activeSession : undefined;
    if (!activeProject && !standalone) throw new Error("请先发送 /sessions 选择会话，或 /project 选择项目。");
    // Turn execution must not wait for a fresh catalog request. Account start
    // and project/session selection already establish the execution context.
    const project = standalone ? undefined : activeProject;
    const mode = queued ? "session" : this.options.stateStore.getInteractionMode(message.senderId);
    const qaContext = mode === "qa" && project ? this.resolveQaContext(project) : undefined;
    if (mode === "qa" && !qaContext) throw new Error("Current project has no available llm-wiki knowledge base");
    const session = pinned ?? currentSession!;
    const origin = queued ? {
      bindingKey: JSON.stringify([queued.receipt.accountId, session.id]), conversationId: queued.receipt.conversationId,
      actorId: queued.receipt.actorId, ...(queued.receipt.mention ? { mention: queued.receipt.mention } : {})
    } : this.participantOrigin(session);
    const recordParticipant = (nativeThreadId: string, turnId: string) => {
      try {
        if (origin) this.turnAudience.record({ bindingKey: origin.bindingKey, conversationId: origin.conversationId,
          hostId: this.sessionHostId(session) ?? "local", threadId: nativeThreadId, turnId }, origin);
      } catch { console.warn("[codex-im-gateway] accepted turn audience journal unavailable"); }
    };
    return this.turnDeliveries.run(JSON.stringify([this.sessionHostId(session), session.id]), async () => {
    // The preceding queued turn may have created this session's first thread.
    const fresh = this.options.stateStore.listSessions().find((item) => item.id === session.id);
    if (!fresh) throw new Error("The queued session was removed");
    session.threadId = fresh.threadId;
    const promptPreview = buildPromptPreview(text, attachments);
    if (promptPreview) {
      this.options.stateStore.setSessionPromptPreview(session.id, promptPreview);
    }
    const workspace = session.workspace;
    const threadId = session.threadId || undefined;
    if (threadId && typeof this.runner.inspectThread === "function") {
      try {
        let state = await this.runner.inspectThread(threadId, this.sessionHostId(session));
        if (!queued && await this.recoverCapacityPreflight(message.senderId, session, state)) return;
        if (!queued) state = await this.recoverSystemPreflight(message.senderId, session, state);
        assertCodexThreadRunnable(state);
      }
      catch (error) { throw communicationError(error, { phase: "preflight", operation: "thread/read", threadId }); }
    }
    const progressEnabled = session.streamReplies ?? this.options.config.streamReplies;
    const preparedActorId = origin?.actorId ?? this.actor.getStore() ?? message.senderId;
    const binding = sessionExecutionScope(this.options.stateStore, session, message.senderId);
    const identityCurrent = binding.current;
    const stillBound = () => !this.audienceSuspended && this.executionSession(message.senderId)?.id === session.id && Boolean(identityCurrent());
    const saveNativeThread = (threadId: string) => {
      return binding.acceptThread(threadId);
    };
    const assertInputCurrent = () => {
      this.options.assertRuntimeWritable?.();
      if (!stillBound()) throw new CodexInterventionError("绑定已改变，消息未提交。");
      if (!this.access.requireAccess(preparedActorId, message.senderId).allowed
        || !roleAllows(this.role(message.senderId, preparedActorId), "participant"))
        throw new CodexInterventionError("当前准入或角色权限已改变，消息未提交。");
    };
    const wantsProgress = () => stillBound()
      && (this.options.stateStore.getSession(session.id)?.streamReplies ?? this.options.config.streamReplies);
    const sentProgress = new Set<string>();
    let replyStream: TurnReplyStream | undefined;
    const prepareReplyStream = async (acceptedTurnId?: string) => {
      if (!progressEnabled || replyStream || !stillBound()) return;
      replyStream = await this.options.createTextStream?.(session, acceptedTurnId) ?? new ChannelTurnPresentation(this.channel, message.senderId, {
        save: () => undefined, contextToken: this.options.stateStore.getContextToken(message.senderId),
        decorateProgress: text => {
          let url: string | undefined;
          try {
            const current = this.options.stateStore.getSession(session.id);
            if (current && stillBound()) url = this.options.ideProgressEntry?.(current);
          } catch { /* IDE metadata must not interrupt progress delivery. */ }
          return withIDEEntry(text, url, { atEnd: true });
        },
        onTextDelivered: (part) => this.options.onOutboundMessage?.({ direction: "outbound", id: part.messageId,
          recipientId: message.senderId, text: part.text, attachments: [] })
      });
      this.activePresentations.set(session.id, { hostId: this.sessionHostId(session) ?? "local", threadId: session.threadId, stream: replyStream });
    };
    if (!queued) await prepareReplyStream();
    let streamedAnswer = "";
    let acceptedQueueTurn = false;
    let backendEntered = false;
    const submission = new TurnSubmission(this.options.inputReceipts, session.id);
    let acceptedTurnId: string | undefined;
    let activeMarked = false;
    const markActive = () => {
      if (activeMarked) return;
      activeMarked = true;
      this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: true });
      this.runningSessions.add(session.id);
    };
    if (!queued) markActive();
    try {
      await this.withTyping(message.senderId, async () => {
        console.log(`[codex-im-gateway] starting Codex turn for ${message.senderId} in ${workspace}`);
        if (!queued && replyStream?.supported) await replyStream.progress("🤔 正在理解任务并规划下一步…");
        const knowledge = this.options.stateStore.relevantKnowledge(promptPreview ?? text, session.projectId);
        const prepared = await prepareTurnSubmission({ runner: this.runner, session, project, config: this.options.config,
          accountId: this.options.accountId, conversationId: message.senderId, text, items: attachments,
          source: channelPromptSource(this.channel.channel), knowledge });
        const acceptedWork = this.restartWork.capture();
        const runInput: CodexRunnerInput = {
          ...prepared,
          prompt: qaContext ? buildQaPrompt(prepared.prompt, project!, qaContext) : prepared.prompt,
          onRecovery: async recovery => {
            if (!stillBound() || recovery.threadId !== session.threadId || recovery.turnId !== acceptedTurnId) return;
            if (wantsProgress()) await replyStream?.waitForRecovery(codexRecoverySummary(recovery));
          },
          onThreadCreated: (createdThreadId) => {
            saveNativeThread(createdThreadId);
            return this.options.onSubscriptionsChanged?.();
          },
          onTurnStarted: async ({ threadId: startedThreadId, turnId, status }) => {
            acceptedTurnId = turnId;
            if (queued) { queued.started(turnId); acceptedQueueTurn = true; }
            saveNativeThread(startedThreadId);
            recordParticipant(startedThreadId, turnId);
            const running = status === undefined || status === "inProgress";
            if (queued && running) { await prepareReplyStream(turnId); markActive(); }
            const presentation = this.activePresentations.get(session.id);
            if (presentation) { presentation.threadId = startedThreadId; presentation.turnId = turnId; }
            await this.options.onTurnStarted?.(session, turnId, status);
            if (queued && running && wantsProgress() && replyStream?.supported) await replyStream.progress("🤔 原生队列任务已开始…");
            if (running) acceptedWork({ hostId: this.sessionHostId(session) ?? "local", threadId: startedThreadId, turnId });
          },
          ...(qaContext ? {
            dynamicTools: llmWikiDynamicTools(),
            onDynamicToolCall: (call: CodexDynamicToolCall) => this.handleKnowledgeToolCall(qaContext, call)
          } : {}),
          ...(progressEnabled ? {
            ...(replyStream?.supported || queued ? {
              onDelta: async (delta: string) => {
                if (!wantsProgress() || queued && !acceptedQueueTurn || !replyStream?.supported) return;
                streamedAnswer += delta;
                const visible = visibleStreamingAnswer(streamedAnswer);
                if (visible) await replyStream.answer(visible);
              }
            } : {}),
            onProgress: async (progress: string) => {
              if (!wantsProgress() || queued && !acceptedQueueTurn) return;
              const progressText = progress.trim();
              // Compaction can occur repeatedly in one long turn. Closing one
              // phase permits its next cycle without weakening replay dedup.
              if (progressText === "🧹 正在整理长会话上下文") sentProgress.delete("✅ 上下文整理完成");
              if (progressText === "✅ 上下文整理完成") sentProgress.delete("🧹 正在整理长会话上下文");
              if (!progressText || sentProgress.has(progressText) && !replyStream?.checkpoint().recoveryNotice) return;
              sentProgress.add(progressText);
              if (sentProgress.size > 200) sentProgress.clear();
              await replyStream?.progress(progressText);
            }
          } : {}),
          onApproval: (request: CodexApprovalRequest) => this.requestApproval(message.senderId, request),
          onApprovalResult: (request, result) => this.reportApprovalResult(message.senderId, request, result),
          onUserInput: (request: import("../codex/backend.js").CodexUserInputRequest) => this.requestUserInput(message.senderId, request, this.sessionHostId(session)),
          onUserInputResult: (request: import("../codex/backend.js").CodexUserInputRequest, result: import("../codex/backend.js").CodexUserInputResult) =>
            this.reportUserInputResult(message.senderId, request, result, this.sessionHostId(session))
        };
        // A web/IM detach during preparation must not submit a new native input.
        // Already accepted native queue items remain owned by Codex.
        if (!queued && !stillBound()) { await replyStream?.suspend(); return; }
        this.options.assertRuntimeWritable?.();
        if (this.audienceSuspended) throw new CodexInterventionError("渠道已停止，消息未提交。");
        backendEntered = true;
        const result = queued
          ? await this.runner.runQueuedSubmission!({ ...runInput, assertCurrent: assertInputCurrent, threadId: queued.receipt.threadId,
            queuedSubmissionId: queued.receipt.queuedSubmissionId, onQueueStarting: queued.starting,
            clientUserMessageId: queued.receipt.clientUserMessageId, acceptedTurnId: queued.receipt.turnId,
            observeOnly: queued.receipt.status === "completed",
            // Native queue consumes only its stored input and inherits native
            // settings. Do not silently apply later Bridge setting changes.
            model: undefined, effort: undefined, collaborationMode: undefined,
            projectId: undefined, projectName: undefined, threadTitle: undefined })
          : await submission.run(this.runner, runInput, assertInputCurrent);
        console.log(`[codex-im-gateway] Codex turn completed for ${message.senderId}; text=${result.text.length} chars`);
        if (result.threadId) {
          saveNativeThread(result.threadId);
        }
        if (result.threadId && result.turnId) recordParticipant(result.threadId, result.turnId);
        const parsed = parseActionBlocks(result.text, { strict: false });
        const bound = stillBound();
        const journaled = bound && result.turnId && this.options.deliverTurnResult;
        for (const memory of !bound || journaled ? [] : parsed.actions.remember) {
          this.options.stateStore.rememberKnowledge(memory, session.projectId, session.id);
        }
        let finalText = parsed.visibleText.trim() || "处理完成。";
        // The journal owns decoration when present; standalone delivery uses
        // the same presentation policy, never a second enrichment pass.
        if (!journaled) {
          let url: string | undefined;
          try { url = await this.options.ideEntry?.(session); } catch { /* IDE is optional. */ }
          finalText = withIDEEntry(finalText, url);
        }
        const streamed = journaled
          ? await this.options.deliverTurnResult!(session, result.turnId!, result.text)
          : bound && replyStream ? await replyStream.finalize(finalText) : false;
        let resultDelivered = Boolean(streamed);
        if (!bound) {
          await replyStream?.finalize("已切换或退出绑定；原任务结果可用 /history 查看。", false, { outcome: "detached" });
          await replyStream?.suspend();
        } else if (journaled) {
          // Shared delivery owns pending results and error notices. An
          // unacknowledged card must not fall through to a duplicate reply.
        } else if (!streamed && replyStream && (replyStream.supported || replyStream.checkpoint().terminalPages?.length)) {
          await replyStream.reportTerminalFailure();
        } else if (parsed.visibleText.trim() && !streamed) {
          await this.reply(message.senderId, finalText);
          resultDelivered = true;
        }
        if (!journaled && bound && result.turnId && resultDelivered) {
          void this.notifyTurnParticipants(session, result.turnId, stillBound, replyStream?.checkpoint());
        }
        for (const action of journaled ? [] : parsed.actions.send) {
          if (!stillBound()) break;
          await this.sendLocalMedia(message.senderId, action, this.sessionHostId(session));
        }
        await this.options.onTurnCompleted?.({
          senderId: message.senderId,
          sessionId: session.id,
          text: parsed.visibleText.trim(),
          success: true,
          turnId: result.turnId
        });
      });
    } catch (error) {
      if (queued && !acceptedQueueTurn) throw error;
      if (error instanceof CodexTurnExecutionError && error.status === "failed" && error.failureCode === "model-capacity"
        && acceptedTurnId && session.threadId && stillBound()
        && this.options.deferCapacityFailure?.({ hostId: this.sessionHostId(session) ?? "local", threadId: session.threadId, turnId: acceptedTurnId })) {
        await this.options.onSubscriptionsChanged?.();
        return; // Coordinator owns recovery; do not terminalize, notify, or replay input.
      }
      error = queued ? communicationError(error, { phase: acceptedTurnId ? "observation" : backendEntered ? "submission" : "preflight",
        operation: acceptedTurnId ? "turn/observe" : backendEntered ? "turn/submit" : "turn/prepare", threadId: session.threadId, turnId: acceptedTurnId }) : submission.error(error);
      if (error instanceof TurnDeliveryError) throw error;
      if (error instanceof TurnApplicationError) {
        if (await replyStream?.waitForBackend(error.message)) markMessageHandlingErrorReported(error);
        await this.options.onSubscriptionsChanged?.(); throw error;
      }
      if (error instanceof CodexCommunicationError && error.submission !== "not-submitted") {
        if (this.options.isRuntimeDraining?.()) { markMessageHandlingErrorReported(error); throw error; }
        console.warn(`[codex-im-gateway] backend communication ${JSON.stringify({ timestamp: new Date().toISOString(),
          phase: error.phase, operation: error.operation, submission: error.submission, code: error.code,
          threadId: error.threadId, turnId: error.turnId })}`);
        // Preserve the same card. Following reconciles late acceptance/result
        // receipts without resending the prompt or emitting task completion.
        const reported = !stillBound() || (await replyStream?.waitForBackend(
          stripBridgeErrorPrefix(userFacingMessageHandlingError(error))) ?? false);
        if (reported) markMessageHandlingErrorReported(error);
        await this.options.onSubscriptionsChanged?.();
        throw error;
      }
      let failureWasReported = !stillBound() || (await replyStream?.fail(
        stripBridgeErrorPrefix(userFacingMessageHandlingError(error)),
        error instanceof CodexTurnExecutionError && error.status === "interrupted" ? "interrupted" : "failed"
      ) ?? false);
      if (!failureWasReported && replyStream && (replyStream.supported || replyStream.checkpoint().terminalPages?.length)) {
        try { failureWasReported = await replyStream.reportTerminalFailure(); }
        catch { console.warn("[codex-im-gateway] terminal delivery-error notice failed"); }
      }
      if (failureWasReported) markMessageHandlingErrorReported(error);
      if (failureWasReported && error instanceof CodexTurnExecutionError && acceptedTurnId && stillBound()) {
        void this.notifyTurnParticipants(session, acceptedTurnId, stillBound, replyStream?.checkpoint());
      }
      if (error instanceof CodexTurnExecutionError) await this.options.onTurnCompleted?.({
        senderId: message.senderId,
        sessionId: session.id,
        text: stripBridgeErrorPrefix(userFacingMessageHandlingError(error)),
        success: false
      });
      if (queued && error instanceof CodexTurnExecutionError) return;
      throw error;
    } finally {
      if (this.activePresentations.get(session.id)?.stream === replyStream) this.activePresentations.delete(session.id);
      if (activeMarked) {
        this.runningSessions.delete(session.id);
        this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: false });
      }
    }
    });
  }

  /** Explicit recovery finalization only, not arbitrary history replay. The
   * coordinator journals completion before invoking this once; ambiguous media
   * sends are not replayed after restart. */
  async applyRecoveredOutput(sessionId: string, text: string, native: { hostId: string; threadId: string }): Promise<void> {
    this.options.stateStore.refresh();
    const session = this.options.stateStore.getSession(sessionId);
    if (!session || session.threadId !== native.threadId || this.sessionHostId(session) !== native.hostId) return;
    const binding = sessionExecutionScope(this.options.stateStore, session);
    if (!binding.current()) return;
    const parsed = parseActionBlocks(text, { strict: false });
    for (const memory of parsed.actions.remember) {
      if (!binding.current()) break;
      this.options.stateStore.rememberKnowledge(memory, session.projectId, session.id);
    }
    for (const action of parsed.actions.send) {
      if (!binding.current()) break;
      await this.sendLocalMedia(session.senderId, action, native.hostId);
    }
  }

  async applyRecoveredAction(sessionId: string, native: { hostId: string; threadId: string }, action: TurnResultAction): Promise<void> {
    this.options.stateStore.refresh();
    const session = this.options.stateStore.getSession(sessionId);
    if (!session || session.threadId !== native.threadId || this.sessionHostId(session) !== native.hostId
      || !sessionExecutionScope(this.options.stateStore, session).current()) throw new CodexInterventionError("Result application binding changed");
    if (action.kind === "remember") this.options.stateStore.rememberKnowledge(action.value, session.projectId, session.id);
    else await this.sendLocalMedia(session.senderId, action.value, native.hostId);
  }

  private async codexProjectCandidates(): Promise<readonly CodexProjectCandidate[]> {
    return await this.options.listCodexProjects?.() ?? projectCandidatesFromBackendCatalog(await this.runner.listProjects());
  }

  private boundProjectForCandidate(
    candidate: CodexProjectCandidate,
    projects: readonly ManagedProject[] = this.options.stateStore.listProjects()
  ): ManagedProject | undefined {
    return managedProjectForNative(candidate, projects);
  }

  private synchronizeManagedProjects(candidates: readonly CodexProjectCandidate[]): void {
    for (const project of this.options.stateStore.listProjects()) {
      this.synchronizeManagedProject(project, candidates);
    }
  }

  private synchronizeManagedProject(
    project: ManagedProject,
    candidates: readonly CodexProjectCandidate[]
  ): ManagedProject {
    const candidate = nativeProjectForManaged(project, candidates, this.options.stateStore.listProjects());
    if (!candidate?.projectId) return project;
    if (
      project.sourceProjectId === candidate.projectId
      && project.projectKind === candidate.projectKind
      && project.hostId === candidate.hostId
      && JSON.stringify(project.rootPaths) === JSON.stringify(candidate.rootPaths)
    ) return project;
    return this.options.stateStore.updateProjectMetadata(project.id, {
      sourceProjectId: candidate.projectId,
      rootPaths: candidate.rootPaths,
      projectKind: candidate.projectKind,
      hostId: candidate.hostId
    });
  }

  private ensureConversationSession(senderId: string, project: ManagedProject): ManagedSession {
    const active = this.options.stateStore.getActiveSession(senderId);
    if (active?.projectId === project.id && active.mode !== "qa") return active;
    const existing = this.options.stateStore.listSessions()
      .filter((session) => session.senderId === senderId && session.projectId === project.id && session.mode !== "qa")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return existing
      ? this.options.stateStore.activateSession(existing.id)
      : this.options.stateStore.createSession(senderId, project.workspace, undefined, project.id);
  }

  private ensureQaSession(
    senderId: string,
    project: ManagedProject,
    knowledgeBase: ManagedKnowledgeBase
  ): ManagedSession {
    const active = this.options.stateStore.getActiveQaSession(senderId);
    if (
      active?.projectId === project.id
      && active.knowledgeBaseId === knowledgeBase.id
    ) {
      return active;
    }
    const existing = this.options.stateStore.listSessions()
      .filter((session) => (
        session.senderId === senderId
        && session.projectId === project.id
        && session.mode === "qa"
        && session.knowledgeBaseId === knowledgeBase.id
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return existing
      ? this.options.stateStore.activateSession(existing.id)
      : this.options.stateStore.createSession(
          senderId,
          project.workspace,
          `问答 · ${knowledgeBase.name}`,
          project.id,
          "qa",
          knowledgeBase.id
        );
  }

  private resolveQaContext(project: ManagedProject): ManagedKnowledgeBase | undefined {
    const knowledgeBaseId = project.knowledgeBaseId ?? this.modeSettings.qaKnowledgeBaseId;
    return knowledgeBaseId
      ? this.options.stateStore.listKnowledgeBases().find((item) => item.id === knowledgeBaseId)
      : undefined;
  }

  private async handleKnowledgeToolCall(
    knowledgeBase: ManagedKnowledgeBase,
    call: CodexDynamicToolCall
  ): Promise<string> {
    if (call.namespace !== "knowledge" || (call.tool !== "search" && call.tool !== "get_document")) {
      throw new Error(`不允许的知识库工具：${call.namespace ?? ""}.${call.tool}`);
    }
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new Error("知识库工具参数必须是 JSON 对象");
    }
    return this.llmWiki.call(
      knowledgeBase,
      call.tool,
      call.arguments as Record<string, unknown>
    );
  }

  private async sendLocalMedia(senderId: string, action: { type: "image" | "file" | "video"; path: string }, hostId = "local"): Promise<void> {
    try {
      // File paths belong to the execution host. There is no outbound remote
      // transfer port yet; never substitute a same-path Gateway-local file.
      if (hostId !== "local") {
        await this.reply(senderId, `文件位于远程主机，当前无法回传：${path.basename(action.path)}。请通过该项目的 Web IDE 下载。`);
        return;
      }
      if (this.channel.capabilities.outbound[action.type] !== "available") {
        await this.reply(senderId, `当前渠道暂不支持直接发送 ${action.type} 文件：${path.basename(action.path)}`);
        return;
      }
      const sent = await this.channel.sendMedia({ toUserId: senderId, path: action.path, kind: action.type,
        contextToken: this.options.stateStore.getContextToken(senderId) });
      this.options.onOutboundMessage?.({
        direction: "outbound",
        id: sent.messageId,
        recipientId: senderId,
        text: "",
        attachments: [{ kind: action.type, label: path.basename(action.path) }]
      });
    } catch (error) {
      await this.reply(senderId, `[codex-im-gateway] Failed to send ${action.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withTyping(senderId: string, run: () => Promise<void>): Promise<void> {
    if (this.channel.capabilities.typing !== "available") {
      await run();
      return;
    }
    const sendTyping = async (typing: boolean) => {
      try {
        await this.channel.sendTyping?.({
          toUserId: senderId,
          contextToken: this.options.stateStore.getContextToken(senderId),
          typing
        });
      } catch (error) {
        console.warn(`Channel typing indicator failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    await sendTyping(true);
    const timer = setInterval(() => {
      sendTyping(true).catch((error) => {
        console.warn(`WeChat typing refresh failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 5_000);
    try {
      await run();
    } finally {
      clearInterval(timer);
      await sendTyping(false);
    }
  }

  private async statusText(senderId: string): Promise<string> {
    const mode = this.options.stateStore.getInteractionMode(senderId);
    const project = this.options.stateStore.getActiveProject(senderId);
    const session = this.executionSession(senderId);
    const workspace = project?.workspace ?? session?.workspace ?? this.options.config.defaultCwd;
    const knowledgeBase = project ? this.resolveQaContext(project) : undefined;
    const binding = session && sessionExecutionScope(this.options.stateStore, session, senderId);
    const observation = { includeTurns: false as const, timeoutMs: STATUS_RPC_BUDGET_MS, purpose: "status" as const };
    const [taskResult, runtimeResult, stateResult] = await Promise.all([
      observeStatus(async () => {
        if (!project || !session?.threadId || !this.options.taskboard
          || !localProjectsAtWorkspace(project.workspace, this.options.stateStore.listProjects()).some(item => item.id === project.id)) return;
        const target = await this.options.taskboard.projectForWorkspace(project.workspace);
        return target ? this.options.taskboard.issueForThread(target.id, session.threadId) : undefined;
      }),
      observeStatus(() => this.runner.getRuntimeInfo(workspace, session?.threadId, this.sessionHostId(session), observation)),
      observeStatus(async () => session?.threadId && typeof this.runner.inspectThread === "function"
        ? this.runner.inspectThread(session.threadId, this.sessionHostId(session), observation) : undefined)
    ]);
    if (binding ? !binding.current() : Boolean(this.executionSession(senderId)))
      return "查询期间会话绑定已改变，未展示旧目标的状态。请再次使用 /status 查看当前会话。";
    const issue = taskResult.available ? taskResult.value : undefined;
    const runtime = runtimeResult.available ? runtimeResult.value : {};
    let execution = "尚未创建任务";
    let activeTurnId: string | undefined;
    if (session?.threadId) {
      const state = stateResult.available ? stateResult.value : undefined;
      if (state && state.threadId === session.threadId) {
        activeTurnId = state.activeTurnId;
        execution = state.pendingTurnWithoutId && state.runtimeStatus !== "active"
          ? "状态异常：App 有未确认的运行中消息，但实际后端空闲"
          : state.activeFlags.includes("waitingOnApproval") ? "等待审批"
          : state.activeFlags.includes("waitingOnUserInput") ? "等待用户确认"
          : ({ active: "正在执行", idle: "空闲", notLoaded: "未加载（不能据此断言任务已结束）",
            unknown: "未确认", systemError: "系统错误" } as const)[state.runtimeStatus];
        execution += "（只读快照）";
      } else execution = "暂未确认（状态读取超时或不可用，未按空闲处理）";
    }
    return [
      "当前工作上下文",
      `项目：${project?.name ?? "尚未选择"}`,
      `模式：${formatInteractionMode(mode)}`,
      `问答知识库：${knowledgeBase?.name ?? "未绑定"}`,
      `任务：${issue ? `${issue.identifier} · ${formatTaskboardStatus(issue.status)} · ${issue.title}` : taskResult.available ? "尚未绑定 Taskboard Issue" : "关联信息暂不可读取"}`,
      `会话：${session?.title ?? "未绑定任何 session"}`,
      ...(!session ? ["普通消息不会提交；使用 /sessions 查看，/session 绑定或 /new 新建。"] : []),
      `对话状态：${session?.collaborationMode === "plan" ? "计划协作" : "普通对话（未附加模式）"}`,
      `工作目录：${workspace}`,
      `thread：${session?.threadId || "尚未创建"}`,
      `运行状态：${execution}`,
      ...(activeTurnId ? [`运行轮次：${activeTurnId}`] : []),
      `实时跟随：${this.runner.backendInfo?.(session ? this.sessionHostId(session) : undefined).capabilities.liveFollow === false
        ? "当前后端不支持" : session?.follow === false || !session ? "关闭" : "开启"}`,
      ...(session && this.options.sessionFollow ? formatFollowStatus(this.options.sessionFollow.status(session)) : []),
      `backend：${this.options.config.codexBackend}`,
      `app-server transport：${this.options.config.codexAppServerTransport}`,
      `exec sandbox：${this.options.config.codexExecSandbox ?? "Codex 默认"}`,
      `model: ${session?.model ?? this.options.config.model ?? runtime.model ?? (runtimeResult.available ? "(Codex default)" : "(暂未读取)")}`,
      `effort: ${session?.effort ?? this.options.config.effort ?? runtime.effort ?? (runtimeResult.available ? "(Codex default)" : "(暂未读取)")}`,
      ...(!taskResult.available || !runtimeResult.available || !stateResult.available
        ? ["部分状态未在查询预算内确认；原任务与绑定未改变。"] : []),
      `过程回复：${(session?.streamReplies ?? this.options.config.streamReplies) ? "开启" : "关闭"}${typeof session?.streamReplies === "boolean" ? "（当前会话）" : "（全局）"}`
    ].join("\n\n");
  }

  private async handleBalanceCommand(senderId: string): Promise<void> {
    try {
      const balance = await (this.options.getCodexBalance?.() ?? this.runner.getAccountRateLimits());
      await this.reply(senderId, formatAccountBalance(balance));
    } catch (error) {
      console.warn(`Codex account balance unavailable: ${error instanceof Error ? error.message : String(error)}`);
      await this.reply(senderId, "暂时无法获取 Codex 当前账号用量，请稍后重试。");
    }
  }

  private async listCodexModels(): Promise<CodexModelOption[]> {
    try {
      return await (this.options.listCodexModels?.() ?? this.runner.listModels());
    } catch (error) {
      console.warn(`Codex model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async effectiveRuntime(senderId: string): Promise<CodexRuntimeInfo> {
    const session = this.executionSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    let runtime: CodexRuntimeInfo = {};
    try {
      runtime = await this.runner.getRuntimeInfo(workspace, session?.threadId, this.sessionHostId(session));
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      model: session?.model ?? this.options.config.model ?? runtime.model,
      effort: session?.effort ?? this.options.config.effort ?? runtime.effort,
      provider: runtime.provider
    };
  }

  private projectHostId(projectId?: string): string | undefined {
    return projectId ? this.options.stateStore.getProject(projectId)?.hostId : undefined;
  }

  private sessionHostId(session?: ManagedSession): string {
    return session?.hostId ?? this.projectHostId(session?.projectId) ?? "local";
  }

  private async reply(senderId: string, text: string): Promise<void> {
    const contextToken = this.options.stateStore.getContextToken(senderId);
    try {
      console.log(`[codex-im-gateway] sending reply to ${senderId}; text=${text.length} chars`);
      const sent = await this.channel.sendText({ toUserId: senderId, text, contextToken });
      this.reportCardDelivery(senderId, sent, text);
      console.log(`[codex-im-gateway] sent reply to ${senderId}`);
    } catch (error) {
      if (error instanceof ChannelContextExpiredError) {
        console.warn(`Channel reply context expired for ${senderId}; a fresh message is required.`);
        return;
      }
      throw error;
    }
  }

  private async replyActionCard(senderId: string, card: ChannelActionCard): Promise<void> {
    const interaction = this.cardInteraction.getStore();
    if (interaction && this.channel.capabilities.cardUpdates === "available") {
      try {
        console.log(`[codex-im-gateway] updating action card "${card.title}" in ${interaction.messageId}`);
        await this.channel.updateActionCard({ messageId: interaction.messageId, card });
        this.options.onOutboundMessage?.({
          direction: "outbound",
          id: interaction.messageId,
          recipientId: senderId,
          text: card.fallbackText,
          attachments: []
        });
        console.log(`[codex-im-gateway] updated action card "${card.title}"`);
        return;
      } catch (error) {
        console.warn(`Action card update failed for ${senderId}; sending a new card: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      console.log(`[codex-im-gateway] sending action card "${card.title}" to ${senderId}`);
      const sent = await this.channel.sendActionCard({ toUserId: senderId, card,
        contextToken: this.options.stateStore.getContextToken(senderId) });
      this.reportCardDelivery(senderId, sent, card.fallbackText);
      console.log(`[codex-im-gateway] sent action card "${card.title}" to ${senderId}`);
    } catch (error) {
      if (error instanceof ChannelPartialDeliveryError) {
        this.reportCardDelivery(senderId, { messageId: "", parts: error.delivered }, "");
        throw error;
      }
      console.warn(`Action card delivery failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      for (const page of resultPages(card.fallbackText, 1800)) {
        await this.reply(senderId, page.text);
      }
    }
  }

  private async replyTaskCard(message: ChannelMessage, card: ChannelTaskCard): Promise<void> {
    card = copyableTaskCard(card);
    const senderId = message.senderId;
    if (message.interaction && this.channel.capabilities.cardUpdates === "available") {
      try {
        console.log(`[codex-im-gateway] updating Taskboard card ${card.identifier} in ${message.interaction.messageId}`);
        await this.channel.updateTaskCard({ messageId: message.interaction.messageId, card });
        this.options.onOutboundMessage?.({
          direction: "outbound",
          id: message.interaction.messageId,
          recipientId: senderId,
          text: card.fallbackText,
          attachments: []
        });
        console.log(`[codex-im-gateway] updated Taskboard card ${card.identifier}`);
        return;
      } catch (error) {
        console.warn(`Taskboard card update failed for ${senderId}; sending a new card: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      console.log(`[codex-im-gateway] sending Taskboard card ${card.identifier} to ${senderId}`);
      const sent = await this.channel.sendTaskCard({ toUserId: senderId, card,
        contextToken: this.options.stateStore.getContextToken(senderId) });
      this.reportCardDelivery(senderId, sent, card.fallbackText);
      console.log(`[codex-im-gateway] sent Taskboard card ${card.identifier} to ${senderId}`);
    } catch (error) {
      if (error instanceof ChannelPartialDeliveryError) {
        this.reportCardDelivery(senderId, { messageId: "", parts: error.delivered }, "");
        throw error;
      }
      console.warn(`Taskboard card delivery failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      await this.reply(senderId, card.fallbackText);
    }
  }

  private reportCardDelivery(senderId: string, sent: ChannelReceipt, text: string): void {
    for (const part of sent.parts ?? [{ messageId: sent.messageId, text }]) {
      this.options.onOutboundMessage?.({ direction: "outbound", id: part.messageId,
        recipientId: senderId, text: part.text, attachments: [] });
    }
  }

  allowSender(senderId: string): void {
    this.options.stateStore.refresh();
    this.options.stateStore.setPairedSenderIds([...this.options.stateStore.listPairedSenderIds(), senderId]);
  }

  removeSender(senderId: string): void {
    this.options.stateStore.refresh();
    if (this.options.config.allowedSenderIds.includes(senderId)) throw new Error("此身份还在固定准入配置 allowedSenderIds 中；请先从该配置移除，再撤销个人准入。");
    this.options.stateStore.setPairedSenderIds(this.options.stateStore.listPairedSenderIds().filter(id => id !== senderId));
  }

  listAllowedSenders(): string[] {
    return this.access.listPairedSenderIds();
  }

  async requestApproval(senderId: string, request: CodexApprovalRequest): Promise<CodexApprovalDecision> {
    const session = this.executionSession(senderId);
    const active = session && this.activePresentations.get(session.id);
    if (active?.threadId === request.threadId && active.turnId === request.turnId) {
      try { await active.stream.setActivity("waiting-approval"); } catch { /* Presentation cannot block approval. */ }
    }
    return this.approvals.request(senderId, request);
  }

  reportApprovalResult(senderId: string, request: CodexApprovalRequest, result: ApprovalDeliveryResult): Promise<void> {
    return this.approvals.reportResult(senderId, request, result);
  }

  listApprovals() { return this.approvals.list(); }
  decideApproval(senderId: string, id: string, choice: string, version: string) {
    return this.approvals.decideCurrent(senderId, id, choice, version);
  }

  async requestUserInput(senderId: string, request: import("../codex/backend.js").CodexUserInputRequest, hostId?: string): Promise<import("../codex/backend.js").CodexUserInputAnswer | undefined> {
    const native = { ...request, hostId: hostId ?? request.hostId ?? "local" };
    const session = this.executionSession(senderId);
    if (session?.threadId !== native.threadId || (this.sessionHostId(session) ?? "local") !== native.hostId) return Promise.resolve(undefined);
    const active = this.activePresentations.get(session.id);
    // Async questions allow execution to continue; they are not a blocked turn.
    if (native.kind !== "async" && active?.hostId === native.hostId && active.threadId === native.threadId && active.turnId === native.turnId) {
      try { await active.stream.setActivity("waiting-input"); } catch { /* Preserve native question delivery. */ }
    }
    return this.userInputs.request(senderId, native);
  }

  acceptedPresentationInputs(): AcceptedPresentationInput[] {
    return this.userInputs.acceptedPresentationInputs();
  }
  private participantOrigin(session?: ManagedSession): TurnParticipantOrigin | undefined {
    const source = this.participant.getStore();
    if (!source || !session || source.conversationId !== session.senderId) return undefined;
    return { ...source, bindingKey: JSON.stringify([this.options.accountId ?? "standalone", session.id]) };
  }
  private async observeControlAudience(session: ManagedSession, turnId: string | undefined, submit: () => Promise<CodexInputReceipt>): Promise<CodexInputReceipt> {
    const origin = this.participantOrigin(session);
    const release = origin && turnId && session.threadId ? this.turnAudience.hold({ bindingKey: origin.bindingKey,
      conversationId: origin.conversationId, hostId: this.sessionHostId(session) ?? "local", threadId: session.threadId, turnId }) : () => {};
    try {
      const receipt = await submit();
      await this.presentControlReceipt(session, receipt.turnId);
      return receipt;
    } finally { release(); }
  }
  private async notifyTurnParticipants(session: ManagedSession, turnId: string, isCurrent: () => boolean,
    checkpoint?: ReturnType<TurnReplyStream["checkpoint"]>): Promise<void> {
    if (!session.threadId) return;
    try { await this.turnAudience.notify({ bindingKey: JSON.stringify([this.options.accountId ?? "standalone", session.id]),
      conversationId: session.senderId, hostId: this.sessionHostId(session) ?? "local", threadId: session.threadId, turnId }, this.channel,
    { isCurrent: () => !this.audienceSuspended && isCurrent(), contextToken: this.options.stateStore.getContextToken(session.senderId),
      completedCard: completedCardForMentions(checkpoint) }); }
    catch { console.warn("[codex-im-gateway] turn mention journal unavailable; result delivery preserved"); }
  }
  private async presentControlReceipt(session: ManagedSession, turnId: string): Promise<void> {
    const inputs = this.controls.acceptedPresentationInputs().filter(input => input.hostId === (this.sessionHostId(session) ?? "local")
      && input.threadId === session.threadId && input.turnId === turnId);
    for (const input of inputs) await this.presentAcceptedInput(input);
  }
  private async presentAcceptedInput(input: AcceptedPresentationInput): Promise<void> {
    // Presentation failure cannot turn a successful native submission into an
    // execution failure. Polling recovers this exact fact from its own receipt.
    try {
      if (input.origin) this.turnAudience.record({ bindingKey: input.origin.bindingKey,
        conversationId: input.origin.conversationId, hostId: input.hostId, threadId: input.threadId, turnId: input.turnId }, input.origin, input.acceptedAt);
      if (this.options.onAcceptedInput) await this.options.onAcceptedInput(input);
      else for (const active of this.activePresentations.values()) if (active.hostId === input.hostId
        && active.threadId === input.threadId && active.turnId === input.turnId && active.stream instanceof ChannelTurnPresentation) {
        await active.stream.startSegment(input);
      }
    } catch { console.warn("[codex-im-gateway] accepted input presentation pending"); }
  }

  hasUserInput(senderId: string, request: import("../codex/backend.js").CodexUserInputRequest): boolean {
    return this.userInputs.hasRequest(senderId, request);
  }

  suspendUserInputs(): void { this.audienceSuspended = true; this.userInputs.close(); }
  hasBindingWork(senderId: string): boolean {
    return this.conversationWork.has(senderId) || this.approvals.hasPending(senderId) || this.userInputs.hasUnsettled(senderId);
  }

  reconcileUserInputs(): void { this.userInputs.suspendInvalidBindings(); }

  observeNativeUserInputAnswers(receipts: readonly import("../codex/async-user-input.js").NativeAsyncAnswerReceipt[]): Promise<void> {
    return this.userInputs.observeNativeAnswers(receipts);
  }

  reportUserInputResult(senderId: string, request: import("../codex/backend.js").CodexUserInputRequest,
    result: import("../codex/backend.js").CodexUserInputResult, hostId?: string): Promise<void> {
    return this.userInputs.reportResult(senderId, { ...request, hostId: hostId ?? request.hostId ?? "local" }, result);
  }
}

function channelPromptSource(channel: ChannelClient["channel"]): "WeChat" | "DingTalk" | "Feishu" | "WeCom" | "IM" {
  return { weixin: "WeChat", dingtalk: "DingTalk", feishu: "Feishu", wecom: "WeCom", generic: "IM" }[channel] as ReturnType<typeof channelPromptSource>;
}

function taskboardSkillPrompt(instruction: string): string {
  return `使用 manage-taskboard Skill 完成以下操作。遵守其线程归属、状态迁移、评论证据和验收门禁；Taskboard 是任务状态唯一事实源。\n\n${instruction}`;
}

function formatKnowledgeKind(kind: "preference" | "skill" | "knowledge" | "workflow"): string {
  return {
    preference: "偏好",
    skill: "工作技巧",
    knowledge: "知识点",
    workflow: "流程"
  }[kind];
}

function normalizeMode(input: string): ProjectInteractionMode | undefined {
  const value = input.trim().toLowerCase();
  if (["session", "chat", "conversation", "会话", "聊天"].includes(value)) return "session";
  if (["task", "taskboard", "任务", "面板"].includes(value)) return "task";
  if (["qa", "question", "knowledge", "问答", "知识库"].includes(value)) return "qa";
  return undefined;
}

function formatInteractionMode(mode: ProjectInteractionMode): string {
  return ({ session: "会话模式", task: "任务模式", qa: "问答模式" } as const)[mode];
}

function assertNeverMode(mode: never): never {
  throw new Error(`Unsupported project interaction mode: ${mode}`);
}

function formatGoalStatus(status: CodexThreadGoalStatus): string {
  return ({
    active: "进行中",
    paused: "已暂停",
    blocked: "受阻",
    usageLimited: "用量受限",
    budgetLimited: "预算用尽",
    complete: "已完成"
  } as const)[status];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function buildQaPrompt(
  prompt: string,
  project: ManagedProject,
  knowledgeBase: ManagedKnowledgeBase
): string {
  return [
    prompt,
    "",
    "[codex-channel-qa-mode]",
    `当前工作项目：${project.name}（${project.workspace}）。所有文件读取、命令和修改仍以该项目目录为 cwd。`,
    `只读知识库：${knowledgeBase.name}。它不是工作目录，不能把知识库路径当作 cwd，也不能修改知识库。`,
    "当问题需要知识库事实时，由你自主决定检索步骤：先调用 knowledge.search，必要时继续调用 knowledge.get_document 核对完整上下文。",
    "不要假装已经检索；基于知识库作答时，在相关结论附近保留搜索结果中的 anchor 引用。若没有检索到证据，明确说明。",
    "[/codex-channel-qa-mode]"
  ].join("\n");
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function visibleConversationHistory(messages: readonly CodexHistoryMessage[]): CodexHistoryMessage[] {
  return messages.flatMap((message) => {
    if (message.kind === "progress") return [];
    const text = message.role === "user"
      ? visibleHistoryUserText(message.text)
      : visibleHistoryAssistantText(message.text);
    if (!text) return [];
    return [{ ...message, text: boundedProgressText(text, 1_600) }];
  });
}

function visibleHistoryUserText(value: string): string {
  const parsed = parsePrompt(value);
  const labels: Record<string, string> = {
    file: "文件",
    image: "图片",
    video: "视频",
    audio: "音频"
  };
  return [
    parsed.text,
    ...parsed.attachments.map((attachment) => `[${labels[attachment.kind] ?? "附件"}：${attachment.label}]`)
  ].filter(Boolean).join("\n").trim();
}

function visibleHistoryAssistantText(value: string): string {
  try {
    return parseActionBlocks(value, { strict: false }).visibleText.trim();
  } catch {
    // A malformed action block in old history must not make the whole history
    // command fail. Hide the block and retain the user-visible answer around it.
    return value.replace(
      /```(?:codex-im-gateway|codex-channel-bridge|codex-weixin(?:-server)?)-actions\s*[\s\S]*?```/gi,
      ""
    ).trim();
  }
}

function formatConversationHistory(messages: readonly CodexHistoryMessage[]): string {
  return messages.map((message) => {
    const role = message.role === "user" ? "👤 用户" : "🤖 Codex";
    const time = message.createdAt ? ` · ${formatSessionTime(message.createdAt)}` : "";
    return `${role}${time}\n${message.text}`;
  }).join("\n\n");
}

function codexSessionCandidatePreview(candidate: CodexSessionCandidate): string | undefined {
  if (!candidate.lastUserMessage) return undefined;
  const parsed = parsePrompt(candidate.lastUserMessage);
  return buildPromptPreview(parsed.text, parsed.attachments);
}

function codexThreadStateCandidate(state: CodexThreadState, fallbackWorkspace: string): CodexSessionCandidate {
  return {
    threadId: state.threadId,
    workspace: state.cwd ?? fallbackWorkspace,
    lastUsedAt: state.updatedAt ?? new Date(0).toISOString(),
    persistence: state.persistence,
    runtimeStatus: state.runtimeStatus,
    activeFlags: state.activeFlags,
    ...(state.latestTurnStatus ? { latestTurnStatus: state.latestTurnStatus } : {}),
    ...(state.title ? { title: state.title } : {}),
    ...(state.preview ? { lastUserMessage: state.preview } : {})
  };
}

function projectSessionChoiceStateLabel(choice: ProjectSessionChoice): string {
  const candidate = choice.candidate;
  if (!candidate) return choice.managed?.threadId ? "状态未知" : "尚未开始";
  if (candidate.persistence === "archived") return "已归档";
  if (candidate.persistence === "missing") return "已失效";
  if (candidate.runtimeStatus === "systemError") return "系统错误";
  if (candidate.desktopOwned) return "Desktop 已打开";
  if (candidate.runtimeStatus === "active") {
    if (candidate.activeFlags?.includes("waitingOnApproval")) return "等待审批";
    if (candidate.activeFlags?.includes("waitingOnUserInput")) return "等待输入";
    return "执行中";
  }
  if (candidate.latestTurnStatus === "failed") return "上次执行失败";
  if (candidate.latestTurnStatus === "interrupted") return "上次已停止";
  if (candidate.runtimeStatus === "notLoaded") return "未加载";
  if (candidate.runtimeStatus === "idle") return candidate.persistence === "ephemeral" ? "临时会话" : "空闲";
  return candidate.persistence === "ephemeral" ? "临时会话" : "状态未知";
}

function unavailableProjectSessionChoiceReason(choice: ProjectSessionChoice): string | undefined {
  const candidate = choice.candidate;
  if (candidate?.persistence === "archived") {
    return "这个 Codex session 已归档。Bridge 不会静默恢复它；请先在 Codex App 中取消归档，再重新选择。";
  }
  if (candidate?.persistence === "missing") {
    return "这个 Codex session 已不存在或被删除，原绑定已经失效。请重新选择其他 session，或新建一个 session。";
  }
  if (candidate?.runtimeStatus === "systemError") {
    return "这个 Codex session 当前处于系统错误状态。请先在 Codex App 中打开并处理错误，再重新选择。";
  }
  return undefined;
}

function stripBridgeErrorPrefix(message: string): string {
  return message.replace(/^\[(?:codex-im-gateway|codex-channel-bridge)]\s*/i, "");
}


const fallbackEfforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function selectModel(models: CodexModelOption[], input: string): CodexModelOption | undefined {
  if (/^\d+$/.test(input)) {
    return models[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return models.find((model) => model.model.toLowerCase() === normalized);
}

function isPlausibleModelId(input: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(input);
}

function availableEfforts(model: CodexModelOption | undefined, models: CodexModelOption[]): string[] {
  const advertised = model?.supportedEfforts.length
    ? model.supportedEfforts.map((option) => option.effort)
    : models.flatMap((option) => option.supportedEfforts.map((effort) => effort.effort));
  return advertised.length ? [...new Set(advertised)] : fallbackEfforts;
}

function selectEffort(efforts: string[], input: string): string | undefined {
  if (/^\d+$/.test(input)) {
    return efforts[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return efforts.find((effort) => effort.toLowerCase() === normalized);
}

function formatEffort(effort?: string): string {
  if (!effort) return "Codex 默认";
  const labels: Record<string, string> = {
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
    ultra: "极高"
  };
  return labels[effort] ? `${labels[effort]}（${effort}）` : effort;
}

function visibleStreamingAnswer(text: string): string {
  const actionFence = text.search(/```codex-(?:im-gateway|channel-bridge|weixin)-actions\b/i);
  return (actionFence >= 0 ? text.slice(0, actionFence) : text).trim();
}

function boundedProgressText(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
