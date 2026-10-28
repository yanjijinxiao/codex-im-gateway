import { progressKind } from "./progress-summary.js";
import { closeMarkdownFence } from "./result-pages.js";
import { turnStatusHeading, type TurnActivity } from "./turn-status.js";
import type { ChannelProgressLayout } from "./types.js";
import { markdownPreview } from "./markdown-preview.js";

/** A pure view of task facts. No timers, delivery state or execution decisions. */
type ProgressFacts = {
  activity: TurnActivity;
  elapsed: string;
  current: string;
  thought?: string;
  recent: readonly string[];
  tools: { completed: number; failed: number; active?: string };
  answerPreview: string;
  notice?: string;
};

export function renderTurnProgressCard(input: ProgressFacts): string {
  const { sections, status, controls } = progressParts(input);
  return [...sections, controls, status].filter(Boolean).join("\n\n");
}

export function renderTurnProgressLayout(input: ProgressFacts): ChannelProgressLayout {
  const { sections, status, controls } = progressParts(input);
  return { body: [...sections, status].filter(Boolean).join("\n\n"), footer: controls };
}

function progressParts(input: ProgressFacts) {
  const status = {
    running: "",
    "waiting-input": "等待你的回答，任务尚未完成",
    "waiting-approval": "等待你的审批，任务尚未完成",
    recovering: "正在恢复原任务，尚未确认完成",
    unconfirmed: "执行状态待确认，未重发或停止原任务"
  }[input.activity];
  const tools = input.tools;
  const metadata = [input.elapsed];
  if (tools.failed) metadata.push(`工具异常 ${tools.failed} 次（非任务终态）`);
  const icon = { running: "⏳", "waiting-input": "💬", "waiting-approval": "🔐", recovering: "↻", unconfirmed: "⚠️" }[input.activity];
  const current = progressProse(input.notice || input.current, 360);
  const thought = input.thought && progressProse(input.thought, 160);
  const sections = [`${turnStatusHeading(input.activity)} ${icon} · ${metadata.join(" · ")}`, current];
  if (!input.notice && thought && !current.includes(thought)) {
    sections.push(`💭 ${thought}`);
  }
  // Keep errors visible without making a mobile progress card a growing log.
  const milestones = input.recent.filter(entry => progressKind(entry) !== "failure").slice(-2);
  const errors = input.recent.filter(entry => progressKind(entry) === "failure").slice(-2);
  const recent = input.recent.filter(entry => milestones.includes(entry) || errors.includes(entry));
  if (recent.length) sections.push(recent.map(entry => `- ${progressProse(entry, 140).replace(/\n/g, "\n  ")}`).join("\n"));
  if (tools.active) sections.push(progressProse(tools.active, 100));
  if (input.answerPreview) sections.push(`回复预览（尚未完成）\n\n${markdownPreview(input.answerPreview, 600)}`);
  // This is an optional command reference, not a required user response. A
  // full copy widget dominates short mobile cards; required approvals/answers
  // keep their own exact-reply controls on the corresponding interaction card.
  const controls = "停止任务：`/stop`";
  // Always end on a normal paragraph, not a code fence/list/blockquote. The
  // native streaming cursor belongs to DingTalk, never to generated dot frames.
  return { sections, status, controls };
}

function progressProse(value: string, length: number): string {
  return markdownPreview(bounded(value, length), length, { emphasis: false });
}

function bounded(value: string, length: number): string {
  const text = value.trim();
  return closeMarkdownFence(text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`);
}
