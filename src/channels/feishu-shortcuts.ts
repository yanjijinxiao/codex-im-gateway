export type FeishuShortcut = {
  readonly eventKey: string;
  readonly label: string;
  readonly command: string;
};

export const FEISHU_SHORTCUTS: readonly FeishuShortcut[] = [
  { eventKey: "codex.workbench", label: "打开工作台", command: "/help" },
  { eventKey: "codex.project", label: "选择项目", command: "/project" },
  { eventKey: "codex.taskboard", label: "任务面板", command: "/task" },
  { eventKey: "codex.mode", label: "切换工作模式", command: "/mode" },
  { eventKey: "codex.plan", label: "计划/执行模式", command: "/plan toggle" },
  { eventKey: "codex.goal", label: "查看或设置目标", command: "/goal" },
  { eventKey: "codex.session", label: "选择会话", command: "/sessions" }
];

/**
 * 飞书机器人一级菜单最多三个。每个入口先打开对应的原生卡片，再由卡片完成后续细分操作，
 * 因而用户不必记忆或输入任何命令。
 */
export const FEISHU_BOT_MENU_SHORTCUTS: readonly FeishuBotMenuShortcut[] = [
  { eventKey: "codex.workbench", label: "Codex 工作台", command: "/help" },
  { eventKey: "codex.taskboard", label: "任务面板", command: "/task" },
  { eventKey: "codex.project", label: "项目与模式", command: "/project" }
];

export type FeishuBotMenuShortcut = FeishuShortcut;

export function commandForFeishuMenuEvent(eventKey: string | undefined): string | undefined {
  return FEISHU_SHORTCUTS.find((shortcut) => shortcut.eventKey === eventKey)?.command;
}
