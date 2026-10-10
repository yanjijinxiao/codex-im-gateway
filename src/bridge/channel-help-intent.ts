// A model's help classification must not consume an ordinary capability question.
// Match the whole request, not keywords inside a question, quotation, or instruction.
// Unrecognized phrasings stay in the conversation; /help is always available.
const WORKBENCH_NAME = "(?:codex\\s*im\\s*gateway|gateway|codex\\s*渠道工作台|渠道工作台|工作台)";
const HELP_MENU = "(?:帮助(?:菜单|信息|说明)?|使用帮助|命令列表|指令列表|命令菜单|菜单)";
const EXPLICIT_HELP_REQUESTS = [
  new RegExp(`^(?:${WORKBENCH_NAME}\\s*(?:的\\s*)?)?${HELP_MENU}$`, "u"),
  new RegExp(`^(?:请|麻烦)?(?:给我)?(?:查看|显示|打开|列出|展示|发我|看看|看一下)(?:一下)?\\s*(?:${WORKBENCH_NAME}\\s*(?:的\\s*)?)?${HELP_MENU}$`, "u"),
  new RegExp(`^(?:请|麻烦)?(?:给我)?(?:打开|显示|进入)(?:一下)?\\s*${WORKBENCH_NAME}$`, "u"),
  new RegExp(`^${WORKBENCH_NAME}\\s*(?:有哪些|支持哪些|有什么|支持什么)(?:内置)?(?:命令|指令)$`, "u"),
  /^(?:help|help menu|command list)$/u,
  /^(?:please )?(?:show|open|display|list)(?: me)? (?:the )?(?:(?:codex im gateway|gateway|workbench)(?:'s)? )?(?:help(?: menu)?|command list|commands)$/u,
  /^what commands does (?:the )?(?:codex im gateway|gateway|workbench) support$/u,
  /^(?:当前|现在)?(?:有|支持)(?:哪些|什么)(?:内置)?(?:命令|指令)$/u
] as const;

export function isExplicitHelpMenuRequest(text: string): boolean {
  const normalized = text.normalize("NFKC").trim().toLowerCase().replace(/[。.!?]+$/u, "").trim();
  return EXPLICIT_HELP_REQUESTS.some((pattern) => pattern.test(normalized));
}
