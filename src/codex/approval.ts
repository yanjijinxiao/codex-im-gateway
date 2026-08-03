export type CodexApprovalKind = "command" | "file" | "permissions";

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
};

export type CodexApprovalHandler = (
  request: CodexApprovalRequest
) => Promise<CodexApprovalDecision> | CodexApprovalDecision;

export type AppServerApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval";

export function isAppServerApprovalMethod(method: string | undefined): method is AppServerApprovalMethod {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval";
}

export function parseAppServerApproval(
  method: AppServerApprovalMethod,
  params: Record<string, unknown>
): CodexApprovalRequest | undefined {
  const threadId = stringValue(params.threadId);
  const turnId = stringValue(params.turnId);
  const itemId = stringValue(params.itemId);
  if (!threadId || !turnId || !itemId) return undefined;

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
