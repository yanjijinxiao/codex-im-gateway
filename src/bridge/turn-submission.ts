import type { CodexBridgeBackend, CodexRunnerInput, CodexRunResult } from "../codex/backend.js";
import { CodexTurnExecutionError } from "../codex/backend.js";
import { communicationError, isCodexCommunicationFailure } from "../codex/communication-error.js";
import type { CodexImGatewayConfig } from "../state/config.js";
import type { KnowledgeEntry } from "../state/knowledge.js";
import type { ManagedProject, ManagedSession } from "../state/runtime-state.js";
import { buildPromptParts, buildPromptPreview, type AttachmentSource } from "./format.js";
import type { PromptBufferItem } from "./prompt-buffer.js";
import type { InboundReceiptJournal } from "./inbound-receipts.js";

export async function stageTurnAttachments(runner: CodexBridgeBackend, items: PromptBufferItem[], options: {
  accountId?: string; conversationId: string; sessionId: string; hostId?: string; maxBytes: number;
}): Promise<PromptBufferItem[]> {
  const files = items.filter((item): item is Exclude<PromptBufferItem, { kind: "text" }> => item.kind !== "text");
  if (!files.length || !options.hostId || options.hostId === "local") return items;
  if (!runner.stageAttachments) throw Error("当前远端后端未实现附件转存，消息未提交；请在远端提供可读取的文件。");
  const staged = await runner.stageAttachments(files, { hostId: options.hostId,
    scope: JSON.stringify([options.accountId, options.conversationId, options.sessionId]), maxBytes: options.maxBytes });
  if (staged.length !== files.length || staged.some(file => !file.path.startsWith("/"))) throw Error("Remote backend did not stage every attachment");
  let index = 0;
  return items.map(item => item.kind === "text" ? item : { ...item, path: staged[index++].path });
}

/** One application-level input contract for Web, IM and channel Taskboard workflows. */
export async function prepareTurnSubmission(input: {
  runner: CodexBridgeBackend; session: ManagedSession; project?: ManagedProject; config: CodexImGatewayConfig;
  accountId?: string; conversationId: string; text: string; items: PromptBufferItem[];
  source: AttachmentSource; knowledge: readonly KnowledgeEntry[];
}): Promise<CodexRunnerInput> {
  const { session, project, config } = input, hostId = session.hostId ?? project?.hostId;
  const items = await stageTurnAttachments(input.runner, input.items, { accountId: input.accountId,
    conversationId: input.conversationId, sessionId: session.id, hostId, maxBytes: config.maxInboundBytes });
  const parts = buildPromptParts(input.text, items, input.source, input.knowledge);
  const generic = /^(?:会话\s*\d+|新会话|Codex 会话(?:\s+[\da-f-]+)?)$/i.test(session.title.trim());
  return { ...parts, cwd: session.workspace, hostId,
    projectId: session.projectBinding === "none" ? undefined : project?.sourceProjectId,
    projectName: session.projectBinding === "none" ? undefined : project?.name,
    projectBinding: session.projectBinding, threadId: session.threadId || undefined,
    threadTitle: (generic ? buildPromptPreview(input.text, input.items) : session.title) ?? session.title,
    queueKey: session.threadId || session.id, model: session.model ?? config.model, effort: session.effort ?? config.effort,
    collaborationMode: session.collaborationMode === "plan" ? "plan" : undefined };
}

/** Tracks native acceptance independently of transport/presentation errors. */
export class TurnSubmission {
  completed = false;
  private entered = false;
  private threadId?: string;
  private turnId?: string;
  private readonly receipts: ReturnType<InboundReceiptJournal["capture"]>;
  constructor(receipts?: InboundReceiptJournal, private readonly sessionId?: string) { this.receipts = receipts?.capture(); }
  async run(runner: Pick<CodexBridgeBackend, "run">, input: CodexRunnerInput, assertCurrent?: () => void): Promise<CodexRunResult> {
    assertCurrent?.();
    this.threadId = input.threadId;
    this.receipts?.submitting({ sessionId: this.sessionId, hostId: input.hostId ?? "local", threadId: input.threadId });
    this.entered = true;
    try {
      const result = await runner.run({ ...input, clientUserMessageId: this.receipts?.currentId() ?? input.clientUserMessageId,
        onThreadCreated: async id => { this.threadId = id; await input.onThreadCreated?.(id); },
        onTurnStarted: async turn => {
          this.threadId = turn.threadId; this.turnId = turn.turnId;
          this.receipts?.accepted(turn.threadId, turn.turnId);
          await input.onTurnStarted?.(turn);
        } });
      if (result.threadId && result.turnId) this.receipts?.accepted(result.threadId, result.turnId);
      this.threadId = result.threadId ?? this.threadId; this.turnId = result.turnId ?? this.turnId;
      this.completed = true;
      return result;
    } catch (error) { throw this.error(error); }
  }
  error(error: unknown): unknown {
    if (this.completed) return error instanceof TurnDeliveryError ? error : new TurnDeliveryError(error);
    if (this.turnId && !(error instanceof CodexTurnExecutionError) && !isCodexCommunicationFailure(error)) {
      return error instanceof TurnApplicationError ? error : new TurnApplicationError(error);
    }
    return communicationError(error, { phase: this.turnId ? "observation" : this.entered ? "submission" : "preflight",
      operation: this.turnId ? "turn/observe" : this.entered ? "turn/submit" : "turn/prepare", threadId: this.threadId, turnId: this.turnId });
  }
}

export class TurnDeliveryError extends Error {
  constructor(cause: unknown) { super("原生任务已完成，但结果处理或投递未确认；请查看历史，未重发原任务。", { cause }); }
}

export class TurnApplicationError extends Error {
  readonly submission = "accepted";
  constructor(cause: unknown) { super("原生已接收，但 Gateway 未能确认后续处理结果；请核对历史，未重发或停止原任务。", { cause }); }
}
