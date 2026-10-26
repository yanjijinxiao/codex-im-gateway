import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpForm, mcpFormResponse, elicitationValue, safeElicitationUrl } from "../src/codex/elicitation.js";
import { parseAppServerApproval, appServerApprovalResult } from "../src/codex/approval.js";

const params = { threadId: "thread", turnId: "turn", serverName: "tool", mode: "form", message: "Choose output settings",
  requestedSchema: { type: "object", properties: { title: { type: "string", minLength: 2, maxLength: 20 },
    count: { type: "integer", minimum: 1, maximum: 5 }, enabled: { type: "boolean" },
    color: { type: "string", enum: ["red", "blue"] } }, required: ["count", "enabled"] } };
for (const mode of ["form", "openai/form"]) test(`MCP ${mode} retains types, bounds and native field names`, () => {
  const form = parseMcpForm({ ...params, mode })!; assert.ok(form); assert.equal(form.request.questions.length, 4);
  assert.deepEqual(mcpFormResponse(form, { count: { answers: ["3"] }, enabled: { answers: ["false"] }, color: { answers: ["red"] } }),
    { action: "accept", content: Object.assign(Object.create(null), { count: 3, enabled: false, color: "red" }), _meta: null });
  assert.deepEqual(mcpFormResponse(form, {}), { action: "decline", content: null, _meta: null });
  assert.throws(() => mcpFormResponse(form, { count: { answers: ["100"] } }));
});
for (const field of [ { type: "string", format: "email" }, { type: "object" }, { type: "string", pattern: "x" },
  { type: "string", title: "Password" }, { type: "string", description: "Enter verification code" } ]) {
  test(`unsupported/secret field is not flattened: ${JSON.stringify(field)}`, () => {
    assert.equal(parseMcpForm({ ...params, requestedSchema: { type: "object", properties: { value: field } } }), undefined);
  });
}
test("schema constraints are enforced before submitting native JSON", () => {
  assert.throws(() => elicitationValue({ type: "boolean" }, "yes"));
  assert.throws(() => elicitationValue({ type: "integer" }, "1.5"));
  assert.throws(() => elicitationValue({ type: "number" }, "Infinity"));
  assert.throws(() => elicitationValue({ type: "string", enum: ["one"] }, "other"));
  assert.equal(elicitationValue({ type: "string" }, "false"), "false");
});
test("thread-scoped forms need an explicit observer scope, never a guessed active turn", () => {
  assert.equal(parseMcpForm({ ...params, turnId: undefined }), undefined);
  assert.equal(parseMcpForm({ ...params, turnId: undefined }, "native-scope")?.request.turnId, "native-scope");
});
test("only non-credential HTTPS navigation URLs enter an IM notice", () => {
  assert.equal(safeElicitationUrl({ mode: "url", url: "https://example.com/login" }), "https://example.com/login");
  for (const url of ["http://example.com/login", "https://user:pass@example.com", "https://example.com/?code=secret", "https://example.com/#secret", "https://example.com/challenge/secret"]) {
    assert.equal(safeElicitationUrl({ mode: "url", url }), undefined);
  }
});
test("approval adapter cannot grant a decision absent from the native allowed set", () => {
  const value = { threadId: "thread", turnId: "turn", itemId: "item", availableDecisions: ["acceptForSession", "decline"] };
  const request = parseAppServerApproval("item/commandExecution/requestApproval", value)!;
  assert.deepEqual(request.options?.map(o => o.id), ["session", "decline"]);
  assert.throws(() => appServerApprovalResult("item/commandExecution/requestApproval", request, "accept"));
  assert.deepEqual(appServerApprovalResult("item/commandExecution/requestApproval", request, "session"), { decision: "acceptForSession" });
});
