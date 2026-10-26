export type CodexApprovalKind = "command" | "file" | "permissions" | "mcp";

export type CodexApprovalDecision = "accept" | "decline" | "cancel" | "session" | "always" | "rule" | `network-${number}`;
export type CodexApprovalOption = { id: CodexApprovalDecision; label: string; description: string; result: Record<string, unknown> };

export type CodexApprovalRequest = {
  kind: CodexApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
  permissions?: Record<string, unknown>;
  serverName?: string;
  hostId?: string;
  /** Observation identity only. Never a remembered permission or auto-accept rule. */
  nativeKey?: string;
  scopeDescription?: string;
  options?: CodexApprovalOption[];
};

export type CodexApprovalHandler = (
  request: CodexApprovalRequest
) => Promise<CodexApprovalDecision> | CodexApprovalDecision;
export type CodexApprovalResult = "confirmed" | "failed" | "withdrawn";
export type CodexApprovalResultHandler = (request: CodexApprovalRequest, result: CodexApprovalResult) => Promise<void> | void;

export type AppServerApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "mcpServer/elicitation/request";

export function isAppServerApprovalMethod(method: string | undefined): method is AppServerApprovalMethod {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval"
    || method === "mcpServer/elicitation/request";
}

export function parseAppServerApproval(
  method: AppServerApprovalMethod,
  params: Record<string, unknown>
): CodexApprovalRequest | undefined {
  const threadId = stringValue(params.threadId);
  const turnId = stringValue(params.turnId);
  const itemId = method === "mcpServer/elicitation/request" ? "mcp-confirmation" : stringValue(params.itemId);
  if (!threadId || !turnId || !itemId) return undefined;

  if (method === "mcpServer/elicitation/request") {
    // Only a literal, empty confirmation form has a lossless approve-once
    // mapping. Never flatten URL/OAuth, user verification, credentials or an
    // arbitrary input schema into a yes/no approval.
    const schema = recordValue(params.requestedSchema), properties = recordValue(schema?.properties);
    const meta = recordValue(params._meta);
    const serverName = stringValue(params.serverName), message = stringValue(params.message);
    if (!["form", "openai/form"].includes(String(params.mode)) || !serverName || serverName.length > 200 || !message || message.length > 1_200
      || params._meta !== undefined && params._meta !== null && !meta || !schema || schema.type !== "object"
      || !properties || Object.keys(properties).length !== 0
      || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0))
      || Object.keys(schema).some(key => !["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].includes(key))
      || schema.additionalProperties !== undefined && schema.additionalProperties !== false
      || meta && (meta.codex_approval_kind !== undefined && meta.codex_approval_kind !== "mcp_tool_call"
        || Object.keys(meta).some(key => key.startsWith("openai/")))) return undefined;
    const request: CodexApprovalRequest = { kind: "mcp", threadId, turnId, itemId, serverName, reason: message };
    // Persistence is an explicit native MCP capability, not inferred from the
    // prompt wording or the server's name. Unknown metadata is never echoed.
    const persist = meta?.codex_approval_kind === "mcp_tool_call" && Array.isArray(meta.persist)
      ? meta.persist.filter((v): v is "session" | "always" => v === "session" || v === "always") : [];
    if (meta?.codex_approval_kind === "mcp_tool_call" && meta.persist !== undefined && !persist.length) return undefined;
    if (persist.length) {
      const connector = stringValue(meta?.connector_name) ?? serverName;
      const app = stringValue(recordValue(meta?.tool_params)?.app);
      request.scopeDescription = [connector, app ? `应用：${app}` : undefined, stringValue(meta?.subtitle)].filter(Boolean).join(" · ").slice(0, 1200);
      request.options = [
        // Computer Use treats accept without persist as session scope. A native
        // persistence form therefore has no implied approve-once alternative.
        ...(persist.includes("session") ? [option("session", "允许此对话", `在当前原生会话内允许：${request.scopeDescription}`,
          { action: "accept", content: {}, _meta: { persist: "session" } })] : []),
        ...(persist.includes("always") ? [option("always", "始终允许", `由原生工具保存对此范围的授权：${request.scopeDescription}`,
          { action: "accept", content: {}, _meta: { persist: "always" } })] : []),
        ...approvalOptions(request).filter(o => o.id === "decline")
      ];
    }
    return request;
  }

  const command = stringValue(params.command);
  const cwd = stringValue(params.cwd);
  const reason = stringValue(params.reason);
  const grantRoot = stringValue(params.grantRoot);
  const permissions = recordValue(params.permissions);
  if (params.availableDecisions != null && !Array.isArray(params.availableDecisions)) return undefined;
  const request: CodexApprovalRequest = {
    kind: method === "item/commandExecution/requestApproval"
      ? "command"
      : method === "item/fileChange/requestApproval"
        ? "file"
        : "permissions",
    threadId,
    turnId,
    itemId,
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(reason ? { reason } : {}),
    ...(grantRoot ? { grantRoot } : {}),
    ...(permissions ? { permissions } : {})
  };
  if (request.kind === "permissions") {
    request.options = [...approvalOptions(request).filter(o => o.id === "accept"),
      option("session", "允许此对话", "仅授予本请求列出的权限，适用于当前原生会话的后续轮次。",
        { permissions: structuredClone(permissions ?? {}), scope: "session" }),
      ...approvalOptions(request).filter(o => o.id === "decline")];
    return request;
  }
  const decisions = params.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
  const options: CodexApprovalOption[] = [];
  for (const value of decisions as unknown[]) {
    if (value === "accept") options.push(option("accept", "允许一次", "仅批准当前原生请求。", { decision: "accept" }));
    else if (value === "acceptForSession") options.push(option("session", "允许此对话", "按 Codex 原生会话范围批准，不授予其他会话。", { decision: value }));
    else if (value === "decline" || value === "cancel") options.push(option(value, value === "decline" ? "拒绝" : "取消本次", "结束当前审批。", { decision: value }));
    else {
      const amendment = recordValue(value), exec = recordValue(amendment?.acceptWithExecpolicyAmendment);
      const prefix = exec?.execpolicy_amendment;
      if (request.kind === "command" && validPrefix(prefix)) options.push(option("rule", "以后允许此命令规则", `保存命令前缀规则：${JSON.stringify(prefix)}`,
        { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...prefix] } } }));
      const network = recordValue(recordValue(amendment?.applyNetworkPolicyAmendment)?.network_policy_amendment);
      if (request.kind === "command" && network && typeof network.host === "string" && network.host.length <= 253
        && /^[a-zA-Z0-9.:[\]-]+$/.test(network.host) && ["allow", "deny"].includes(String(network.action))) {
        options.push(option(`network-${options.filter(o => o.id.startsWith("network-")).length}`, network.action === "allow" ? "以后允许此网络目标" : "以后拒绝此网络目标",
          `保存网络规则：${network.host}（${network.action}）`, { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: network.host, action: network.action } } } }));
      }
    }
  }
  // Some versions advertise the proposed command rule separately from choices.
  if (params.availableDecisions == null && request.kind === "command" && validPrefix(params.proposedExecpolicyAmendment)) {
    const prefix = params.proposedExecpolicyAmendment;
    options.splice(2, 0, option("rule", "以后允许此命令规则", `保存命令前缀规则：${JSON.stringify(prefix)}`,
      { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...prefix] } } }));
  }
  if (!options.some(o => o.id === "decline" || o.id === "cancel")
    || new Set(options.map(o => o.id)).size !== options.length) return undefined;
  request.options = options;
  return request;
}

export function appServerApprovalResult(
  method: AppServerApprovalMethod,
  request: CodexApprovalRequest,
  decision: CodexApprovalDecision
): Record<string, unknown> {
  const selected = approvalOptions(request).find(o => o.id === decision);
  if (!selected) throw new Error("Approval choice is not supported by this native request");
  return structuredClone(selected.result);
}

/** Single projection shared by IM, Web UI and both native response adapters. */
export function approvalOptions(request: CodexApprovalRequest): readonly CodexApprovalOption[] {
  if (request.options) return request.options;
  const result = (accept: boolean) => request.kind === "mcp"
    ? { action: accept ? "accept" : "decline", content: accept ? {} : null, _meta: null }
    : request.kind === "permissions" ? { permissions: accept ? structuredClone(request.permissions ?? {}) : {}, scope: "turn" }
    : { decision: accept ? "accept" : "decline" };
  return [option("accept", "允许一次", "仅批准当前原生请求。", result(true)), option("decline", "拒绝", "拒绝当前请求。", result(false))];
}
function option(id: CodexApprovalDecision, label: string, description: string, result: Record<string, unknown>): CodexApprovalOption {
  return { id, label, description, result };
}
function validPrefix(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every(s => typeof s === "string" && !!s && !/[\r\n\0]/.test(s)) && JSON.stringify(value).length <= 1000;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
