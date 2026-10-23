import { codexFailureCode, codexFailureSummary, type CodexFailureCode } from "./turn-failure.js";

/** Observation, NOT permission to resubmit a prompt or repeat tool effects.
 * Only a native error notification can positively confirm willRetry. */
export type CodexTurnRecovery = {
  threadId: string;
  turnId: string;
  code: CodexFailureCode;
  willRetry?: boolean;
};

export function codexTurnRecovery(threadId: string, turn: unknown): CodexTurnRecovery | undefined {
  if (!turn || typeof turn !== "object") return undefined;
  const value = turn as Record<string, unknown>;
  const turnId = value.id ?? value.turnId;
  if (value.status !== "inProgress" || typeof turnId !== "string" || !turnId || !value.error) return undefined;
  return { threadId, turnId, code: codexFailureCode(value.error) };
}

export function codexRecoverySummary(recovery: CodexTurnRecovery): string {
  // Some failure summaries deliberately assert a terminal state. Never reuse
  // those words while an execution is still active or awaiting completion.
  const reason = recovery.code === "upstream-connection" ? "上游连接或响应流暂时异常。"
    : recovery.code === "upstream-error" ? "上游报告暂时异常，未提供可安全展示的已知原因。"
    : codexFailureSummary(recovery.code);
  return `${reason}\n\n${recovery.willRetry === true
    ? "Codex 原生正在自动重试；继续使用本张卡片等待后续进展。"
    : recovery.willRetry === false ? "Codex 未安排继续重试；正在等待本轮最终状态确认。"
    : "原生轮次仍在执行，等待后续状态；尚未确认是否会自动重试。"}\nGateway 未重复提交任务或切换模型。`;
}
