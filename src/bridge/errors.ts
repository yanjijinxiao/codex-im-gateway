import { CodexInterventionError, CodexThreadStateError, CodexBackendCapabilityError } from "../codex/backend.js";

const channelReportedErrors = new WeakSet<object>();

/** Marks an error whose existing streaming message already contains the user-facing failure. */
export function markMessageHandlingErrorReported(error: unknown): void {
  if (isWeakSetKey(error)) channelReportedErrors.add(error);
}

/** Prevents channel adapters from creating a second error message for the same failed turn. */
export function wasMessageHandlingErrorReported(error: unknown): boolean {
  return isWeakSetKey(error) && channelReportedErrors.has(error);
}

export function userFacingMessageHandlingError(error: unknown): string {
  if (error instanceof CodexInterventionError) return error.message;
  if (error instanceof CodexBackendCapabilityError) return `当前后端不支持 ${error.capability}。${error.capability === "turnSteering" ? "可以使用 /queue 排队。" : ""}此操作未转交其他后端；需要时请显式切换后端配置。`;
  if (error instanceof CodexThreadStateError) {
    switch (error.code) {
      case "archived":
        return "[codex-im-gateway] 当前 Codex session 已归档。请先在 Codex App 中取消归档，再重新发送消息。";
      case "missing":
        return "[codex-im-gateway] 当前 Codex session 已不存在或被删除。请发送 /sessions 重新选择，或发送 /new 新建 session。";
      case "system-error":
        return "[codex-im-gateway] 当前 Codex session 处于系统错误状态。请先在 Codex App 中打开并处理错误。";
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/DingTalk inbound image download failed/i.test(message)) {
    return "[codex-im-gateway] 已收到钉钉图片，但下载失败。请重新发送；如果仍失败，请检查机器人是否有消息文件下载权限。";
  }
  if (/CreateProcessAsUserW failed:\s*1312|codexExecSandbox/i.test(message)) {
    return [
      "[codex-im-gateway] Windows Codex sandbox 启动失败。",
      "可在当前服务状态目录的 config.json 中设置 \"codexExecSandbox\": \"danger-full-access\" 后重启。",
      "该设置会让 Codex 获得本机完整访问权限，请仅在理解并接受安全风险时启用。"
    ].join("\n");
  }
  if (/timed out|timeout/i.test(message)) {
    return "[codex-im-gateway] 本轮任务执行时间过长，已停止处理。请拆成更小的步骤后重试。";
  }
  return "[codex-im-gateway] 本轮消息处理失败，详细错误已写入本机服务输出。";
}

function isWeakSetKey(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
