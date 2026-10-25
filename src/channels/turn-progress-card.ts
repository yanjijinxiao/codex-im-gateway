import { copyBlock } from "./copyable.js";
import { progressKind } from "./progress-summary.js";
import { closeMarkdownFence } from "./result-pages.js";
import { turnStatusHeading, type TurnActivity } from "./turn-status.js";

/** A pure view of task facts. No timers, delivery state or execution decisions. */
export function renderTurnProgressCard(input: {
  activity: TurnActivity;
  elapsed: string;
  current: string;
  thought?: string;
  recent: readonly string[];
  tools: { completed: number; failed: number; active?: string };
  answerPreview: string;
  notice?: string;
}): string {
  const status = {
    running: "任务仍在执行",
    "waiting-input": "等待你的回答，任务尚未完成",
    "waiting-approval": "等待你的审批，任务尚未完成",
    recovering: "正在恢复原任务，尚未确认完成",
    unconfirmed: "执行状态待确认，未重发或停止原任务"
  }[input.activity];
  const tools = input.tools;
  const metadata = [`已用时 ${input.elapsed}`];
  if (tools.completed) metadata.push(`工具完成 ${tools.completed} 次`);
  if (tools.failed) metadata.push(`工具异常 ${tools.failed} 次（非任务终态）`);
  const sections = [`${turnStatusHeading(input.activity)} · ${metadata.join(" · ")}`,
    `**${input.notice ? "状态说明" : "当前进展"}**\n\n${bounded(input.notice || input.current, 360)}`];
  if (!input.notice && input.thought && input.thought !== input.current) {
    sections.push(`**公开摘要**\n\n${bounded(input.thought, 160)}`);
  }
  // Keep errors visible without making a mobile progress card a growing log.
  const milestones = input.recent.filter(entry => progressKind(entry) !== "failure").slice(-2);
  const errors = input.recent.filter(entry => progressKind(entry) === "failure").slice(-2);
  const recent = input.recent.filter(entry => milestones.includes(entry) || errors.includes(entry));
  if (recent.length) sections.push(`**关键记录**\n\n${recent.map(entry => `- ${bounded(entry, 140).replace(/\n/g, "\n  ")}`).join("\n")}`);
  if (tools.active) sections.push(`**当前操作**\n\n${bounded(tools.active, 100)}`);
  if (input.answerPreview) sections.push(`**回复预览（尚未完成）**\n\n${bounded(input.answerPreview, 600)}`);
  sections.push(`---\n\n停止会中断当前任务：\n\n${copyBlock("/stop")}`);
  // Always end on a normal paragraph, not a code fence/list/blockquote. The
  // native streaming cursor belongs to DingTalk, never to generated dot frames.
  sections.push(status);
  return sections.join("\n\n");
}

function bounded(value: string, length: number): string {
  const text = value.trim();
  return closeMarkdownFence(text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`);
}
