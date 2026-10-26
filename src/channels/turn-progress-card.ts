import { copyBlock } from "./copyable.js";
import { progressKind } from "./progress-summary.js";
import { closeMarkdownFence } from "./result-pages.js";
import { turnStatusHeading, type TurnActivity } from "./turn-status.js";
import type { ChannelProgressLayout } from "./types.js";
import { Lexer, type Token, type Tokens } from "marked";

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
  return [...sections, controls, status].join("\n\n");
}

export function renderTurnProgressLayout(input: ProgressFacts): ChannelProgressLayout {
  const { sections, status, controls } = progressParts(input);
  return { body: [...sections, status].join("\n\n"), footer: controls };
}

function progressParts(input: ProgressFacts) {
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
  // Token streams and display budgets can end inside a table/link/inline code.
  // Preview is plain text; the terminal result retains its full Markdown.
  if (input.answerPreview) sections.push(`**回复预览（尚未完成）**\n\n${plainPreview(input.answerPreview, 600)}`);
  const controls = `---\n\n停止会中断当前任务：\n\n${copyBlock("/stop")}`;
  // Always end on a normal paragraph, not a code fence/list/blockquote. The
  // native streaming cursor belongs to DingTalk, never to generated dot frames.
  return { sections, status, controls };
}

function plainPreview(value: string, length: number): string {
  const text = Lexer.lex(value.trim(), { gfm: true }).map(plainToken).join("").trim();
  const clipped = text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`;
  return clipped.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~\-]/g, "\\$&");
}

function plainToken(token: Token): string {
  if (token.type === "space" || token.type === "br" || token.type === "hr") return "\n\n";
  if (token.type === "table") return "\n表格将在最终答复中完整显示。\n";
  if (token.type === "code") return "\n代码将在最终答复中完整显示。\n";
  if (token.type === "list") return (token as Tokens.List).items.map(item => item.tokens.map(plainToken).join("")).join("\n");
  if ("tokens" in token && Array.isArray(token.tokens)) return token.tokens.map(plainToken).join("")
    + (["paragraph", "heading", "blockquote"].includes(token.type) ? "\n\n" : "");
  return "text" in token && typeof token.text === "string" ? token.text : token.raw;
}

function bounded(value: string, length: number): string {
  const text = value.trim();
  return closeMarkdownFence(text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`);
}
