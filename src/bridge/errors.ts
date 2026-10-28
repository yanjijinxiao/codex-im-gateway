import { CodexInterventionError, CodexThreadStateError, CodexBackendCapabilityError, CodexTurnExecutionError } from "../codex/backend.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { codexFailureSummary } from "../codex/turn-failure.js";
import { copyableChoices } from "../channels/copyable.js";

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
  if (error instanceof CodexTurnExecutionError) {
    if (error.status === "failed" && error.failureCode === "model-capacity") {
      return `[codex-im-gateway] ${codexFailureSummary(error.failureCode)}\nCodex 原生轮次已确认失败，当前没有继续重试。可稍后在原会话重试或手动选择其他模型；Gateway 未重新执行任务或切换模型。`;
    }
    return error.status === "interrupted" ? "[codex-im-gateway] Codex 本轮任务已中断；未自动重启或重发消息。"
      : `[codex-im-gateway] ${codexFailureSummary(error.failureCode)}\n这是已确认的任务失败，不是钉钉投递失败；Gateway 未自动重试或换后端重发。`;
  }
  if (error instanceof CodexCommunicationError) {
    if (error.submission === "not-submitted") {
      const stage = error.operation === "thread/read" ? "当前会话状态读取" : "提交准备通信";
      const reason = error.code === "timeout" ? "超时" : "失败";
      return `[codex-im-gateway] ${stage}${reason}，这条消息未提交、未入队；原任务与绑定已保留。可用 /status 核对状态后再发送。`;
    }
    if (error.submission === "accepted") return "[codex-im-gateway] 原任务已接收，但进展连接中断；这不代表任务失败。Gateway 保留原卡片并继续跟随，不重发消息、不停止原任务。";
    return "[codex-im-gateway] 提交结果尚未确认；原任务可能已接收。这不代表任务失败，Gateway 保留原卡片并只读核对，不重发消息、不停止原任务。";
  }
  if (error instanceof CodexInterventionError) return error.message;
  if (error instanceof CodexBackendCapabilityError) return `当前后端不支持 ${error.capability}。${error.capability === "turnSteering" ? "可以使用 /queue 排队。" : ""}此操作未转交其他后端；需要时请显式切换后端配置。`;
  if (error instanceof CodexThreadStateError) {
    switch (error.code) {
      case "archived":
        return "[codex-im-gateway] 当前 Codex session 已归档。请先在 Codex App 中取消归档，再重新发送消息。";
      case "missing":
        return copyableChoices("[codex-im-gateway] 当前 Codex session 已不存在或被删除，请选择已有会话或新建。", [{ label: "选择已有会话", value: "/sessions" }, { label: "新建会话", value: "/new" }]);
      case "system-error":
        if (error.lastTurnFailure?.code === "model-capacity") return [
          "[codex-im-gateway] 上一轮因模型容量不足失败，这条新消息未提交；绑定已保留。",
          "当前未安排新的容量恢复：自动恢复预算已用尽、原生状态未确认或接口暂不支持。可用 /status、/history 核对；未重发消息或切换模型。"
        ].join("\n");
        if (error.systemRecovery) {
          const status = {
            recovering: "正在核对并恢复原生会话状态，尚未确认恢复成功。",
            restoring: "正在恢复原生活动状态，结果尚未确认，新的输入暂缓提交。",
            waiting: "原生客户端仍持有故障运行时，自动恢复尚未完成。",
            recovered: "上次系统状态恢复已确认；本次状态仍需重新核对。",
            deferred: "恢复因原生执行或提交状态未确认而暂缓。",
            unsupported: "当前原生执行者没有可用的安全恢复接口，尚未恢复。",
            failed: "本次系统状态恢复尚未成功，详细进展会持续更新。",
            cancelled: "本次恢复因会话来源或执行状态改变而停止。"
          }[error.systemRecovery];
          return ["[codex-im-gateway] 原会话仍未恢复，这条新消息尚未提交；绑定已保留。",
            ...(error.lastTurnFailure ? [`上一轮失败原因：${codexFailureSummary(error.lastTurnFailure.code)}`] : []), status].join("\n");
        }
        return ["[codex-im-gateway] 当前 Codex session 处于系统错误状态（systemError），这条新消息未提交；绑定已保留。",
          ...(error.lastTurnFailure ? [`上一轮失败原因：${codexFailureSummary(error.lastTurnFailure.code)}`] : []),
          "请先在 Codex App 原会话中查看并处理错误，恢复可用后再发送新消息。Gateway 未自动恢复任务、重试或换后端重发。"].join("\n");
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
  if (/^codex exec timed out after \d+ms$/i.test(message)) {
    return "[codex-im-gateway] 本轮任务执行时间过长，已停止处理。请拆成更小的步骤后重试。";
  }
  if (/timed out|timeout/i.test(message)) {
    return "[codex-im-gateway] 与后端通信或提交确认超时，任务是否已接收尚未确认；Gateway 未自动重发或停止原任务。请先在 Codex App 查看当前会话状态。";
  }
  return "[codex-im-gateway] 本轮消息处理失败，详细错误已写入本机服务输出。";
}

function isWeakSetKey(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
