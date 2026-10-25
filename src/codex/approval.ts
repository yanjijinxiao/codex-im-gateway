export type CodexApprovalKind = "command" | "file" | "permissions" | "mcp";

export type CodexApprovalDecision = "accept" | "decline";

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
};

export type CodexApprovalHandler = (
  request: CodexApprovalRequest
) => Promise<CodexApprovalDecision> | CodexApprovalDecision;

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
    if (params.mode !== "form" || !serverName || serverName.length > 200 || !message || message.length > 1_200
      || params._meta !== undefined && params._meta !== null && !meta || !schema || schema.type !== "object"
      || !properties || Object.keys(properties).length !== 0
      || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0))
      || Object.keys(schema).some(key => !["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].includes(key))
      || schema.additionalProperties !== undefined && schema.additionalProperties !== false
      || meta && (meta.codex_approval_kind !== undefined && meta.codex_approval_kind !== "mcp_tool_call"
        || Object.keys(meta).some(key => key.startsWith("openai/")))) return undefined;
    return { kind: "mcp", threadId, turnId, itemId, serverName, reason: message };
  }

  const command = stringValue(params.command);
  const cwd = stringValue(params.cwd);
  const reason = stringValue(params.reason);
  const grantRoot = stringValue(params.grantRoot);
  const permissions = recordValue(params.permissions);
  return {
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
}

export function appServerApprovalResult(
  method: AppServerApprovalMethod,
  request: CodexApprovalRequest,
  decision: CodexApprovalDecision
): Record<string, unknown> {
  if (method === "mcpServer/elicitation/request") {
    // No persist/always-allow metadata is ever submitted from IM.
    return { action: decision === "accept" ? "accept" : "decline", content: decision === "accept" ? {} : null, _meta: null };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: decision === "accept" ? request.permissions ?? {} : {},
      scope: "turn"
    };
  }
  return { decision };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
