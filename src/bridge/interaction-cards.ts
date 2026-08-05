import {
  createChoiceCard,
  type ChannelActionCard,
  type ChannelActionCommand,
  type ChannelChoice,
  type ChannelCardTemplate
} from "../channels/action-card.js";

type CommandChoice = {
  readonly label: string;
  readonly arg: string;
  readonly active?: boolean;
};

type CommandSelectionCardInput = {
  readonly title: string;
  readonly body: string;
  readonly command: ChannelActionCommand;
  readonly choices: readonly CommandChoice[];
  readonly fallbackText: string;
  readonly note?: string;
  readonly template?: ChannelCardTemplate;
  readonly includeDefault?: boolean;
};

export function createMainMenuCard(fallbackText: string): ChannelActionCard {
  return createChoiceCard({
    title: "Codex 渠道工作台",
    body: "请选择要查看或切换的能力。",
    fallbackText,
    choices: [
      { label: "当前状态", command: "status", arg: "", style: "primary" },
      { label: "Taskboard", command: "task", arg: "list" },
      { label: "项目", command: "project", arg: "list" },
      { label: "工作模式", command: "mode", arg: "" },
      { label: "计划模式", command: "plan", arg: "toggle" },
      { label: "Codex 目标", command: "goal", arg: "" },
      { label: "会话", command: "sessions", arg: "" },
      { label: "新建会话", command: "new", arg: "" },
      { label: "模型", command: "model", arg: "" },
      { label: "推理强度", command: "effort", arg: "" },
      { label: "过程进度", command: "stream", arg: "" },
      { label: "用量", command: "balance", arg: "" },
      { label: "个人记忆", command: "memory", arg: "" }
    ]
  });
}

export function createCommandSelectionCard(input: CommandSelectionCardInput): ChannelActionCard {
  const choices: ChannelChoice[] = input.choices.map((choice) => ({
    label: choice.label,
    command: input.command,
    arg: choice.arg,
    style: choice.active ? "primary" : "default"
  }));
  if (input.includeDefault) {
    choices.push({ label: "恢复默认", command: input.command, arg: "default", style: "default" });
  }
  return createChoiceCard({
    title: input.title,
    body: input.body,
    fallbackText: input.fallbackText,
    choices,
    ...(input.note ? { note: input.note } : {}),
    ...(input.template ? { template: input.template } : {})
  });
}

export function conciseButtonLabel(label: string, maximumLength = 20): string {
  const normalized = label.replace(/\s+/g, " ").trim();
  return normalized.length > maximumLength
    ? `${normalized.slice(0, maximumLength - 1)}…`
    : normalized;
}
