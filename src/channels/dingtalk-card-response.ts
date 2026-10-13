/** The four Card API operations have different, explicit business receipts. */
export type DingTalkCardOperation = "create" | "deliver" | "stream" | "state";
export type DingTalkCardMutationResponse = {
  readonly statusCode?: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
};

export class DingTalkCardMutationError extends Error {
  readonly name = "DingTalkCardMutationError";
  constructor(readonly operation: DingTalkCardOperation, readonly statusCode: number | undefined,
    readonly code: string, readonly requestId?: string,
    /** No receipt is not evidence that a POST was not applied. */
    readonly uncertain = false) {
    super(`钉钉 AI Card ${operation} 请求失败（HTTP ${statusCode ?? "unknown"}, code=${code}`
      + `${requestId ? `, requestId=${requestId}` : ""}）`);
  }
}

export function assertDingTalkCardMutationSucceeded(operation: DingTalkCardOperation,
  response: DingTalkCardMutationResponse): void {
  const body = response.body && typeof response.body === "object" && !Array.isArray(response.body)
    ? response.body as Record<string, unknown> : undefined;
  const result = body?.result;
  const acknowledged = operation === "create" ? typeof result === "string" && Boolean(result.trim())
    : operation === "deliver" ? Array.isArray(result) && result.length > 0 && result.every(item =>
      item !== null && typeof item === "object" && (item as { success?: unknown }).success === true)
    : result === true;
  const status = response.statusCode;
  const httpOk = status !== undefined && status >= 200 && status < 300;
  if (httpOk && body?.success === true && acknowledged && body.code === undefined) return;
  const requestId = safeDiagnosticId(body?.requestId)
    ?? safeDiagnosticId(response.headers?.["x-acs-request-id"] ?? response.headers?.["x-acs-trace-id"]);
  const code = safeDiagnosticId(body?.code)
    ?? (body?.success === false || result === false ? "BusinessRejected" : "InvalidAcknowledgement");
  // Never include provider messages, raw result objects, URLs, or credentials.
  const explicitRejection = body?.success === false || typeof body?.code === "string" && Boolean(body.code.trim());
  const uncertain = !body || !explicitRejection && (body.success !== true || !acknowledged)
    || status === undefined || status >= 500;
  throw new DingTalkCardMutationError(operation, status, code, requestId, uncertain);
}

function safeDiagnosticId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
}
