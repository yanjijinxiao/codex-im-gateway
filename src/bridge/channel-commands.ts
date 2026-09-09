import {
  channelCapabilityHelpLines,
  type ChannelCommandCapability
} from "./channel-capability.js";
import type { ChannelCommand } from "./channel-intent.js";

const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  h: "help",
  where: "status",
  st: "status",
  bal: "balance",
  knowledge: "memory",
  mem: "memory",
  projects: "project",
  p: "project",
  n: "new",
  ss: "sessions",
  s: "session",
  hist: "history",
  iv: "steer",
  m: "model",
  e: "effort",
  str: "stream",
  pp: "prompt",
  ok: "approve",
  no: "reject",
  x: "stop",
  tb: "task",
  v: "mode",
  q: "qa"
};

const SESSION_HELP_LINES = [
  "会话介入与跟随",
  "/sessions（/ss）- 查看当前项目未归档的最近 10 个会话",
  "/session（/s）R编号 - 绑定会话、回看历史并跟随后续进展",
  "/new（/n）- 在当前项目新建并绑定会话",
  "/history（/hist）[1-20] - 查看最近对话，例如 /history 10",
  "/history more - 继续查看更早的对话",
  "/follow [on|off] - 查看或切换实时跟随，例如 /follow off",
  "/leave - 退出当前会话并停止跟随；不会停止任务",
  "/steer（/iv）补充要求 - 插入当前运行轮次；后端不支持时会提示改用 /queue",
  "/queue 补充要求 - 排到当前任务之后，作为下一轮执行",
  "/policy [ask|steer|queue] - 查看或设置运行中消息的处理方式",
  "ask：先询问（默认）；steer：插入当前轮次；queue：排队到下一轮",
  "/intervene 编号 steer|queue|cancel - 处理待确认消息；编号由提示卡提供",
  "/role - 查看聊天权限",
  "/role 用户ID或* viewer|participant|controller - 设置权限（仅 controller 可操作）",
  "viewer：只读；participant：对话与插话；controller：还可停止任务、审批和管理权限",
  "/stop（/x）- 中断当前 Codex 任务（需要 controller 权限）"
] as const;

const BUILT_IN_HELP_LINES = [
  "Codex 渠道工作台（也可直接说“查看任务”“新任务：…”“提交验收”）：",
  "/help（/h）- 获取全部内置命令；/help session - 只看会话介入说明",
  "",
  ...SESSION_HELP_LINES,
  "",
  "项目与工作模式",
  "/status（/st）- 查看当前任务、项目、模型和运行状态",
  "/balance（/bal）- 查看当前 Codex 账号剩余用量",
  "/memory（/mem）[on|off|f K编号|c] - 管理账号个人记忆（与 llm-wiki 分开）",
  "/project（/p）[l|P编号] - 查看或切换已绑定项目",
  "/project add（/p a）[C编号] - 查看或添加 Codex 历史项目",
  "/project rename（/p rn）P1|新名称 - 重命名项目",
  "/project delete（/p d）P1 - 移除没有任务的项目",
  "/mode（/v）[session|task|qa] - 查看或切换当前项目工作模式",
  "/qa（/q）- 进入绑定 llm-wiki 的问答模式",
  "/plan [on|off] - 切换 Codex 原生计划模式",
  "/goal [目标|pause|resume|complete|clear] - 管理当前 thread 目标",
  "/task（/tb）- 查看当前项目的 Taskboard Issue",
  "/task ISSUE编号 - 绑定并继续对应 Codex 任务",
  "/task new|todo|start|detail|comment|attach|block|review|accept|return - 操作 Taskboard 工作流",
  "",
  "模型、消息与审批",
  "/model（/m）[编号|模型ID|default] - 查看或切换当前任务模型",
  "/effort（/e）[编号|级别|default] - 查看或切换推理强度",
  "/stream（/str）[on|off|default] - 查看或切换流式回复",
  "/prompt start（/pp s）- 开始合并多条微信消息",
  "/prompt done（/pp d）- 提交已合并的消息",
  "/approve（/ok）[A编号] - 批准一次当前渠道收到的 Codex 审批",
  "/reject（/no）[A编号] - 拒绝当前渠道收到的 Codex 审批"
] as const;

const BUILT_IN_COMMAND_NAMES = new Set([
  "help",
  "status",
  "balance",
  "memory",
  "project",
  "mode",
  "qa",
  "plan",
  "goal",
  "task",
  "sessions",
  "session",
  "history",
  "follow",
  "leave",
  "policy",
  "role",
  "intervene",
  "steer",
  "queue",
  "new",
  "model",
  "effort",
  "stream",
  "prompt",
  "approve",
  "reject",
  "stop",
  ...Object.keys(COMMAND_ALIASES)
]);

export function isReservedChannelCommandToken(token: string): boolean {
  return BUILT_IN_COMMAND_NAMES.has(token.toLowerCase());
}

export function parseCommand(
  text: string,
  capabilityAliases: Readonly<Record<string, string>> = {}
): ChannelCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  return {
    name: COMMAND_ALIASES[name] ?? capabilityAliases[name] ?? name,
    arg: rest.join(" ")
  };
}

export function channelHelpText(capabilities: readonly ChannelCommandCapability[], topic = ""): string {
  if (topic.trim().toLowerCase() === "session") {
    return [...SESSION_HELP_LINES, "发送 /help 查看全部命令。"].join("\n\n");
  }
  if (topic.trim() && topic.trim().toLowerCase() !== "all") {
    return "用法：/help 查看全部命令；/help session 查看会话介入与跟随说明。";
  }
  return [...BUILT_IN_HELP_LINES, ...channelCapabilityHelpLines(capabilities)].filter(Boolean).join("\n\n");
}
