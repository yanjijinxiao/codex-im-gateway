/** Public failure metadata is a closed vocabulary, not a provider response body.
 * Never forward additionalDetails, stacks, prompts, paths or credentials to IM. */
export type CodexFailureCode = "unintended-activity" | "safety-blocked" | "context-window" | "usage-limit"
  | "unauthorized" | "rate-limit" | "model-capacity" | "model-unavailable" | "upstream-connection" | "upstream-error";

export function codexFailureCode(error: unknown): CodexFailureCode {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  const message = (typeof error === "string" ? error : typeof record?.message === "string" ? record.message : "").slice(0, 4_096);
  const info = record?.codexErrorInfo;
  // Current V2 uses camelCase; older backends used PascalCase. Normalize
  // identifiers only, never include arbitrary provider text in public output.
  const nativeCode = (typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] ?? "" : "")
    .replace(/[_-]/g, "").toLowerCase();
  if (/blocked by (?:our |the )?safety systems?/i.test(message)) {
    return /Reason:\s*Potentially unintended activity\b/i.test(message) ? "unintended-activity" : "safety-blocked";
  }
  if (["cyberpolicy", "misalignmentpolicyviolation"].includes(nativeCode)) return "safety-blocked";
  if (nativeCode === "contextwindowexceeded" || /context (?:window|length).*(?:exceed|limit|too)|maximum context length/i.test(message)) return "context-window";
  if (["usagelimitexceeded", "sessionbudgetexceeded"].includes(nativeCode) || /usage limit|quota exceeded|insufficient_quota/i.test(message)) return "usage-limit";
  if (nativeCode === "unauthorized" || /unauthorized|invalid api key|authentication failed/i.test(message)) return "unauthorized";
  if (nativeCode === "ratelimitexceeded" || /rate limit|too many requests/i.test(message)) return "rate-limit";
  if (nativeCode === "serveroverloaded" || /(?:selected )?model is at capacity|model.*(?:overloaded|capacity)|server overloaded/i.test(message)) return "model-capacity";
  if (/model.*(?:not found|does not exist|not available|not supported)/i.test(message)) return "model-unavailable";
  if (["httpconnectionfailed", "responsestreamconnectionfailed", "responsestreamdisconnected", "responsetoomanyfailedattempts"].includes(nativeCode)
    || /(?:connection|stream).*(?:failed|disconnect)|timed out|timeout/i.test(message)) return "upstream-connection";
  return "upstream-error";
}

export function codexFailureSummary(code: CodexFailureCode): string {
  switch (code) {
    case "unintended-activity": return "上游安全系统拒绝了本轮请求：Potentially unintended activity（可能存在非预期操作）。上游未提供进一步触发细节。";
    case "safety-blocked": return "上游安全系统拒绝了本轮请求；上游未提供可展示的具体触发原因。";
    case "context-window": return "上游报告上下文长度超过限制。";
    case "usage-limit": return "上游报告用量或配额已达限制。";
    case "unauthorized": return "上游认证失败，请在对应 Codex 后端检查登录或凭证。";
    case "rate-limit": return "上游报告请求频率达到限制。";
    case "model-capacity": return "上游报告所选模型当前容量不足（model at capacity / server overloaded）。";
    case "model-unavailable": return "上游报告所选模型不存在、不可用或不受支持。";
    case "upstream-connection": return "原生轮次已明确失败，并报告连接、响应流或超时错误；这不是 Gateway 提交回执未知。";
    default: return "Codex 已确认本轮执行失败；上游未提供可安全展示的已知错误摘要，请在 Codex App 原轮次查看详情。";
  }
}

export function lastCodexTurnFailure(turn: unknown): { turnId: string; code: CodexFailureCode } | undefined {
  if (!turn || typeof turn !== "object") return undefined;
  const value = turn as Record<string, unknown>;
  const turnId = value.turnId ?? value.id;
  return value.status === "failed" && typeof turnId === "string" && turnId
    ? { turnId, code: codexFailureCode(value.error) } : undefined;
}
