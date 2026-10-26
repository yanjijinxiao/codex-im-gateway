import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseAppServerApproval, appServerApprovalResult, approvalOptions } from "../src/codex/approval.js";
import { ChannelApprovalController } from "../src/bridge/approval.js";
import { ApprovalJournal } from "../src/bridge/approval-journal.js";

const method = "mcpServer/elicitation/request" as const;
const base = { threadId: "thread", turnId: "turn", itemId: "item" };
const mcp = { ...base, serverName: "cua_repl", mode: "form", message: 'Allow Computer Use to use "iDingTalk"?',
  requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call",
    connector_name: "Computer Use", tool_params: { app: "dd.work.exclusive4aliding" }, persist: ["session", "always"] } };

test("Computer Use exposes only native persistence choices and sends their exact native metadata", () => {
  const request = parseAppServerApproval(method, mcp)!;
  assert.deepEqual(approvalOptions(request).map(o => o.id), ["session", "always", "decline"]);
  assert.match(request.scopeDescription!, /Computer Use.*dd.work.exclusive4aliding/);
  for (const persist of ["session", "always"] as const) assert.deepEqual(appServerApprovalResult(method, request, persist),
    { action: "accept", content: {}, _meta: { persist } });
  assert.throws(() => appServerApprovalResult(method, request, "accept"));
  assert.deepEqual(appServerApprovalResult(method, request, "decline"), { action: "decline", content: null, _meta: null });
  const returned = appServerApprovalResult(method, request, "always"); returned._meta = { persist: "session" };
  assert.deepEqual(appServerApprovalResult(method, request, "always")._meta, { persist: "always" });
});

test("prompt wording, fake persist objects and unsupported metadata cannot invent an always permission", () => {
  for (const meta of [undefined, { persist: ["always"] }, { persist: { key: "always" } }]) {
    const request = parseAppServerApproval(method, { ...mcp, _meta: meta })!;
    assert.deepEqual(approvalOptions(request).map(o => o.id), ["accept", "decline"]);
    assert.throws(() => appServerApprovalResult(method, request, "always"));
  }
  for (const persist of [{ key: "always" }, ["unknown"], []]) {
    assert.equal(parseAppServerApproval(method, { ...mcp, _meta: { ...mcp._meta, persist } }), undefined);
  }
  const sessionOnly = parseAppServerApproval(method, { ...mcp, _meta: { ...mcp._meta, persist: ["session"] } })!;
  assert.deepEqual(approvalOptions(sessionOnly).map(o => o.id), ["session", "decline"]);
  assert.throws(() => appServerApprovalResult(method, sessionOnly, "always"));
});

test("native command rules and network amendments retain the complete offered restriction", () => {
  const commandMethod = "item/commandExecution/requestApproval" as const;
  const prefix = ["git", "fetch", "origin"];
  const nativeRule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } };
  const nativeNetwork = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } };
  const request = parseAppServerApproval(commandMethod, { ...base, availableDecisions: ["accept", "acceptForSession", nativeRule, nativeNetwork, "decline"] })!;
  assert.deepEqual(appServerApprovalResult(commandMethod, request, "session"), { decision: "acceptForSession" });
  assert.deepEqual(appServerApprovalResult(commandMethod, request, "rule"), { decision: nativeRule });
  assert.deepEqual(appServerApprovalResult(commandMethod, request, "network-0"), { decision: nativeNetwork });
  assert.match(approvalOptions(request).find(o => o.id === "rule")!.description, /\["git","fetch","origin"\]/);
  assert.match(approvalOptions(request).find(o => o.id === "network-0")!.description, /example.com/);
  const restricted = parseAppServerApproval(commandMethod, { ...base, availableDecisions: ["accept", "decline"], proposedExecpolicyAmendment: prefix })!;
  assert.throws(() => appServerApprovalResult(commandMethod, restricted, "rule"));
  assert.throws(() => appServerApprovalResult(commandMethod, restricted, "session"));
  assert.equal(parseAppServerApproval(commandMethod, { ...base, availableDecisions: ["accept"] }), undefined);
});

test("file and permission session grants preserve the native response and requested permissions", () => {
  const fileMethod = "item/fileChange/requestApproval" as const;
  assert.deepEqual(appServerApprovalResult(fileMethod, parseAppServerApproval(fileMethod, base)!, "session"), { decision: "acceptForSession" });
  const permissionMethod = "item/permissions/requestApproval" as const;
  const permissions = { fileSystem: { read: ["/tmp/approved"] }, network: null };
  const request = parseAppServerApproval(permissionMethod, { ...base, permissions })!;
  assert.deepEqual(appServerApprovalResult(permissionMethod, request, "session"), { permissions, scope: "session" });
  assert.deepEqual(appServerApprovalResult(permissionMethod, request, "accept"), { permissions, scope: "turn" });
  assert.deepEqual(appServerApprovalResult(permissionMethod, request, "decline"), { permissions: {}, scope: "turn" });
  assert.throws(() => appServerApprovalResult(permissionMethod, request, "always"));
});

test("IM and Web UI share one immutable approval, one version and one decision", async t => {
  const notices: any[] = [];
  const controller = new ChannelApprovalController(async (_recipient, notice) => { notices.push(notice); });
  t.after(() => controller.declineAll("group"));
  const request = { ...parseAppServerApproval(method, mcp)!, hostId: "host-one", nativeKey: "native-one" };
  const duplicate = structuredClone(request);
  const promise = controller.request("group", request);
  assert.equal(controller.request("group", duplicate), promise);
  assert.equal(notices.length, 1);
  await assert.rejects(controller.request("group", { ...duplicate, reason: "changed scope" }), /changed its scope/);
  assert.match(notices[0].text, /```text\n\/approve A1 always\n```/);
  assert.match(notices[0].text, /```text\n\/approve A1 session\n```/);
  assert.ok(notices[0].card);
  const row = controller.list()[0];
  assert.equal(row.hostId, "host-one");
  assert.ok(!JSON.stringify(row).includes('"result"'));
  assert.throws(() => controller.decideCurrent("other", row.id, "always", row.version), /已处理/);
  assert.throws(() => controller.decideCurrent("group", row.id, "always", "stale"), /已处理/);
  assert.throws(() => controller.decideCurrent("group", row.id, "network-0", row.version), /不支持/);
  request.options!.splice(0); // Caller mutation must not change a displayed request.
  assert.match(controller.decideCurrent("group", row.id, "always", row.version), /始终允许.*Codex 接收结果/);
  assert.equal(await promise, "always");
  assert.match(controller.decide("group", row.id, "accept"), /没有待审批/);
  assert.throws(() => controller.decideCurrent("group", row.id, "always", row.version), /已处理/);
});

test("scope forgery cannot consume a once-only approval", async t => {
  const controller = new ChannelApprovalController(async () => {});
  t.after(() => controller.declineAll("group"));
  const pending = controller.request("group", { kind: "mcp", ...base });
  assert.match(controller.decide("group", "A1 always", "accept"), /不支持/);
  assert.equal(controller.list().length, 1);
  controller.decide("group", "A1", "accept"); assert.equal(await pending, "accept");
});

test("durable audit records exact selected scope and native receipt without becoming an allowlist", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-audit-")), file = path.join(root, "one", "approvals.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = parseAppServerApproval(method, mcp)!;
  request.command = "SECRET_COMMAND_NEVER_STORED";
  const controller = new ChannelApprovalController(async () => {}, 1000, undefined, file);
  t.after(() => controller.declineAll("group"));
  const pending = controller.request("group", request);
  controller.decide("group", "A1 always", "accept"); await pending;
  assert.equal(new ApprovalJournal(file).snapshot()[0].phase, "unconfirmed");
  await controller.reportResult("group", request, "confirmed");
  const restarted = new ApprovalJournal(file).snapshot();
  assert.equal(restarted[0].choice, "always"); assert.equal(restarted[0].phase, "confirmed");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /SECRET_COMMAND|dd.work|persist|tool_params/);
  const fresh = new ChannelApprovalController(async () => {}, 1000, undefined, file);
  assert.deepEqual(fresh.list(), []); // Audit history cannot resubmit any native decision.
});

test("withdrawal and failed transport close pending choices and retain truthful audit state", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-withdrawal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const result of ["withdrawn", "failed"] as const) {
    const file = path.join(root, result + ".json"), request = parseAppServerApproval(method, mcp)!;
    const controller = new ChannelApprovalController(async () => {}, 1000, undefined, file);
    t.after(() => controller.declineAll("group"));
    const pending = controller.request("group", request);
    await controller.reportResult("group", request, result);
    assert.equal(await pending, "decline");
    assert.deepEqual(controller.list(), []);
    assert.equal(new ApprovalJournal(file).snapshot()[0].phase, result);
  }
});

test("malformed audit is preserved instead of silently resetting permission history", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-corrupt-")), file = path.join(root, "approvals.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, "invalid audit");
  assert.throws(() => new ApprovalJournal(file));
  assert.equal(fs.readFileSync(file, "utf8"), "invalid audit");
});
