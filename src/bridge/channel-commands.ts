import { splitCommandText } from "../channels/command-text.js";
import {
  channelCapabilityHelpLines,
  type ChannelCommandCapability
} from "./channel-capability.js";
import type { ChannelCommand } from "./channel-intent.js";
import type { CodexBackendCapabilities } from "../codex/backend.js";
import { copyableChoices } from "../channels/copyable.js";

/** One canonical command inventory for aliases, reservation and help limits. */
export const CHANNEL_COMMAND_REGISTRY = [
  { name: "help", aliases: ["h"] },
  { name: "status", aliases: ["where", "st"] },
  { name: "balance", aliases: ["bal"], capability: "accountRateLimits" },
  { name: "memory", aliases: ["knowledge", "mem"] },
  { name: "project", aliases: ["projects", "p"] },
  { name: "new", aliases: ["n"] },
  { name: "sessions", aliases: ["ss"] },
  { name: "session", aliases: ["s"] },
  { name: "history", aliases: ["hist"] },
  { name: "ide", aliases: [] },
  { name: "access", aliases: [] },
  { name: "follow", aliases: [], capability: "liveFollow" },
  { name: "leave", aliases: [] },
  { name: "unbind", aliases: [] },
  { name: "policy", aliases: [] },
  { name: "role", aliases: [] },
  { name: "intervene", aliases: [] },
  { name: "steer", aliases: ["iv"], capability: "turnSteering" },
  { name: "queue", aliases: [], capability: "nativeQueue" },
  { name: "model", aliases: ["m"] },
  { name: "effort", aliases: ["e"] },
  { name: "stream", aliases: ["str"], capability: "progress" },
  { name: "prompt", aliases: ["pp"] },
  { name: "approve", aliases: ["ok"], capability: "approvals" },
  { name: "reject", aliases: ["no"], capability: "approvals" },
  { name: "answer", aliases: [], capability: "userInput" },
  { name: "skip", aliases: [], capability: "userInput" },
  { name: "stop", aliases: ["x"] },
  { name: "task", aliases: ["tb"] },
  { name: "mode", aliases: ["v", "view"] },
  { name: "qa", aliases: ["q"] },
  { name: "plan", aliases: [], capability: "collaborationModes" },
  { name: "goal", aliases: [], capability: "goals" }
] as const;

const COMMAND_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  CHANNEL_COMMAND_REGISTRY.flatMap(command => command.aliases.map(alias => [alias, command.name]))
);

const SESSION_HELP_LINES = [
  "会话介入与跟随",
  "/sessions（/ss）- 未归档会话按置顶 → 项目目录顺序 → 其他会话排列；默认每页 10 个",
  "/sessions size 50 - 每页条数设为 50（5-50，自动保存）",
  "/sessions detail R编号 - 查看完整标题、主机、目录和 ID，不切换会话",
  "/sessions more|prev - 下一页或上一页；/sessions page 2 - 跳页",
  "/sessions search 关键词 - 搜索标题、目录或会话 ID",
  "/sessions unbound|project - 只看无项目会话或当前项目会话",
  "/session（/s）R编号或会话ID [--host 主机ID] - 直接绑定并回看历史；App 后端同时跟随进展",
  "/new（/n）- 在当前项目新建并绑定会话",
  "/new P编号|C编号|完整项目名 - 在指定项目新建并切换；未绑定项目自动绑定",
  "/new --standalone - 新建本机无项目会话，使用独立持久目录",
  "/new --project 项目 - 显式指定项目；/session new ... 与 /new ... 等价",
  "新会话在下一条消息时启动 Codex；没有当前项目时 /new 会提示选择，不自动选第一个项目",
  "/history（/hist）[1-20] - 查看最近对话，例如 /history 10",
  "/history more - 继续查看更早的对话",
  "/ide [status] - 获取当前项目的 Web IDE 入口；不会提交任务，浏览器另行鉴权",
  "/ide identity - 私聊或群聊查看本人身份，首次在本机 Web IDE 页登记授权管理员",
  "/ide auth 六位识别码 - 兼容核对流程（私聊或群聊）；优先复制原授权页生成的完整命令",
  "/follow [on|off|sync] - 查看同步健康；on 开启并同步，sync 强制同步当前绑定（App 后端）",
  "/follow sync --retry-delivery - 控制者明确重试原实例的未知投递，可能重复通知，不创建新卡",
  "/follow primary - 控制者将当前对话设为持久化主交互目标；提问/审批单处交互，进度仍可多处跟随",
  "/unbind - 解绑当前 IM 对话与 session，停止本对话跟随；不删除会话、不停止任务、不影响其他对话",
  "/leave - /unbind 的兼容命令；解绑后普通消息仅提示绑定，不自动接回旧会话",
  "/steer（/iv）补充要求 - 插入当前运行轮次；后端不支持时明确拒绝，不暗中排队",
  "/queue 补充要求 - 加入 Codex 原生队列，作为下一轮执行（需后端支持）",
  "/queue list；/queue cancel 队列ID - 查看本聊天回执；取消自己的待执行消息",
  "/policy [ask|steer|queue] - 查看或设置运行中消息的处理方式",
  "steer：插入当前轮次（默认）；queue：原生排队到下一轮；ask：兼容的询问模式",
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
  "/project（/p）[l|P编号|C编号] - 查看或切换项目；不自动绑定 session，使用 /new 或 /session 绑定",
  "/project add（/p a）[C编号] - /project 的兼容别名",
  "/project rename（/p rn）P1|新名称 - 仅修改 Gateway 显示名称，不重命名 Codex App 项目",
  "/project delete（/p d）P1 - 仅移除没有任务的 Gateway 登记，不删除 Codex 项目或目录",
  "/mode（/v）[session|task|qa] - 查看或切换当前项目工作模式",
  "/qa（/q）- 进入绑定 llm-wiki 的问答模式",
  "/plan [on|off] - 切换 Codex 原生计划模式",
  "/goal [目标|pause|resume|complete|clear] - 管理当前 thread 目标",
  "/task（/tb）- 查看当前项目的 Taskboard Issue",
  "/task ISSUE编号 - 绑定并继续对应 Codex 任务",
  "/task new|todo|start|detail|comment|attach|block|review|accept|return - 操作 Taskboard 工作流",
  "",
  "模型、消息与审批",
  "/access - 准入审批管理员查看申请；/access identity 登记候选个人身份，首次需在本机待审批页明确指定管理员",
  "/model（/m）[编号|模型ID|default] - 查看或切换当前任务模型",
  "/effort（/e）[编号|级别|default] - 查看或切换推理强度",
  "/stream（/str）[on|off|default] - 开关本会话过程进度（包括跟随）；最终结果仍发送",
  "/prompt start（/pp s）- 开始合并多条渠道消息",
  "/prompt done（/pp d）- 提交已合并的消息",
  "/approve（/ok）[A编号] - 批准一次当前渠道收到的 Codex 审批",
  "/reject（/no）[A编号] - 拒绝当前渠道收到的 Codex 审批",
  "/answer Q编号 回答内容 - 只回复原问题，不作为普通对话或审批",
  "/answer [list] - 查看当前绑定已恢复的待回答问题",
  "/answer Q编号 --option 1 - 选择问题中的第 1 个选项",
  "/skip Q编号 - 跳过原问题，不等于批准操作"
] as const;

const BUILT_IN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...CHANNEL_COMMAND_REGISTRY.map(command => command.name),
  ...Object.keys(COMMAND_ALIASES)
]);

export function isReservedChannelCommandToken(token: string): boolean {
  return BUILT_IN_COMMAND_NAMES.has(token.toLowerCase());
}

export function parseCommand(
  text: string,
  capabilityAliases: Readonly<Record<string, string>> = {}
): ChannelCommand | undefined {
  const parts = splitCommandText(text);
  if (!parts) return;
  const { name, argument } = parts;
  const rest = argument.trim().split(/\s+/).filter(Boolean);
  const canonicalName = COMMAND_ALIASES[name] ?? (BUILT_IN_COMMAND_NAMES.has(name) ? name : capabilityAliases[name] ?? name);
  // Normalize before authorization and mode checks, including /s new.
  if (canonicalName === "session" && rest[0]?.toLowerCase() === "new") {
    return { name: "new", arg: rest.slice(1).join(" ") };
  }
  return { name: canonicalName, arg: ["answer", "queue", "steer"].includes(canonicalName) ? argument : rest.join(" ") };
}

export type ChannelHelpContext = {
  backendCapabilities?: CodexBackendCapabilities;
  desktopOwned?: boolean;
  taskboardAvailable?: boolean;
};

export function channelHelpText(capabilities: readonly ChannelCommandCapability[], topic = "", context: ChannelHelpContext = {}): string {
  const navigation = (text: string, sessionOnly = false) => copyableChoices(text, [
    { label: "查看会话列表，再使用列表提供的完整切换命令", value: "/sessions" },
    { label: "查看当前状态", value: "/status" },
    { label: "查看最近历史", value: "/history" },
    ...(sessionOnly ? [{ label: "查看全部命令参考", value: "/help" }] : [
      { label: "选择项目", value: "/project" }, { label: "查看可选模型", value: "/model" },
      { label: "查看推理强度选项", value: "/effort" }, { label: "打开当前项目 IDE", value: "/ide" }
    ])
  ]);
  const referenceNote = "以下为命令语法参考：方括号、竖线及“编号/内容”等表示需要选择或填写的参数，不是现成答案。实际操作时使用当前页面或卡片给出的完整命令。";
  const describe = (line: string): string => {
    const token = /^\/(\w+)/.exec(line)?.[1];
    const command = CHANNEL_COMMAND_REGISTRY.find(item => item.name === token);
    if (token === "task" && context.taskboardAvailable === false) return `${line}【需启用 Taskboard】`;
    if ((token === "steer" || token === "queue") && context.desktopOwned) return `${line}【当前 Desktop 转发不支持此操作，请在 App 中操作或使用共享 App Server】`;
    if (command && "capability" in command && context.backendCapabilities?.[command.capability] === false) {
      return `${line}【当前后端不支持】`;
    }
    return line;
  };
  if (topic.trim().toLowerCase() === "session") {
    return navigation([referenceNote, ...SESSION_HELP_LINES].map(describe).join("\n\n"), true);
  }
  if (topic.trim() && topic.trim().toLowerCase() !== "all") {
    return copyableChoices("请选择要查看的帮助。", [{ label: "全部命令参考", value: "/help" }, { label: "会话帮助", value: "/help session" }]);
  }
  return navigation([referenceNote, ...BUILT_IN_HELP_LINES, ...channelCapabilityHelpLines(capabilities)].filter(Boolean).map(describe).join("\n\n"));
}
