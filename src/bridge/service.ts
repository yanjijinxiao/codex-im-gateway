import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

import { AccessController, requiredCommandRole, roleAllows, type SessionRole } from "./access.js";
import { SessionControlJournal, SessionControlQueue } from "./session-control.js";
import { ChannelApprovalController } from "./approval.js";
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
  friendlyCommandsContinueConversation,
  isGoalSetCommand,
  requiredModeForCommand
} from "./channel-command-policy.js";
import {
  commandsFromFriendlyChannelIntent,
  type ChannelCommand,
  type FriendlyChannelIntent
} from "./channel-intent.js";
import type { ChannelIntentResolver } from "./ai-channel-intent.js";
import { buildPromptParts, buildPromptPreview, chunkText, parsePrompt } from "./format.js";
import { PromptBuffer } from "./prompt-buffer.js";
import { NEW_SESSION_USAGE, parseNewSessionTarget } from "./new-session.js";
import { selectChannelProject } from "./project-selection.js";
import { orderSessionCatalog, sessionHostLabel, type SessionCatalogRow } from "./session-catalog-order.js";
import { compactTableCell, renderTextTable, escapeTableMarkdown, type ChannelTable } from "../channels/table.js";
import { isSessionPageSize, MIN_SESSION_PAGE_SIZE, MAX_SESSION_PAGE_SIZE } from "../state/session-list-settings.js";
import { readSessionPurposes, SessionPurposeIndex } from "../state/session-purposes.js";
import { ChannelUserInputController } from "./user-input.js";
import { TaskboardChannelController } from "./taskboard-channel-controller.js";
import {
  conciseButtonLabel,
  createCommandSelectionCard,
  createMainMenuCard
} from "./interaction-cards.js";
import type {
  CodexDynamicToolCall,
  CodexBridgeBackend,
  CodexHistoryMessage,
  CodexModelOption,
  CodexRuntimeInfo,
  CodexThreadState,
  CodexThreadGoal,
  CodexThreadGoalStatus
} from "../codex/backend.js";
import { assertCodexThreadRunnable, CodexBackendCapabilityError } from "../codex/backend.js";
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
import { ChannelTurnTextStream } from "../channels/progress.js";
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
  sessionControls?: SessionControlJournal;
  createTextStream?: (session: ManagedSession) => ChannelTurnTextStream;
  onSubscriptionsChanged?: () => Promise<void>;
  onTurnStarted?: (session: ManagedSession, turnId: string) => Promise<void> | void;
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
  cdnBaseUrl?: string;
  mediaFetch?: typeof globalThis.fetch;
  taskboard?: TaskboardClient;
  intentResolver?: ChannelIntentResolver;
  channelCapabilities?: ChannelCapabilityProvider;
  approvalTimeoutMs?: number;
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
  private readonly actor = new AsyncLocalStorage<string>();
  private readonly controls: SessionControlJournal;
  private readonly catalogControls = new SessionControlQueue();
  private readonly turnDeliveries = new SessionControlQueue();
  private readonly historyPages = new Map<string, {
    threadId: string; hostId: string; cursor?: string; exhausted: boolean; pending: CodexHistoryMessage[];
  }>();
  private readonly access: AccessController;
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
    this.access = new AccessController({
      allowedSenderIds: options.config.allowedSenderIds,
      pairedSenderIds: options.stateStore.listPairedSenderIds()
    });
    this.buffers = new PromptBuffer({
      maxItems: options.config.maxBufferItems,
      ttlMs: options.config.promptBufferTtlMs
    });
    this.approvals = new ChannelApprovalController(
      (senderId, notice) => notice.card
        ? this.replyActionCard(senderId, notice.card)
        : this.reply(senderId, notice.text),
      options.approvalTimeoutMs
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
      (senderId, card) => this.replyActionCard(senderId, card)
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

  async handleMessage(message: ChannelMessage): Promise<void> {
    return this.actor.run(message.senderId, () =>
      this.cardInteraction.run(message.interaction, () => this.handleInboundMessage(message)));
  }

  private role(conversationId: string): SessionRole {
    const actorId = this.actor.getStore() ?? conversationId;
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
    const scopedMessage = replyTargetId === message.senderId
      ? message
      : { ...message, senderId: replyTargetId };
    if (scopedMessage.contextToken) {
      this.options.stateStore.rememberContextToken(replyTargetId, scopedMessage.contextToken);
    }

    const access = this.access.requireAccess(message.senderId, replyTargetId);
    if (!access.allowed) {
      await this.reply(replyTargetId, access.message);
      return;
    }
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
    if (message.unsupportedMessageType) {
      await this.reply(replyTargetId, `当前渠道适配器尚未实现 ${message.unsupportedMessageType} 消息，请改发文字或支持的附件。`);
      return;
    }

    const channelCapabilities = await (this.options.channelCapabilities?.() ?? []);
    const slashCommand = parseCommand(scopedMessage.text, channelCapabilityAliases(channelCapabilities));
    const friendlyIntent = slashCommand
      ? undefined
      : await this.resolveFriendlyChannelIntent(
          message.senderId,
          replyTargetId,
          scopedMessage.text,
          channelCapabilities
        );
    if (friendlyIntent?.kind === "clarification") {
      await this.reply(replyTargetId, friendlyIntent.text);
      return;
    }
    const commands = slashCommand
      ? [slashCommand]
      : commandsFromFriendlyChannelIntent(friendlyIntent);
    const continueAsConversation = Boolean(
      !slashCommand && commands && friendlyCommandsContinueConversation(commands)
    );
    const deferredCommands: ChannelCommand[] = [];
    if (commands) {
      for (const command of commands) {
        if (!await this.requireRole(replyTargetId, requiredCommandRole(command.name, command.arg))) return;
        const requiredMode = requiredModeForCommand(command);
        if (requiredMode && !this.modeSettings.enabledModes.includes(requiredMode)) {
          await this.replyModeUnavailable(replyTargetId, requiredMode);
          return;
        }
        const contextRequirement = commandProjectRequirement(command);
        if (
          (contextRequirement === "required" || (contextRequirement === "session-or-project" && !this.executionSession(replyTargetId)))
          && !this.ensureBoundProjectContext(replyTargetId)
        ) {
          await this.replyProjectRequired(replyTargetId);
          return;
        }
        if (
          continueAsConversation
          && isGoalSetCommand(command)
          && !this.executionSession(replyTargetId)?.threadId
        ) {
          deferredCommands.push(command);
          continue;
        }
        await this.handleCommand(scopedMessage, command, channelCapabilities);
      }
      if (!continueAsConversation) return;
    }

    if (!this.executionSession(replyTargetId) && !this.ensureBoundProjectContext(replyTargetId)) {
      await this.replyProjectRequired(replyTargetId);
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
    for (const command of deferredCommands) {
      await this.handleCommand(scopedMessage, command, channelCapabilities);
    }
  }

  private async resolveFriendlyChannelIntent(
    actorId: string,
    conversationId: string,
    text: string,
    availableCapabilities: readonly ChannelCommandCapability[]
  ): Promise<FriendlyChannelIntent | undefined> {
    const resolver = this.options.intentResolver;
    if (!resolver || !text.trim()) return undefined;
    const projects = this.options.stateStore.listProjects();
    const activeProject = this.options.stateStore.getActiveProject(conversationId);
    const knowledgeBaseName = activeProject ? this.resolveQaContext(activeProject)?.name : undefined;
    const currentProjectName = activeProject?.name;
    const currentMode = this.options.stateStore.getInteractionMode(conversationId);
    try {
      return await resolver.resolve({
        text,
        actorId,
        conversationId,
        conversationKind: actorId === conversationId ? "direct" : "shared",
        ...(currentProjectName ? { currentProjectName } : {}),
        ...(currentMode !== "session" ? { currentMode } : {}),
        ...(knowledgeBaseName ? { knowledgeBaseName } : {}),
        ...(availableCapabilities.length ? { availableCapabilities } : {}),
        projectNames: projects.map((project) => project.name)
      });
    } catch (error) {
      if (error instanceof Error) {
        console.warn("[codex-im-gateway] AI intent classification unavailable; using ordinary chat", {
          error: error.message
        });
        return undefined;
      }
      throw error;
    }
  }

  private async handleCommand(
    message: ChannelMessage,
    command: ChannelCommand,
    channelCapabilities: readonly ChannelCommandCapability[]
  ): Promise<void> {
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
      case "help":
      case "h":
        await this.replyActionCard(message.senderId, createMainMenuCard(channelHelpText(channelCapabilities, command.arg)));
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
        await this.handleProjectCommand(message.senderId, command.arg);
        return;
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
        await this.reply(message.senderId, this.userInputs.answer(message.senderId, command.arg));
        return;
      case "new":
        await this.handleNewSessionCommand(message.senderId, command.arg);
        return;
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
      case "role":
        await this.handleInterventionSetting(message.senderId, command);
        return;
      case "intervene":
        await this.handleInterventionChoice(message, command.arg);
        return;
      case "steer":
        await this.handleSteerCommand(message, command.arg);
        return;
      case "queue":
        if (!command.arg.trim()) {
          await this.reply(message.senderId, "用法：/queue <下一轮要发送的内容>");
          return;
        }
        await this.runCodexTurn(message, command.arg.trim());
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
        this.approvals.declineAll(message.senderId);
        this.userInputs.cancelSender(message.senderId);
        let stopResult: "interrupted" | "not-active";
        {
          const session = this.executionSession(message.senderId);
          stopResult = session?.threadId
            ? await this.runner.stop(session.threadId, this.sessionHostId(session))
            : "not-active";
        }
        await this.reply(
          message.senderId,
          stopResult === "interrupted" ? "已停止当前会话正在执行的任务。" : "当前会话没有正在执行的任务。"
        );
        return;
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

  private ensureBoundProjectContext(senderId: string): boolean {
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

  private async handleNewSessionCommand(senderId: string, arg: string): Promise<void> {
    const target = parseNewSessionTarget(arg);
    const store = this.options.stateStore;
    if (target.kind === "invalid" || target.kind === "help") {
      await this.reply(senderId, `${target.kind === "invalid" ? "参数无效；指定项目和独立会话不能同时使用。\n\n" : ""}${NEW_SESSION_USAGE}`);
      return;
    }
    if (target.kind === "standalone") {
      // Never reuse the current project's cwd, and never allocate on an inferred remote host.
      fs.mkdirSync(store.standaloneWorkspacesDir, { recursive: true, mode: 0o700 });
      const workspace = fs.mkdtempSync(path.join(store.standaloneWorkspacesDir, "session-"));
      const session = store.createSession(senderId, workspace, undefined, undefined, "session", undefined, { standalone: true, hostId: "local" });
      store.setInteractionMode(senderId, "session");
      await this.reply(senderId, `已新建并绑定本机独立会话：${session.title}\n\n项目：无\n\n工作目录：${session.workspace}\n\n下一条消息将在这个新会话中开始；目录会持久保留。`);
      return;
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
      return;
    }
    if (target.kind === "current" && !await this.validateProjectRoute(senderId, project)) return;
    const session = store.createSession(senderId, project.workspace, undefined, project.id);
    store.setInteractionMode(senderId, "session");
    await this.reply(senderId, `已在${target.kind === "current" ? "当前" : "指定"}项目“${project.name}”新建并绑定会话：${session.title}\n\n主机：${project.hostId ?? "local"}\n\n工作目录：${session.workspace}\n\n下一条消息将在这个新会话中开始。`);
  }

  private async resolveSelectedProject(senderId: string, selector: string, catalog?: readonly CodexProjectCandidate[]): Promise<ManagedProject | undefined> {
    const candidates = catalog ?? await this.codexProjectCandidates();
    this.synchronizeManagedProjects(candidates);
    const projects = this.options.stateStore.listProjects();
    const selected = selectChannelProject(selector, projects, candidates, candidate => this.boundProjectForCandidate(candidate, projects));
    if (selected.error) {
      await this.reply(senderId, selected.error);
      return;
    }
    const target = selected.project ?? selected.candidate!;
    if (!await this.validateProjectRoute(senderId, target)) return;
    return selected.project ?? this.options.stateStore.createProject(target.name, target.workspace, {
      sourceProjectId: selected.candidate!.projectId,
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

  private async handleProjectCommand(senderId: string, arg: string): Promise<void> {
    const candidates = await this.codexProjectCandidates();
    this.synchronizeManagedProjects(candidates);
    // add is a compatibility alias; discovery alone never creates bindings.
    const input = arg.trim().replace(/^(?:add|a)(?:\s+|$)/i, "");
    const addMatch = /^(c[1-9]\d*)$/i.exec(input);
    if (addMatch) {
      const project = await this.resolveSelectedProject(senderId, input, candidates);
      if (!project) return;
      this.options.stateStore.activateProject(senderId, project.id);
      this.options.stateStore.setInteractionMode(senderId, "session");
      await this.reply(
        senderId,
        `已绑定并切换 Codex 项目：${project.name}${project.hostId ? `\n远程主机：${project.hostId}` : ""}\n${project.workspace}`
      );
      return;
    }
    const projects = this.options.stateStore.listProjects();
    const renameMatch = /^(?:rename|rn)\s+(.+)$/i.exec(input);
    if (renameMatch) {
      const [rawCode, name] = renameMatch[1].split("|").map((value) => value.trim());
      const match = /^p([1-9]\d*)$/i.exec(rawCode ?? "");
      const project = match ? projects[Number(match[1]) - 1] : undefined;
      if (!project || !name) {
        await this.reply(senderId, "用法：/project rename P1|新名称");
        return;
      }
      const renamed = this.options.stateStore.renameProject(project.id, name);
      await this.reply(senderId, `已重命名 Codex 项目：${renamed.name}`);
      return;
    }
    const deleteMatch = /^(?:delete|d)\s+(.+)$/i.exec(input);
    if (deleteMatch) {
      const match = /^p([1-9]\d*)$/i.exec(deleteMatch[1].trim());
      const project = match ? projects[Number(match[1]) - 1] : undefined;
      if (!project) {
        await this.reply(senderId, "用法：/project delete P1");
        return;
      }
      try {
        this.options.stateStore.deleteProject(project.id);
        await this.reply(senderId, `已移除 Codex 项目：${project.name}\n磁盘目录未删除。`);
      } catch {
        await this.reply(senderId, "项目下还有任务，请先删除或迁移任务后再移除项目。");
      }
      return;
    }
    if (!input || input.toLowerCase() === "list" || input.toLowerCase() === "l") {
      const activeProjectId = this.options.stateStore.getActiveProject(senderId)?.id;
      let nextAddIndex = 1;
      const catalogRows = candidates.map((candidate) => {
        const bound = this.boundProjectForCandidate(candidate, projects);
        const projectIndex = bound ? projects.findIndex((project) => project.id === bound.id) : -1;
        return {
          candidate,
          bound,
          projectIndex,
          addIndex: bound ? undefined : nextAddIndex++
        };
      });
      const catalogProjectIds = new Set(catalogRows.flatMap((row) => row.bound ? [row.bound.id] : []));
      const retainedProjects = projects.filter((project) => !catalogProjectIds.has(project.id));
      const fallbackText = [
        `Codex 项目：${candidates.length} 个（已绑定 ${projects.length} 个）`,
        ...catalogRows.map(({ candidate, addIndex, bound, projectIndex }) => bound
          ? `[P${projectIndex + 1}] ${bound.id === activeProjectId ? "【当前】 " : ""}${candidate.name}\n\n路径：${candidate.workspace}`
          : `[C${addIndex}] 【未绑定】 ${candidate.name}\n\n路径：${candidate.workspace}`),
        ...(retainedProjects.length
          ? ["Gateway 保留的其他项目：", ...retainedProjects.map((project) => {
            const projectIndex = projects.findIndex((item) => item.id === project.id);
            return `[P${projectIndex + 1}] ${project.id === activeProjectId ? "【当前】 " : ""}${project.name}\n\n路径：${project.workspace}`;
          })]
          : []),
        "发送 /project P1 或 /project C1 选择项目，未绑定的项目会自动绑定。也可以直接用 /sessions 选择会话。"
      ].join("\n\n");
      if (!projects.length && !candidates.length) {
        await this.replyActionCard(senderId, createChoiceCard({
          title: "选择 Codex 项目",
          body: "当前后端没有可用项目。已有会话可直接通过 /sessions 选择；CLI 项目目录来自本机会话记录。",
          fallbackText,
          choices: [{ label: "重新读取", command: "project", arg: "list", style: "primary" }]
        }));
        return;
      }
      await this.replyActionCard(senderId, createCommandSelectionCard({
        title: "选择 Codex 项目",
        body: [
          ...catalogRows.map(({ candidate, bound }) => `**${bound?.id === activeProjectId ? "当前" : bound ? "已绑定" : "未绑定"} · ${candidate.name}**\n\n路径：${candidate.workspace}`),
          ...retainedProjects.map((project) => `**${project.id === activeProjectId ? "当前" : "Bridge 保留"} · ${project.name}**\n\n路径：${project.workspace}`)
        ].join("\n\n"),
        command: "project",
        choices: [
          ...catalogRows.map(({ candidate, addIndex, bound, projectIndex }) => ({
            label: conciseButtonLabel(candidate.name),
            arg: bound ? `P${projectIndex + 1}` : `add C${addIndex}`,
            active: bound?.id === activeProjectId
          })),
          ...retainedProjects.map((project) => {
            const projectIndex = projects.findIndex((item) => item.id === project.id);
            return {
              label: conciseButtonLabel(project.name),
              arg: `P${projectIndex + 1}`,
              active: project.id === activeProjectId
            };
          })
        ],
        fallbackText
      }));
      return;
    }
    const requestedProject = /^(?:switch)\s+(.+)$/i.exec(input)?.[1]?.trim() ?? input;
    const project = await this.resolveSelectedProject(senderId, requestedProject, candidates);
    if (!project) return;
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
  }

  private async handleModeCommand(message: ChannelMessage, arg: string): Promise<void> {
    const senderId = message.senderId;
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
    if (/^(?:new|form|set)$/i.test(input)) {
      const project = this.options.stateStore.getActiveProject(senderId);
      await this.replyTaskCard(message, createGoalFormCard(project?.name ?? "当前项目"));
      return;
    }
    if (/^clear$/i.test(input)) {
      await this.runner.clearGoal(session.threadId, this.sessionHostId(session));
      await this.reply(senderId, "已清除当前 Codex 目标。");
      return;
    }
    const statusMatch = /^(pause|resume|complete)$/i.exec(input);
    if (statusMatch) {
      const status = ({ pause: "paused", resume: "active", complete: "complete" } as const)[
        statusMatch[1].toLowerCase() as "pause" | "resume" | "complete"
      ];
      const goal = await this.runner.setGoal(session.threadId, { status }, this.sessionHostId(session));
      await this.replyGoalCard(message, goal);
      return;
    }
    const setMatch = /^(?:set\s+)?(.+)$/is.exec(input);
    if (setMatch && input) {
      const objective = setMatch[1].trim();
      const goal = await this.runner.setGoal(
        session.threadId,
        { objective, status: "active" },
        this.sessionHostId(session)
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
    const project = this.options.stateStore.getActiveProject(senderId);
    const standalone = this.options.stateStore.getActiveSession(senderId);
    if (!project) return standalone?.projectBinding === "none" ? standalone : undefined;
    const mode = this.options.stateStore.getInteractionMode(senderId);
    const session = mode === "qa"
      ? this.options.stateStore.getActiveQaSession(senderId)
      : this.options.stateStore.getActiveSession(senderId);
    if (session?.projectId !== project.id) return undefined;
    if (mode === "qa" && session.knowledgeBaseId !== this.resolveQaContext(project)?.id) return undefined;
    return session;
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
      await this.reply(senderId, "用法：/sessions detail R1 查看详情，不会切换会话。先发送 /sessions 获取编号。"); return;
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
        await this.reply(senderId, "会话列表已过期，请发送 /sessions 刷新后重新选择。"); return;
      }
      if (detail) {
        const row = listing.rows[Number(detail[1]) - 1];
        if (!row) { await this.reply(senderId, "没有这个编号，请查看 /sessions。"); return; }
        const { state, hostId, group } = row;
        await this.reply(senderId, [
          `会话详情 · R${detail[1]}（列表快照，不切换会话）`,
          `标题：${compactTableCell(state.title ?? state.preview ?? "未命名", 400)}`,
          `归属：${group?.name ?? "无项目"}${state.workspaceProjectId && !state.projectId ? "（CLI 工作目录分组，非原生项目绑定）" : ""}`,
          `主机：${hostId}`, `目录：${state.cwd}`, `ID：${state.threadId}`,
          `状态：${projectSessionChoiceStateLabel({ title: state.title ?? "", updatedAt: state.updatedAt ?? "", candidate: codexThreadStateCandidate(state, state.cwd ?? "") })}`,
          `更新：${state.updatedAt ? formatSessionTime(state.updatedAt) : "时间未知"}`,
          `继续此会话：/session R${detail[1]}`
        ].join("\n\n"));
        return;
      }
      if (numbered) {
        const row = listing.rows[Number(numbered[1]) - 1];
        if (!row) { await this.reply(senderId, "没有这个编号，请查看 /sessions。"); return; }
        await this.bindCatalogSession(senderId, row.state.threadId, row.hostId); return;
      }
      const requested = /^page\s+(\d+)$/i.exec(input);
      if (!resized) listing.page = requested ? Number(requested[1]) - 1 : listing.page + (/^prev$/i.test(input) ? -1 : 1);
      listing.page = Math.min(Math.max(0, Math.ceil(listing.rows.length / listing.pageSize) - 1), Math.max(0, listing.page));
    } else if (input && !/^(all|unbound|unassigned|project|search\s+.+)$/i.test(input)) {
      const direct = /^(\S+)(?:\s+--host\s+(\S+))?$/.exec(input);
      if (!direct) { await this.reply(senderId, "用法：/sessions [all|unbound|project|search 关键词|more|prev]；/session <会话ID> [--host 主机ID]"); return; }
      await this.bindCatalogSession(senderId, direct[1], direct[2] ?? "local"); return;
    } else {
      const activeProject = this.options.stateStore.getActiveProject(senderId);
      const projectOnly = input.toLowerCase() === "project";
      if (projectOnly && !activeProject) { await this.reply(senderId, "当前没有选择项目。发送 /sessions 查看全部会话，或 /project 选择项目。"); return; }
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
        for (const p of this.options.stateStore.listProjects()) if (p.hostId) hosts.add(p.hostId);
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
            if (state.persistence !== "active" || state.internal || state.runtimeStatus === "systemError" || !state.cwd || (unassigned && state.projectId)) continue;
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
      return [`R${start + index + 1}`, compactTableCell(`${current ? "【当前】 " : ""}${name}`, 28),
        group?.label ?? `无项目${hostId !== "local" ? ` · ${compactTableCell(sessionHostLabel(hostId), 15)}` : ""}`,
        status.replace("Desktop 已打开", "已打开").replace("上次执行失败", "上次失败").replace("上次已停止", "已停止").replace("状态未知", "未知")];
    }) };
    const body = [...(!pageRows.length ? ["没有符合条件的未归档会话。"] : []), ...listing.warnings].join("\n\n");
    const note = `按项目分组 · 组内最近更新优先 · 每页 ${listing.pageSize} 条\n选择 /session R编号 · 详情 /sessions detail R编号\n翻页 /sessions more|prev · 条数 /sessions size 50`;
    const text = [title, body, renderTextTable(table), note].filter(Boolean).join("\n\n");
    await this.replyActionCard(senderId, createChoiceCard({ title, body: escapeTableMarkdown(body), ...(pageRows.length ? { table } : {}), note, fallbackText: text,
      choices: [...pageRows.map(({state,hostId}, i): ChannelChoice => ({ label: `R${start+i+1}`, command: "session", arg: `${state.threadId} --host ${hostId}` })),
        ...(listing.page > 0 ? [{ label: "上一页", command: "sessions" as const, arg: "prev" }] : []),
        ...(start + listing.pageSize < listing.rows.length ? [{ label: "下一页", command: "sessions" as const, arg: "more" }] : [])] }));
  }

  private async bindCatalogSession(senderId: string, threadId: string, hostId: string): Promise<void> {
    if (!await this.requireRole(senderId, "participant")) return;
    const state = await this.runner.inspectThread(threadId, hostId);
    const reason = unavailableProjectSessionChoiceReason({ title: state.title ?? threadId, updatedAt: state.updatedAt ?? "", candidate: codexThreadStateCandidate(state, state.cwd ?? "") });
    if (state.persistence !== "active" || state.internal || reason) { await this.reply(senderId, reason ?? "此会话不可绑定，请选择未归档的普通会话。"); return; }
    if (!state.cwd || !path.isAbsolute(state.cwd)) { await this.reply(senderId, "该会话没有可确认的工作目录，未建立绑定。"); return; }
    const store = this.options.stateStore;
    const existing = store.listSessions().find(s => s.senderId === senderId && s.mode !== "qa" && s.threadId === threadId && this.sessionHostId(s) === hostId);
    let project = state.projectId ? store.listProjects().find(p => (p.hostId ?? "local") === hostId && (p.sourceProjectId === state.projectId || p.workspace === state.cwd)) : undefined;
    if (!project && state.projectId) {
      project = store.createProject(path.basename(state.cwd), state.cwd, { sourceProjectId: state.projectId, hostId, projectKind: hostId === "local" ? "local" : "remote" });
    }
    const session = existing ? store.activateSession(existing.id) : store.createSession(senderId, state.cwd, state.title || `会话 ${threadId.slice(0,8)}`, project?.id, "session", undefined, { standalone: !project, hostId });
    if (!existing) store.setSessionThread(session.id, threadId);
    store.setSessionFollow(session.id, this.runner.backendInfo?.(hostId).capabilities.liveFollow ?? this.options.config.codexBackend !== "exec");
    store.setInteractionMode(senderId, "session");
    await this.options.onSubscriptionsChanged?.();
    await this.reply(senderId, `已绑定会话：${session.title}\n\n主机：${hostId}\n\n工作目录：${state.cwd}\n\n下一条消息将继续这个会话；/history 查看历史，/leave 退出绑定。`);
    await this.handleHistoryCommand(senderId, "6");
  }


  private async handleHistoryCommand(senderId: string, arg: string): Promise<void> {
    const session = this.executionSession(senderId);
    if (!session?.threadId) {
      await this.reply(senderId, "当前会话还没有 Codex 历史。先发送一条消息，或使用 /sessions 绑定已有会话。");
      return;
    }
    const more = arg.trim().toLowerCase() === "more";
    const requested = more || !arg.trim() ? 8 : Number(arg.trim());
    if (!Number.isInteger(requested) || requested < 1 || requested > 20) {
      await this.reply(senderId, "用法：/history [1-20|more]，例如 /history 10；/history more 查看更早的对话。");
      return;
    }
    const hostId = this.sessionHostId(session) ?? "local";
    let page = this.historyPages.get(senderId);
    if (!more || !page || page.threadId !== session.threadId || page.hostId !== hostId) {
      page = { threadId: session.threadId, hostId, exhausted: false, pending: [] };
      this.historyPages.set(senderId, page);
    }
    for (let reads = 0; page.pending.length < requested && !page.exhausted && reads < 10; reads++) {
      if (typeof this.runner.getHistoryPage === "function") {
        try {
          const response = await this.runner.getHistoryPage(session.threadId, {
            cursor: page.cursor, limit: 10, sortDirection: "desc"
          }, hostId);
          page.pending.push(...visibleConversationHistory(response.messages).reverse());
          page.exhausted = !response.nextCursor || response.nextCursor === page.cursor;
          page.cursor = response.nextCursor;
          continue;
        } catch (error) {
          if (!/unsupported|method not found|unknown method|not implemented/i.test(String(error))) throw error;
        }
      }
      page.pending.push(...visibleConversationHistory(await this.runner.getHistory(session.threadId, hostId)).reverse());
      page.exhausted = true;
    }
    const visible = page.pending.splice(0, requested).reverse();
    await this.reply(senderId, visible.length
      ? [`会话“${session.title}”${more ? "更早的" : "最近"} ${visible.length} 条对话：`,
          formatConversationHistory(visible),
          !page.exhausted || page.pending.length ? "发送 /history more 查看更早的对话。" : "已到达最早的对话。"].join("\n\n")
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
    const state = await this.runner.inspectThread(session.threadId, hostId);
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
      await this.reply(message.senderId, "目标任务已结束或发生切换，未发送这条介入。请查看 /history 后重新发送。");
      return;
    }
    const result = await this.controls.steer(
      JSON.stringify([hostId ?? "local", session.threadId]),
      JSON.stringify([session.id, message.senderId, this.actor.getStore(), message.id]),
      () => this.runner.steer({
      threadId: session.threadId!,
      expectedTurnId: state.activeTurnId,
      prompt,
      cwd: session.workspace,
      clientUserMessageId: message.id
    }, hostId));
    this.options.stateStore.setSessionPromptPreview(session.id, prompt);
    await this.reply(message.senderId, [
      "已介入当前正在执行的 Codex 任务。",
      `Turn：${result.turnId}`,
      `补充要求：${boundedProgressText(prompt, 800)}`
    ].join("\n"));
  }

  private async handleInterventionSetting(senderId: string, command: ChannelCommand): Promise<void> {
    const arg = command.arg.trim();
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
    const session = this.options.stateStore.getActiveSession(senderId);
    if (!session) { await this.reply(senderId, "请先使用 /sessions 选择会话。"); return; }
    if (command.name === "leave") {
      this.options.stateStore.leaveSession(senderId);
      this.historyPages.delete(senderId);
      await this.options.onSubscriptionsChanged?.();
      await this.reply(senderId, "已退出会话并停止跟随；任务继续运行。");
      return;
    }
    if (command.name === "follow") {
      if (arg && arg !== "on" && arg !== "off") {
        await this.reply(senderId, "用法：/follow [on|off]");
        return;
      }
      if (arg !== "off") this.assertSessionCapability(senderId, "liveFollow");
      if (arg) this.options.stateStore.setSessionFollow(session.id, arg === "on");
      await this.options.onSubscriptionsChanged?.();
      await this.reply(senderId, "实时跟随：" + (arg ? arg === "on" ? "已开启" : "已关闭" : session.follow === false ? "已关闭" : "已开启") + "。");
      return;
    }
    if (arg && !["ask", "steer", "queue"].includes(arg)) {
      await this.reply(senderId, "用法：/policy [ask|steer|queue]");
      return;
    }
    if (arg) this.options.stateStore.setActiveMessagePolicy(session.id, arg as "ask" | "steer" | "queue");
    await this.reply(senderId, "运行中消息处理方式：" + (arg || session.activeMessagePolicy || "ask") + "（ask 询问，steer 介入，queue 排队）。");
  }

  private async handleActiveMessage(message: ChannelMessage, items: PromptBufferItem[]): Promise<boolean> {
    const session = this.executionSession(message.senderId);
    if (!session?.threadId || session.mode === "qa" || session.activeMessagePolicy === "queue") return false;
    if (this.options.config.codexBackend === "exec" || typeof this.runner.inspectThread !== "function") return false;
    const hostId = this.sessionHostId(session);
    const state = await this.runner.inspectThread(session.threadId, hostId);
    if (state.runtimeStatus !== "active" || !state.activeTurnId) return false;
    const prompt = buildPromptParts("", items, "WeChat", []).prompt;
    if (session.activeMessagePolicy === "steer") {
      await this.handleSteerCommand(message, prompt, state.activeTurnId);
      return true;
    }
    const choice = this.controls.createChoice({
      actorId: this.actor.getStore() ?? message.senderId, conversationId: message.senderId,
      sessionId: session.id, threadId: session.threadId, hostId: hostId ?? "local",
      turnId: state.activeTurnId, prompt, items
    });
    await this.replyActionCard(message.senderId, createChoiceCard({
      title: "当前任务正在执行",
      body: "如何处理这条新消息？\n\n" + boundedProgressText(buildPromptPreview("", items) ?? "", 500),
      choices: [
        { label: "介入当前任务", command: "intervene", arg: choice.id + " steer", style: "primary" },
        { label: "排到下一轮", command: "intervene", arg: choice.id + " queue" },
        { label: "取消", command: "intervene", arg: choice.id + " cancel" }
      ],
      fallbackText: "发送 /intervene " + choice.id + " steer 介入，queue 排队，cancel 取消。"
    }));
    return true;
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
    else await this.runCodexTurn({ ...message, id: choice.id }, "", choice.items);
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
    const models = await this.listCodexModels();
    const input = arg.trim();
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
        choices: models.map((model, index) => ({
          label: conciseButtonLabel(model.displayName),
          arg: String(index + 1),
          active: model.model === runtime.model
        })),
        includeDefault: true,
        fallbackText: lines.join("\n")
      }));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.updateExecutionRuntime(senderId, { model: null });
      const runtime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 模型设置。\n当前模型：${runtime.model ?? "Codex 默认"}`);
      return;
    }

    const selected = selectModel(models, input);
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
        choices: efforts.map((effort, index) => ({
          label: conciseButtonLabel(formatEffort(effort)),
          arg: String(index + 1),
          active: effort === runtime.effort
        })),
        includeDefault: true,
        fallbackText
      }));
      return;
    }
    if (input.toLowerCase() === "default") {
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
    const forgetMatch = /^(?:forget|f)\s+k([1-9]\d*)$/i.exec(input);
    if (forgetMatch) {
      const entry = entries[Number(forgetMatch[1]) - 1];
      if (!entry) {
        await this.replyActionCard(senderId, createChoiceCard({
          title: "知识条目不存在",
          body: "该条目可能已经被删除，请刷新知识库。",
          fallbackText: "没有这个知识编号。发送 /memory 查看当前知识库。",
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
        fallbackText: "用法：/memory、/memory on、/memory off、/memory forget K编号、/memory clear",
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
      "删除单条：/memory forget K编号"
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
      arg: `forget K${index + 1}`,
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
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      return items;
    }
    try {
      const rootDir = this.options.inboundDir ?? path.join(this.options.config.defaultCwd, ".codex-im-gateway-inbound");
      const downloaded = validateLocalAttachments(await this.channel.resolveAttachments(message), rootDir, this.options.config.maxInboundBytes);
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
        return message.text.trim() ? [{ kind: "text", text: message.text }] : undefined;
      }
      throw error;
    }
  }

  private async runCodexTurn(message: ChannelMessage, text: string, attachments: PromptBufferItem[] = []): Promise<void> {
    const activeProject = this.options.stateStore.getActiveProject(message.senderId);
    const activeSession = this.options.stateStore.getActiveSession(message.senderId);
    const standalone = !activeProject && activeSession?.projectBinding === "none" ? activeSession : undefined;
    if (!activeProject && !standalone) throw new Error("请先发送 /sessions 选择会话，或 /project 选择项目。");
    // Turn execution must not wait for a fresh catalog request. Account start
    // and project/session selection already establish the execution context.
    const project = standalone ? undefined : activeProject;
    const mode = this.options.stateStore.getInteractionMode(message.senderId);
    const qaContext = mode === "qa" && project ? this.resolveQaContext(project) : undefined;
    if (mode === "qa" && !qaContext) throw new Error("Current project has no available llm-wiki knowledge base");
    const session = standalone ?? (mode === "qa"
      ? this.ensureQaSession(message.senderId, project!, qaContext as ManagedKnowledgeBase)
      : this.ensureConversationSession(message.senderId, project!));
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
      assertCodexThreadRunnable(await this.runner.inspectThread(threadId, this.sessionHostId(session)));
    }
    const progressEnabled = session.streamReplies ?? this.options.config.streamReplies;
    const sentProgress = new Set<string>();
    const replyStream = progressEnabled
      ? this.options.createTextStream?.(session) ?? new ChannelTurnTextStream(this.channel, message.senderId, {
        save: () => undefined, contextToken: this.options.stateStore.getContextToken(message.senderId),
        onTextDelivered: (part) => this.options.onOutboundMessage?.({ direction: "outbound", id: part.messageId,
          recipientId: message.senderId, text: part.text, attachments: [] })
      })
      : undefined;
    let streamedAnswer = "";
    this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: true });
    try {
      await this.withTyping(message.senderId, async () => {
        console.log(`[codex-im-gateway] starting Codex turn for ${message.senderId} in ${workspace}`);
        if (replyStream?.supported) await replyStream.progress("🤔 正在理解任务并规划下一步…");
        const knowledge = this.options.stateStore.relevantKnowledge(promptPreview ?? text, session.projectId);
        const promptParts = buildPromptParts(text, attachments, channelPromptSource(this.channel.channel), knowledge);
        const result = await this.runner.run({
          prompt: qaContext ? buildQaPrompt(promptParts.prompt, project!, qaContext) : promptParts.prompt,
          developerInstructions: promptParts.developerInstructions,
          cwd: workspace,
          hostId: this.sessionHostId(session),
          projectId: project?.sourceProjectId,
          projectName: project?.name,
          projectBinding: session.projectBinding,
          threadId,
          threadTitle: preferredThreadTitle(session.title, promptPreview),
          onThreadCreated: (createdThreadId) => {
            this.options.stateStore.setSessionThread(session.id, createdThreadId);
          },
          onTurnStarted: ({ threadId: startedThreadId, turnId }) => {
            session.threadId = startedThreadId;
            this.options.stateStore.setSessionThread(session.id, startedThreadId);
            return this.options.onTurnStarted?.(session, turnId);
          },
          queueKey: threadId ?? session.id,
          model: session.model ?? this.options.config.model,
          effort: session.effort ?? this.options.config.effort,
          collaborationMode: session.collaborationMode === "plan" ? "plan" : undefined,
          ...(qaContext ? {
            dynamicTools: llmWikiDynamicTools(),
            onDynamicToolCall: (call: CodexDynamicToolCall) => this.handleKnowledgeToolCall(qaContext, call)
          } : {}),
          ...(progressEnabled ? {
            ...(replyStream?.supported ? {
              onDelta: async (delta: string) => {
                streamedAnswer += delta;
                const visible = visibleStreamingAnswer(streamedAnswer);
                if (visible) await replyStream.answer(visible);
              }
            } : {}),
            onProgress: async (progress: string) => {
              const progressText = progress.trim();
              if (!progressText || sentProgress.has(progressText)) return;
              sentProgress.add(progressText);
              if (sentProgress.size > 200) sentProgress.clear();
              await replyStream?.progress(progressText);
            }
          } : {}),
          onApproval: (request: CodexApprovalRequest) => this.approvals.request(message.senderId, request),
          onUserInput: (request) => this.userInputs.request(message.senderId, request)
        });
        console.log(`[codex-im-gateway] Codex turn completed for ${message.senderId}; text=${result.text.length} chars`);
        if (result.threadId) {
          this.options.stateStore.setSessionThread(session.id, result.threadId);
        }
        const parsed = parseActionBlocks(result.text);
        for (const memory of parsed.actions.remember) {
          this.options.stateStore.rememberKnowledge(memory, session.projectId, session.id);
        }
        const remaining = chunkText(parsed.visibleText);
        const streamed = replyStream
          ? await replyStream.finalize(parsed.visibleText.trim() || "处理完成。")
          : false;
        if (remaining.length && !streamed) {
          for (const chunk of remaining) {
            await this.reply(message.senderId, chunk);
          }
        }
        for (const action of parsed.actions.send) {
          await this.sendLocalMedia(message.senderId, action);
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
      const failureWasReported = await replyStream?.fail(
        stripBridgeErrorPrefix(userFacingMessageHandlingError(error))
      ) ?? false;
      if (failureWasReported) markMessageHandlingErrorReported(error);
      await this.options.onTurnCompleted?.({
        senderId: message.senderId,
        sessionId: session.id,
        text: error instanceof Error ? error.message : String(error),
        success: false
      });
      throw error;
    } finally {
      this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: false });
    }
    });
  }

  private async codexProjectCandidates(): Promise<readonly CodexProjectCandidate[]> {
    return await this.options.listCodexProjects?.() ?? projectCandidatesFromBackendCatalog(await this.runner.listProjects());
  }

  private boundProjectForCandidate(
    candidate: CodexProjectCandidate,
    projects = this.options.stateStore.listProjects()
  ): ManagedProject | undefined {
    const candidateHost = candidate.hostId ?? "local";
    return projects.find((project) => (
      Boolean(candidate.projectId && project.sourceProjectId === candidate.projectId)
      && (project.hostId ?? "local") === candidateHost
    )) ?? projects.find((project) => (
      path.resolve(project.workspace) === path.resolve(candidate.workspace)
      && (project.hostId ?? "local") === candidateHost
    ));
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
    const candidate = candidates.find((item) => (
        path.resolve(item.workspace) === path.resolve(project.workspace)
        && (item.hostId ?? "local") === (project.hostId ?? "local")
      ));
    if (!candidate?.projectId) return project;
    if (
      project.sourceProjectId === candidate.projectId
      && project.projectKind === candidate.projectKind
      && project.hostId === candidate.hostId
    ) return project;
    return this.options.stateStore.updateProjectMetadata(project.id, {
      sourceProjectId: candidate.projectId,
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

  private async sendLocalMedia(senderId: string, action: { type: "image" | "file" | "video"; path: string }): Promise<void> {
    try {
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
    let issue: TaskboardIssue | undefined;
    if (project && session?.threadId && this.options.taskboard) {
      try {
        const taskboardProject = await this.options.taskboard.projectForWorkspace(project.workspace);
        issue = taskboardProject
          ? await this.options.taskboard.issueForThread(taskboardProject.id, session.threadId)
          : undefined;
      } catch (error) {
        console.warn(`Taskboard context unavailable for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const runtime = await this.effectiveRuntime(senderId);
    return [
      "当前工作上下文",
      `项目：${project?.name ?? "尚未选择"}`,
      `模式：${formatInteractionMode(mode)}`,
      `问答知识库：${knowledgeBase?.name ?? "未绑定"}`,
      `任务：${issue ? `${issue.identifier} · ${formatTaskboardStatus(issue.status)} · ${issue.title}` : "尚未绑定 Taskboard Issue"}`,
      `会话：${session?.title ?? "新会话"}`,
      `对话状态：${session?.collaborationMode === "plan" ? "计划协作" : "普通对话（未附加模式）"}`,
      `工作目录：${workspace}`,
      `thread：${session?.threadId || "尚未创建"}`,
      `backend：${this.options.config.codexBackend}`,
      `app-server transport：${this.options.config.codexAppServerTransport}`,
      `exec sandbox：${this.options.config.codexExecSandbox ?? "Codex 默认"}`,
      `model: ${runtime.model ?? "(Codex default)"}`,
      `effort: ${runtime.effort ?? "(Codex default)"}`,
      `过程回复：${(session?.streamReplies ?? this.options.config.streamReplies) ? "开启" : "关闭"}${typeof session?.streamReplies === "boolean" ? "（当前会话）" : "（全局）"}`
    ].join("\n");
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
      this.options.onOutboundMessage?.({
        direction: "outbound",
        id: sent.messageId,
        recipientId: senderId,
        text,
        attachments: []
      });
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
      for (const text of chunkText(card.fallbackText)) {
        await this.reply(senderId, text);
      }
    }
  }

  private async replyTaskCard(message: ChannelMessage, card: ChannelTaskCard): Promise<void> {
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
    this.access.allow(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  removeSender(senderId: string): void {
    this.access.remove(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  listAllowedSenders(): string[] {
    return this.access.listPairedSenderIds();
  }

  requestApproval(senderId: string, request: CodexApprovalRequest): Promise<CodexApprovalDecision> {
    return this.approvals.request(senderId, request);
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
    return parseActionBlocks(value).visibleText.trim();
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

function preferredThreadTitle(sessionTitle: string, promptPreview?: string): string {
  const genericSessionTitle = /^(?:会话\s*\d+|新会话|Codex 会话(?:\s+[\da-f-]+)?)$/i.test(sessionTitle.trim());
  return (genericSessionTitle ? promptPreview : sessionTitle) ?? promptPreview ?? sessionTitle;
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
