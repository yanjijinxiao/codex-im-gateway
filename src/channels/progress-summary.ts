/** Present tool state, never shell source/arguments, in cards and native text progress. */
export function summarizeProgress(text: string, maxLength = 600): string {
  const content = text.trim();
  const command = content.match(/^([🔎✅❌])\s*(正在执行命令|命令完成|命令失败)\s*[:：]([\s\S]*)$/u);
  if (command) {
    const [, icon, state, source] = command;
    const kind = /\bssh\b/.test(source) ? "远程命令"
      : /\b(pytest|unittest|npm\s+(?:run\s+)?test|node\s+--test)\b/.test(source) ? "验证测试"
      : /\bpython[\d.]*\b/.test(source) ? "Python 脚本"
      : /\bgit\b/.test(source) ? "Git 操作"
      : /\b(sed|rg|head|tail|cat)\b/.test(source) ? "文件检查"
      : "命令";
    const result = state === "正在执行命令" ? `正在执行${kind}`
      : `${kind}${state === "命令失败" ? "失败" : "完成"}`;
    // Only recognized numeric result metadata is displayed, not command text.
    const exit = source.match(/(?:，|,)\s*退出码\s+(-?\d+)\b/);
    const duration = source.match(/(?:，|,)\s*(\d+(?:\.\d+)?(?:ms|s))\s*$/);
    return `${icon} ${result}${exit ? `，退出码 ${exit[1]}` : ""}${duration ? `，耗时 ${duration[1]}` : ""}`;
  }
  if (/^[🔎✅❌]\s*(?:正在|已)?(?:执行|调用).*[:：]\s*`/u.test(content)) {
    return `${content.startsWith("🔎") ? "🔎 正在执行工具操作" : content.startsWith("❌") ? "❌ 工具操作失败" : "✅ 工具操作完成"}`;
  }
  return content.length <= maxLength ? content : `${content.slice(0, maxLength - 1).trimEnd()}…`;
}
