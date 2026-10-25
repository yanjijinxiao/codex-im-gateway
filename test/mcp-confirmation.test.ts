import assert from "node:assert/strict";
import test from "node:test";
import { appServerApprovalResult, parseAppServerApproval } from "../src/codex/approval.js";

const method = "mcpServer/elicitation/request";
const confirmation = { threadId: "thread", turnId: "turn", serverName: "browser-use", mode: "form",
  message: "Allow download from https://example.com/photo.jpg?",
  requestedSchema: { type: "object", properties: {} }, _meta: { origin: "https://example.com", persist: {} } };

test("empty MCP confirmation has an explicit once-only approval result, not persistent permission", () => {
  const request = parseAppServerApproval(method, confirmation)!;
  assert.equal(request.kind, "mcp"); assert.equal(request.reason, confirmation.message);
  assert.equal(request.serverName, "browser-use");
  assert.deepEqual(appServerApprovalResult(method, request, "accept"), { action: "accept", content: {}, _meta: null });
  assert.deepEqual(appServerApprovalResult(method, request, "decline"), { action: "decline", content: null, _meta: null });
});

test("MCP input forms, security challenges and unsupported schema constraints never become approve buttons", () => {
  for (const override of [
    { mode: "url", url: "https://example.com/auth?secret=do-not-forward" },
    { mode: "openai/userVerification", challenge: "do-not-forward" },
    { mode: "openai/form" },
    { requestedSchema: { type: "object", properties: { password: { type: "string" } } } },
    { requestedSchema: { type: "object", properties: {}, required: ["approved"] } },
    { requestedSchema: { type: "object", properties: {}, minProperties: 1 } },
    { requestedSchema: { type: "object", properties: {}, additionalProperties: true } },
    { _meta: { codex_approval_kind: "browser_auth" } },
    { _meta: { "openai/elicitation": {} } },
    { turnId: null }, { threadId: "" }, { message: "" }, { message: "Too long to show safely".repeat(100) }, { _meta: "unknown" }
  ]) assert.equal(parseAppServerApproval(method, { ...confirmation, ...override }), undefined);
});
