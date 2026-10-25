/** Presentation facts, never inferred from model text, silence or stream closure. */
export type TurnActivity = "running" | "waiting-input" | "waiting-approval" | "recovering" | "unconfirmed";
export type TurnOutcome = "completed" | "failed" | "interrupted" | "continued" | "detached";

const labels: Record<TurnActivity | TurnOutcome, string> = {
  running: "🔵 正在执行",
  "waiting-input": "🟡 等你回答",
  "waiting-approval": "🟡 等待审批",
  recovering: "🟠 正在恢复执行",
  unconfirmed: "⚪ 执行状态待确认",
  completed: "✅ 已完成",
  failed: "❌ 执行失败",
  interrupted: "⏹️ 已中断",
  continued: "↪️ 已转入后续卡片",
  detached: "⏸️ 已停止同步（任务未停止）"
};

export function turnStatusHeading(status: TurnActivity | TurnOutcome): string {
  return `## ${labels[status]}`;
}
export function withTurnStatus(text: string, status: TurnActivity | TurnOutcome): string {
  return `${turnStatusHeading(status)}\n\n---\n\n${text}`;
}
/** Reserve the same overhead on every result page, including restored plans. */
export const TURN_STATUS_BYTES = Math.max(...Object.keys(labels).map(status =>
  Buffer.byteLength(withTurnStatus("", status as TurnActivity | TurnOutcome))));
