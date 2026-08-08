import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

import { AccessController } from "./access.js";
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
import { buildPrompt, buildPromptPreview, chunkText, parsePrompt } from "./format.js";
import { PromptBuffer } from "./prompt-buffer.js";
import { ChannelUserInputController } from "./user-input.js";
import { TaskboardChannelController } from "./taskboard-channel-controller.js";
import {
  conciseButtonLabel,
  createCommandSelectionCard,
  createMainMenuCard
} from "./interaction-cards.js";
import type {
  CodexDynamicToolCall,
  CodexModelOption,
  CodexRuntimeInfo,
  CodexThreadGoal,
  CodexThreadGoalStatus
} from "../codex/app-server-runner.js";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../codex/approval.js";
import { HybridCodexRunner } from "../codex/runner.js";
import {
  LlmWikiMcpClientPool,
  llmWikiDynamicTools
} from "../knowledge/llm-wiki-mcp-client.js";
import type { CodexWeixinConfig } from "../state/config.js";
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
  listCodexProjectCandidates,
  listCodexSessionCandidates,
  type CodexProjectCandidate,
  type CodexSessionCandidate
} from "../server/codex-projects.js";
import { WeixinApiClient, isStaleContextError, type FetchLike } from "../weixin/api.js";
import { downloadInboundAttachments, InboundMediaTooLargeError, sendLocalMediaFile } from "../weixin/media.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { OutboundChannelMessage } from "../webhooks/channel-message-webhook.js";
import type { PromptBufferItem } from "./prompt-buffer.js";
import { formatAccountBalance, type CodexAccountBalance } from "../codex/account-balance.js";
import type { ChannelTextClient } from "../channels/types.js";
import {
  createChoiceCard,
  type ChannelActionCard,
  type ChannelChoice
} from "../channels/action-card.js";
import { createGoalFormCard } from "../channels/goal-form-card.js";
import { formatTaskboardStatus, type ChannelTaskCard } from "../channels/task-card.js";
import type { TaskboardClient, TaskboardIssue } from "../taskboard/client.js";

export { parseCommand } from "./channel-commands.js";

const RECENT_PROJECT_SESSION_LIMIT = 10;

type ProjectSessionChoice = {
  managed?: ManagedSession;
  candidate?: CodexSessionCandidate;
  title: string;
  updatedAt: string;
};

export type BridgeServiceOptions = {
  config: CodexWeixinConfig;
  stateStore: RuntimeStateStore;
  weixin: ChannelTextClient;
  runner?: HybridCodexRunner;
  listCodexModels?: () => Promise<CodexModelOption[]>;
  getCodexBalance?: () => Promise<CodexAccountBalance>;
  llmWiki?: LlmWikiMcpClientPool;
  modeSettings?: ChannelModeSettings;
  listCodexProjects?: () => readonly CodexProjectCandidate[];
  listCodexSessions?: (workspace: string) => readonly CodexSessionCandidate[];
  inboundDir?: string;
  mediaFetch?: FetchLike;
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
  private readonly access: AccessController;
  private readonly buffers: PromptBuffer;
  private readonly runner: HybridCodexRunner;
  private readonly approvals: ChannelApprovalController;
  private readonly taskboardController: TaskboardChannelController;
  private readonly llmWiki: LlmWikiMcpClientPool;
  private readonly userInputs: ChannelUserInputController;
  private readonly cardInteraction = new AsyncLocalStorage<NormalizedWeixinMessage["interaction"]>();
  private modeSettings: ChannelModeSettings;

  constructor(private readonly options: BridgeServiceOptions) {
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
    this.runner = options.runner ?? new HybridCodexRunner({
      backend: options.config.codexBackend,
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

  async handleMessage(message: NormalizedWeixinMessage): Promise<void> {
    return this.cardInteraction.run(message.interaction, () => this.handleInboundMessage(message));
  }

  private async handleInboundMessage(message: NormalizedWeixinMessage): Promise<void> {
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
        const requiredMode = requiredModeForCommand(command);
        if (requiredMode && !this.modeSettings.enabledModes.includes(requiredMode)) {
          await this.replyModeUnavailable(replyTargetId, requiredMode);
          return;
        }
        if (
          commandProjectRequirement(command) === "required"
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

    if (!this.ensureBoundProjectContext(replyTargetId)) {
      await this.replyProjectRequired(replyTargetId);
      return;
    }

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
        console.warn("[codex-channel-bridge] AI intent classification unavailable; using ordinary chat", {
          error: error.message
        });
        return undefined;
      }
      throw error;
    }
  }

  private async handleCommand(
    message: NormalizedWeixinMessage,
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
        await this.replyActionCard(message.senderId, createMainMenuCard(channelHelpText(channelCapabilities)));
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
        {
          const project = this.options.stateStore.getActiveProject(message.senderId);
          if (!project) {
            await this.replyActionCard(message.senderId, createChoiceCard({
              title: "先选择项目",
              body: "新会话需要归属到一个 Codex 项目。",
              fallbackText: "请先选择一个项目，再新建会话。",
              choices: [{ label: "选择项目", command: "project", arg: "list", style: "primary" }]
            }));
            return;
          }
          const session = this.options.stateStore.createSession(
            message.senderId,
            project.workspace,
            undefined,
            project.id
          );
          this.options.stateStore.setInteractionMode(message.senderId, "session");
          await this.reply(
            message.senderId,
            `已在当前项目“${project.name}”新建并绑定会话：${session.title}\n下一条消息将在这个新会话中开始。`
          );
        }
        return;
      case "session":
      case "sessions":
        await this.handleSessionCommand(message.senderId, command.arg);
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
        await this.runner.stop(this.executionSession(message.senderId)?.threadId);
        await this.reply(message.senderId, "Stop signal sent.");
        return;
      default:
        await this.replyActionCard(message.senderId, createMainMenuCard(
          `未知命令：/${command.name}。发送 /help 查看可用命令。`
        ));
    }
  }

  private async replyProjectRequired(senderId: string): Promise<void> {
    const fallbackText = "还没有绑定 Codex 项目。发送 /project add 查看 Codex 历史项目，再用 /project add C编号 添加。";
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

  private async handleProjectCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim();
    const addMatch = /^(?:add|a)(?:\s+(.*))?$/i.exec(input);
    if (addMatch) {
      const existingWorkspaces = new Set(
        this.options.stateStore.listProjects().map((project) => path.resolve(project.workspace))
      );
      const candidates = (this.options.listCodexProjects?.() ?? listCodexProjectCandidates())
        .filter((candidate) => !existingWorkspaces.has(path.resolve(candidate.workspace)));
      const rawCode = addMatch[1]?.trim() ?? "";
      const match = /^c([1-9]\d*)$/i.exec(rawCode);
      const candidate = match ? candidates[Number(match[1]) - 1] : undefined;
      if (!candidate) {
        if (candidates.length === 0) {
          await this.reply(senderId, "没有可添加的 Codex 历史项目。请先在 Codex 中打开项目并创建任务。");
          return;
        }
        const fallbackText = [
          "从 Codex 历史项目中选择：",
          ...candidates.map((item, index) =>
            `[C${index + 1}] ${item.name}（${item.sessionCount} 个会话）\n${item.workspace}`
          ),
          "发送 /project add C编号 添加，例如：/project add C1"
        ].join("\n");
        await this.replyActionCard(senderId, createCommandSelectionCard({
          title: "添加 Codex 项目",
          body: candidates.map((item) => `**${item.name}** · ${item.sessionCount} 个会话\n${item.workspace}`).join("\n\n"),
          command: "project",
          choices: candidates.map((item, index) => ({
            label: conciseButtonLabel(item.name),
            arg: `add C${index + 1}`
          })),
          fallbackText
        }));
        return;
      }
      const project = this.options.stateStore.createProject(candidate.name, candidate.workspace);
      await this.reply(senderId, `已添加 Codex 项目：${project.name}\n${project.workspace}`);
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
      const fallbackText = (projects.length
        ? ["已绑定的 Codex 项目：", ...projects.map((project, index) =>
          `[P${index + 1}] ${project.id === activeProjectId ? "【当前】" : ""}${project.name}\n   ${project.workspace}`
        ), "", "发送 /project P1 切换项目。"]
        : ["还没有绑定 Codex 项目。", "发送 /project add 查看可从 Codex 历史添加的项目。"]).join("\n");
      if (!projects.length) {
        await this.replyActionCard(senderId, createChoiceCard({
          title: "选择 Codex 项目",
          body: "还没有绑定项目，可以从 Codex 历史记录中添加。",
          fallbackText,
          choices: [{ label: "添加历史项目", command: "project", arg: "add", style: "primary" }]
        }));
        return;
      }
      await this.replyActionCard(senderId, createCommandSelectionCard({
        title: "选择 Codex 项目",
        body: projects.map((project) => `${project.id === activeProjectId ? `**当前 · ${project.name}**` : `**${project.name}**`}\n${project.workspace}`).join("\n\n"),
        command: "project",
        choices: projects.map((project, index) => ({
          label: conciseButtonLabel(project.name),
          arg: `P${index + 1}`,
          active: project.id === activeProjectId
        })),
        fallbackText
      }));
      return;
    }
    const requestedProject = /^(?:switch)\s+(.+)$/i.exec(input)?.[1]?.trim() ?? input;
    const match = /^p([1-9]\d*)$/i.exec(requestedProject);
    const nameMatches = match ? [] : projects.filter((candidate) => (
      candidate.name.localeCompare(requestedProject, undefined, { sensitivity: "accent" }) === 0
    ));
    if (nameMatches.length > 1) {
      const fallbackText = "有多个同名项目，请发送 /project 查看列表，再用 P 编号切换。";
      await this.replyActionCard(senderId, createChoiceCard({
        title: "需要选择具体项目",
        body: "找到多个同名项目，请从完整项目列表中选择。",
        fallbackText,
        choices: [{ label: "查看项目列表", command: "project", arg: "list", style: "primary" }]
      }));
      return;
    }
    const project = match ? projects[Number(match[1]) - 1] : nameMatches[0];
    if (!project) {
      const fallbackText = "没有找到这个项目。发送 /project 查看项目列表，可用 P 编号或完整项目名切换。";
      await this.replyActionCard(senderId, createChoiceCard({
        title: "没有找到项目",
        body: `未找到“${requestedProject}”，可以重新选择。`,
        fallbackText,
        choices: [{ label: "查看项目列表", command: "project", arg: "list", style: "primary" }]
      }));
      return;
    }
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

  private async handleModeCommand(message: NormalizedWeixinMessage, arg: string): Promise<void> {
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

  private async handleGoalCommand(message: NormalizedWeixinMessage, arg: string): Promise<void> {
    const senderId = message.senderId;
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
      await this.runner.clearGoal(session.threadId);
      await this.reply(senderId, "已清除当前 Codex 目标。");
      return;
    }
    const statusMatch = /^(pause|resume|complete)$/i.exec(input);
    if (statusMatch) {
      const status = ({ pause: "paused", resume: "active", complete: "complete" } as const)[
        statusMatch[1].toLowerCase() as "pause" | "resume" | "complete"
      ];
      const goal = await this.runner.setGoal(session.threadId, { status });
      await this.replyGoalCard(message, goal);
      return;
    }
    const setMatch = /^(?:set\s+)?(.+)$/is.exec(input);
    if (setMatch && input) {
      const objective = setMatch[1].trim();
      const goal = await this.runner.setGoal(session.threadId, { objective, status: "active" });
      await this.replyGoalCard(message, goal);
      return;
    }
    await this.replyGoalCard(message, await this.runner.getGoal(session.threadId));
  }

  private async replyGoalCard(message: NormalizedWeixinMessage, goal: CodexThreadGoal | undefined): Promise<void> {
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
    if (!project) return undefined;
    const mode = this.options.stateStore.getInteractionMode(senderId);
    const session = mode === "qa"
      ? this.options.stateStore.getActiveQaSession(senderId)
      : this.options.stateStore.getActiveSession(senderId);
    if (session?.projectId !== project.id) return undefined;
    if (mode === "qa" && session.knowledgeBaseId !== this.resolveQaContext(project)?.id) return undefined;
    return session;
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
    const activeSession = this.options.stateStore.getActiveSession(senderId);
    const project = this.options.stateStore.getActiveProject(senderId);
    if (!project) {
      const fallbackText = "请先发送 /project P编号 切换到一个项目。";
      await this.replyActionCard(senderId, createChoiceCard({
        title: "先选择项目",
        body: "会话属于具体项目，请先选择一个 Codex 项目。",
        fallbackText,
        choices: [{ label: "选择项目", command: "project", arg: "list", style: "primary" }]
      }));
      return;
    }
    const sessions = this.recentProjectSessionChoices(senderId, project);
    const input = arg.trim();
    if (!input) {
      const activeId = activeSession?.projectId === project.id ? activeSession.id : undefined;
      const previews = await Promise.all(sessions.map((session) => this.projectSessionChoicePreview(session)));
      const lines = [`项目“${project.name}”最近活跃的会话（最多 ${RECENT_PROJECT_SESSION_LIMIT} 个）：`];
      for (const [index, session] of sessions.entries()) {
        lines.push(
          `[R${index + 1}] ${session.managed?.id === activeId ? "【当前】" : ""}${session.title}`,
          `   最近内容：${previews[index]}（${formatSessionTime(session.updatedAt)}）`
        );
      }
      lines.push("", "发送 /session R1 绑定并继续对应会话。发送 /new 可在当前项目新建会话。");
      await this.replyActionCard(senderId, createChoiceCard({
        title: "选择会话",
        body: sessions.length
          ? sessions.map((session, index) => [
            session.managed?.id === activeId ? `**当前 · ${session.title}**` : `**${session.title}**`,
            `${previews[index]}（${formatSessionTime(session.updatedAt)}）`
          ].join("\n")).join("\n\n")
          : `项目“${project.name}”还没有可恢复的会话。`,
        fallbackText: lines.join("\n"),
        choices: [
          ...sessions.map((session, index): ChannelChoice => ({
            label: conciseButtonLabel(session.title),
            command: "session",
            arg: `R${index + 1}`,
            style: session.managed?.id === activeId ? "primary" : "default"
          })),
          { label: "新建会话", command: "new", arg: "", style: sessions.length ? "default" : "primary" }
        ]
      }));
      return;
    }
    if (/^\d+$/.test(input)) {
      const fallbackText = "请使用列表中 R 开头的切换编号，例如 /session R1；不要使用会话名称里的数字。";
      await this.replyActionCard(senderId, createChoiceCard({
        title: "请选择会话",
        body: "数字可能与会话名称混淆，请直接从会话列表选择。",
        fallbackText,
        choices: [{ label: "打开会话列表", command: "sessions", arg: "", style: "primary" }]
      }));
      return;
    }
    const match = /^r([1-9]\d*)$/i.exec(input);
    if (!match) {
      const fallbackText = "用法：/sessions 查看列表，或 /session R<编号> 绑定会话，例如 /session R1。";
      await this.replyActionCard(senderId, createChoiceCard({
        title: "请选择会话",
        body: "可以从最近活跃的会话中直接选择。",
        fallbackText,
        choices: [{ label: "打开会话列表", command: "sessions", arg: "", style: "primary" }]
      }));
      return;
    }
    const selected = sessions[Number(match[1]) - 1];
    if (!selected) {
      const fallbackText = "没有这个切换编号。发送 /sessions 查看可用的 R 编号。";
      await this.replyActionCard(senderId, createChoiceCard({
        title: "会话不存在",
        body: "这个会话编号已失效，请重新选择。",
        fallbackText,
        choices: [{ label: "重新选择会话", command: "sessions", arg: "", style: "primary" }]
      }));
      return;
    }
    const preview = await this.projectSessionChoicePreview(selected);
    const bound = this.bindProjectSessionChoice(senderId, project, selected);
    this.options.stateStore.setInteractionMode(senderId, "session");
    await this.reply(senderId, [
      `已绑定项目“${project.name}”的会话：${bound.title}`,
      `最近内容：${preview}`,
      bound.threadId ? "下一条消息将继续该历史会话。" : "该会话尚无历史内容，下一条消息将创建新上下文。"
    ].join("\n"));
  }

  private recentProjectSessionChoices(senderId: string, project: ManagedProject): ProjectSessionChoice[] {
    const managed = this.options.stateStore.listSessions()
      .filter((session) => (
        session.senderId === senderId && session.projectId === project.id && session.mode !== "qa"
      ));
    const candidates = [...(this.options.listCodexSessions?.(project.workspace)
      ?? listCodexSessionCandidates(project.workspace))];
    const candidatesByThread = new Map(candidates.map((candidate) => [candidate.threadId, candidate]));
    const choices: ProjectSessionChoice[] = managed.map((session) => {
      const candidate = session.threadId ? candidatesByThread.get(session.threadId) : undefined;
      if (candidate) candidatesByThread.delete(candidate.threadId);
      return {
        managed: session,
        ...(candidate ? { candidate } : {}),
        title: session.title,
        updatedAt: candidate && candidate.lastUsedAt > session.updatedAt
          ? candidate.lastUsedAt
          : session.updatedAt
      };
    });
    for (const candidate of candidatesByThread.values()) {
      const preview = codexSessionCandidatePreview(candidate);
      choices.push({
        candidate,
        title: preview || `Codex 会话 ${candidate.threadId.slice(0, 8)}`,
        updatedAt: candidate.lastUsedAt
      });
    }
    return choices
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, RECENT_PROJECT_SESSION_LIMIT);
  }

  private bindProjectSessionChoice(
    senderId: string,
    project: ManagedProject,
    choice: ProjectSessionChoice
  ): ManagedSession {
    if (choice.managed) return this.options.stateStore.activateSession(choice.managed.id);
    const session = this.options.stateStore.createSession(senderId, project.workspace, choice.title, project.id);
    if (choice.candidate?.threadId) {
      this.options.stateStore.setSessionThread(session.id, choice.candidate.threadId);
    }
    const preview = choice.candidate ? codexSessionCandidatePreview(choice.candidate) : undefined;
    if (preview) this.options.stateStore.setSessionPromptPreview(session.id, preview);
    return this.options.stateStore.getSession(session.id) ?? session;
  }

  private async projectSessionChoicePreview(choice: ProjectSessionChoice): Promise<string> {
    const candidatePreview = choice.candidate ? codexSessionCandidatePreview(choice.candidate) : undefined;
    if (candidatePreview) return candidatePreview;
    return choice.managed ? this.sessionPromptPreview(choice.managed) : "暂无内容摘要";
  }

  private async sessionPromptPreview(session: ManagedSession): Promise<string> {
    if (session.lastPromptPreview) return session.lastPromptPreview;
    if (!session.threadId) return "尚未开始对话";
    try {
      const history = await this.runner.getHistory(session.threadId);
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
        `[K${index + 1}] ${formatKnowledgeKind(entry.kind)} · ${entry.scope === "project" ? `项目：${projectNames.get(entry.projectId ?? "") ?? "已移除项目"}` : "账号"}\n${entry.title}：${entry.content}`
      ),
      "",
      "删除单条：/memory forget K编号"
    ].join("\n");
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
        `**K${index + 1} · ${entry.title}**\n${entry.content}`
      ).join("\n\n")}`,
      fallbackText,
      choices
    }));
  }

  private async promptItemsFromMessage(message: NormalizedWeixinMessage): Promise<PromptBufferItem[]> {
    const items: PromptBufferItem[] = [];
    if (message.text.trim()) {
      items.push({ kind: "text", text: message.text });
    }
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      return items;
    }
    try {
      const rootDir = this.options.inboundDir ?? path.join(this.options.config.defaultCwd, ".codex-weixin-inbound");
      const remoteAttachments = [];
      for (const attachment of attachments) {
        if (!attachment.path) {
          remoteAttachments.push(attachment);
          continue;
        }
        const localPath = path.resolve(attachment.path);
        const relativePath = path.relative(path.resolve(rootDir), localPath);
        if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
          throw new Error("inbound attachment path is outside its account directory");
        }
        const size = fs.statSync(localPath).size;
        if (size > this.options.config.maxInboundBytes) {
          throw new InboundMediaTooLargeError(this.options.config.maxInboundBytes, size);
        }
        items.push({ kind: attachment.kind, path: localPath, label: attachment.label });
      }
      if (!remoteAttachments.length) return items;
      const downloaded = await downloadInboundAttachments({
        rootDir,
        senderId: message.senderId,
        messageId: message.id,
        attachments: remoteAttachments,
        maxBytes: this.options.config.maxInboundBytes,
        fetch: this.options.mediaFetch
      });
      for (const attachment of downloaded) {
        items.push({
          kind: attachment.kind,
          path: attachment.path,
          label: attachment.label
        });
      }
    } catch (error) {
      if (error instanceof InboundMediaTooLargeError) throw error;
      items.push({
        kind: "text",
        text: `[Attachment download failed: ${error instanceof Error ? error.message : String(error)}]`
      });
    }
    return items;
  }

  private async promptItemsFromMessageWithNotice(message: NormalizedWeixinMessage): Promise<PromptBufferItem[] | undefined> {
    try {
      return await this.promptItemsFromMessage(message);
    } catch (error) {
      if (!(error instanceof InboundMediaTooLargeError)) throw error;
      const maxMiB = Math.floor(error.maxBytes / (1024 * 1024));
      await this.reply(message.senderId, `附件超过 ${maxMiB} MiB 上限，请压缩或裁剪后重新发送。`);
      return undefined;
    }
  }

  private async runCodexTurn(message: NormalizedWeixinMessage, text: string, attachments: PromptBufferItem[] = []): Promise<void> {
    const project = this.options.stateStore.getActiveProject(message.senderId);
    if (!project) throw new Error("No bound Codex project for this sender");
    const mode = this.options.stateStore.getInteractionMode(message.senderId);
    const qaContext = mode === "qa" ? this.resolveQaContext(project) : undefined;
    if (mode === "qa" && !qaContext) throw new Error("Current project has no available llm-wiki knowledge base");
    const session = mode === "qa"
      ? this.ensureQaSession(message.senderId, project, qaContext as ManagedKnowledgeBase)
      : this.ensureConversationSession(message.senderId, project);
    const promptPreview = buildPromptPreview(text, attachments);
    if (promptPreview) {
      this.options.stateStore.setSessionPromptPreview(session.id, promptPreview);
    }
    const workspace = session.workspace;
    const threadId = session.threadId || undefined;
    const progressEnabled = session.streamReplies ?? this.options.config.streamReplies;
    const sentProgress = new Set<string>();
    this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: true });
    try {
      await this.withTyping(message.senderId, async () => {
        console.log(`[codex-channel-bridge] starting Codex turn for ${message.senderId} in ${workspace}`);
        const knowledge = this.options.stateStore.relevantKnowledge(promptPreview ?? text, session.projectId);
        const basePrompt = buildPrompt(text, attachments, "WeChat", knowledge);
        const result = await this.runner.run({
          prompt: qaContext ? buildQaPrompt(basePrompt, project, qaContext) : basePrompt,
          cwd: workspace,
          threadId,
          queueKey: threadId ?? session.id,
          model: session.model ?? this.options.config.model,
          effort: session.effort ?? this.options.config.effort,
          collaborationMode: session.collaborationMode === "plan" ? "plan" : undefined,
          ...(qaContext ? {
            dynamicTools: llmWikiDynamicTools(),
            onDynamicToolCall: (call: CodexDynamicToolCall) => this.handleKnowledgeToolCall(qaContext, call)
          } : {}),
          ...(progressEnabled ? {
            onProgress: async (progress: string) => {
              const progressText = progress.trim();
              if (!progressText || sentProgress.has(progressText)) return;
              sentProgress.add(progressText);
              await this.reply(message.senderId, `【进度】${progressText}`);
            }
          } : {}),
          onApproval: (request: CodexApprovalRequest) => this.approvals.request(message.senderId, request),
          onUserInput: (request) => this.userInputs.request(message.senderId, request)
        });
        console.log(`[codex-channel-bridge] Codex turn completed for ${message.senderId}; text=${result.text.length} chars`);
        if (result.threadId) {
          this.options.stateStore.setSessionThread(session.id, result.threadId);
        }
        const parsed = parseActionBlocks(result.text);
        for (const memory of parsed.actions.remember) {
          this.options.stateStore.rememberKnowledge(memory, session.projectId, session.id);
        }
        const remaining = chunkText(parsed.visibleText);
        if (remaining.length) {
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
      let sent: { messageId: string; kind: "image" | "file" | "video" };
      if (action.type === "image" && this.options.weixin.sendImage) {
        const result = await this.options.weixin.sendImage({ toUserId: senderId, path: action.path });
        sent = { ...result, kind: "image" };
      } else if (isWeixinMediaClient(this.options.weixin, action.type)) {
        sent = await sendLocalMediaFile({
          client: this.options.weixin as ChannelTextClient & Pick<
            WeixinApiClient,
            "getUploadUrl" | "sendFileMessage" | "sendImageMessage" | "sendVideoMessage"
          >,
          toUserId: senderId,
          contextToken: this.options.stateStore.getContextToken(senderId),
          filePath: action.path,
          kind: action.type
        });
      } else {
        await this.reply(senderId, `当前渠道暂不支持直接发送 ${action.type} 文件：${path.basename(action.path)}`);
        return;
      }
      this.options.onOutboundMessage?.({
        direction: "outbound",
        id: sent.messageId,
        recipientId: senderId,
        text: "",
        attachments: [{ kind: sent.kind, label: path.basename(action.path) }]
      });
    } catch (error) {
      await this.reply(senderId, `[codex-channel-bridge] Failed to send ${action.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withTyping(senderId: string, run: () => Promise<void>): Promise<void> {
    if (!this.options.weixin.sendTyping) {
      await run();
      return;
    }
    const sendTyping = async (typing: boolean) => {
      try {
        await this.options.weixin.sendTyping?.({
          toUserId: senderId,
          contextToken: this.options.stateStore.getContextToken(senderId),
          typing
        });
      } catch (error) {
        console.warn(`WeChat typing indicator failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
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
      runtime = await this.runner.getRuntimeInfo(workspace, session?.threadId);
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      model: session?.model ?? this.options.config.model ?? runtime.model,
      effort: session?.effort ?? this.options.config.effort ?? runtime.effort,
      provider: runtime.provider
    };
  }

  private async reply(senderId: string, text: string): Promise<void> {
    const contextToken = this.options.stateStore.getContextToken(senderId);
    try {
      console.log(`[codex-channel-bridge] sending reply to ${senderId}; text=${text.length} chars`);
      const sent = await this.options.weixin.sendText({ toUserId: senderId, text, contextToken });
      this.options.onOutboundMessage?.({
        direction: "outbound",
        id: sent.messageId,
        recipientId: senderId,
        text,
        attachments: []
      });
      console.log(`[codex-channel-bridge] sent reply to ${senderId}`);
    } catch (error) {
      if (isStaleContextError(error)) {
        console.warn(`WeChat context token is stale for ${senderId}; ask user to send a fresh message.`);
        return;
      }
      throw error;
    }
  }

  private async replyActionCard(senderId: string, card: ChannelActionCard): Promise<void> {
    if (!this.options.weixin.sendActionCard) {
      for (const text of chunkText(card.fallbackText)) {
        await this.reply(senderId, text);
      }
      return;
    }
    const interaction = this.cardInteraction.getStore();
    if (interaction && this.options.weixin.updateActionCard) {
      try {
        console.log(`[codex-channel-bridge] updating action card "${card.title}" in ${interaction.messageId}`);
        await this.options.weixin.updateActionCard({ messageId: interaction.messageId, card });
        this.options.onOutboundMessage?.({
          direction: "outbound",
          id: interaction.messageId,
          recipientId: senderId,
          text: card.fallbackText,
          attachments: []
        });
        console.log(`[codex-channel-bridge] updated action card "${card.title}"`);
        return;
      } catch (error) {
        console.warn(`Action card update failed for ${senderId}; sending a new card: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      console.log(`[codex-channel-bridge] sending action card "${card.title}" to ${senderId}`);
      const sent = await this.options.weixin.sendActionCard({ toUserId: senderId, card });
      this.options.onOutboundMessage?.({
        direction: "outbound",
        id: sent.messageId,
        recipientId: senderId,
        text: card.fallbackText,
        attachments: []
      });
      console.log(`[codex-channel-bridge] sent action card "${card.title}" to ${senderId}`);
    } catch (error) {
      console.warn(`Action card delivery failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      for (const text of chunkText(card.fallbackText)) {
        await this.reply(senderId, text);
      }
    }
  }

  private async replyTaskCard(message: NormalizedWeixinMessage, card: ChannelTaskCard): Promise<void> {
    const senderId = message.senderId;
    if (!this.options.weixin.sendTaskCard) {
      await this.reply(senderId, card.fallbackText);
      return;
    }
    if (message.interaction && this.options.weixin.updateTaskCard) {
      try {
        console.log(`[codex-channel-bridge] updating Taskboard card ${card.identifier} in ${message.interaction.messageId}`);
        await this.options.weixin.updateTaskCard({ messageId: message.interaction.messageId, card });
        this.options.onOutboundMessage?.({
          direction: "outbound",
          id: message.interaction.messageId,
          recipientId: senderId,
          text: card.fallbackText,
          attachments: []
        });
        console.log(`[codex-channel-bridge] updated Taskboard card ${card.identifier}`);
        return;
      } catch (error) {
        console.warn(`Taskboard card update failed for ${senderId}; sending a new card: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      console.log(`[codex-channel-bridge] sending Taskboard card ${card.identifier} to ${senderId}`);
      const sent = await this.options.weixin.sendTaskCard({ toUserId: senderId, card });
      this.options.onOutboundMessage?.({
        direction: "outbound",
        id: sent.messageId,
        recipientId: senderId,
        text: card.fallbackText,
        attachments: []
      });
      console.log(`[codex-channel-bridge] sent Taskboard card ${card.identifier} to ${senderId}`);
    } catch (error) {
      console.warn(`Taskboard card delivery failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      await this.reply(senderId, card.fallbackText);
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

function isWeixinMediaClient(client: ChannelTextClient, kind: "image" | "file" | "video"): boolean {
  const candidate = client as Partial<WeixinApiClient>;
  return typeof candidate.getUploadUrl === "function"
    && typeof candidate[kind === "image"
      ? "sendImageMessage"
      : kind === "video"
        ? "sendVideoMessage"
        : "sendFileMessage"] === "function";
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

function codexSessionCandidatePreview(candidate: CodexSessionCandidate): string | undefined {
  if (!candidate.lastUserMessage) return undefined;
  const parsed = parsePrompt(candidate.lastUserMessage);
  return buildPromptPreview(parsed.text, parsed.attachments);
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
