/** Transport receipts and task outcomes are separate facts. No prompt or provider body is persisted here. */
export class CodexCommunicationError extends Error {
  readonly name = "CodexCommunicationError";
  readonly submission: "not-submitted" | "unconfirmed" | "accepted";
  readonly code: "timeout" | "disconnected" | "invalid-receipt";
  constructor(readonly phase: "preflight" | "submission" | "observation", readonly operation: string,
    readonly threadId?: string, readonly turnId?: string, cause?: unknown) {
    super(`Codex ${operation} communication failed (${phase})`, { cause });
    this.submission = phase === "preflight" ? "not-submitted" : phase === "submission" ? "unconfirmed" : "accepted";
    this.code = cause instanceof CodexCommunicationError ? cause.code
      : (cause as { code?: string })?.code === "InvalidAcknowledgement" ? "invalid-receipt"
      : /timed out|timeout/i.test(cause instanceof Error ? cause.message : String(cause)) ? "timeout" : "disconnected";
  }
}

export function isCodexCommunicationFailure(error: unknown): boolean {
  if (error instanceof CodexCommunicationError) return true;
  const message = error instanceof Error ? error.message : String(error);
  // Execution deadlines and explicit task failures must keep their own semantics.
  if (/^codex exec timed out after \d+ms$/i.test(message) || (error as { name?: string })?.name === "CodexTurnExecutionError") return false;
  return /timed out|timeout|(?:IPC|app-server|Desktop|transport|connection|socket|runner).*(?:closed|disconnected|not connected)|ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND/i.test(message);
}

export function communicationError(error: unknown, context: {
  phase: CodexCommunicationError["phase"]; operation: string; threadId?: string; turnId?: string;
}): unknown {
  if (!isCodexCommunicationFailure(error)) return error;
  if (error instanceof CodexCommunicationError) {
    // A confirmed turn ID is stronger than the classification of a later read request.
    if (context.phase !== "observation" || !context.turnId) return error;
    return new CodexCommunicationError("observation", error.operation, context.threadId, context.turnId, error);
  }
  return new CodexCommunicationError(context.phase, context.operation, context.threadId, context.turnId, error);
}

/** Narrow legacy upgrade rule. A model failure or a delivered model answer is never reopened. */
export function isLegacyCommunicationNotice(text: string): boolean {
  return /^(?:\[codex-im-gateway\]\s*)?与后端通信或提交确认超时，任务是否已接收尚未确认；Gateway 未自动重发或停止原任务。请先在 Codex App 查看当前会话状态。$/.test(text.trim());
}
