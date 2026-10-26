import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { ChannelApprovalController } from "../src/bridge/approval.js";
import { parseAppServerApproval } from "../src/codex/approval.js";

test("protected Web API and IM consume the same scoped approval exactly once", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new ChannelApprovalController(async () => {});
  t.after(() => controller.declineAll("group"));
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), port: 0, accountManager: {
    listApprovals: () => controller.list().map(row => ({ ...row, accountId: "account" })),
    decideApproval: (account: string, sender: string, id: string, choice: string, version: string) => {
      assert.equal(account, "account"); return controller.decideCurrent(sender, id, choice, version);
    }
  } as never });
  t.after(() => server.close());
  const request = parseAppServerApproval("item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn", itemId: "item" })!;
  const pending = controller.request("group", request);
  const data = await (await fetch(`${server.url}/api/approvals`)).json();
  const row = data.approvals[0];
  const body = { accountId: "account", recipientId: "group", id: row.id, choice: "session", version: row.version };
  const endpoint = `${server.url}/api/approvals/decision`, headers = { Origin: server.url, "Content-Type": "application/json", "X-Codex-Im-Gateway-Token": server.requestToken };
  assert.equal((await fetch(endpoint, { method: "POST", body: JSON.stringify(body) })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, Origin: "https://other.invalid" }, body: JSON.stringify(body) })).status, 403);
  assert.equal(controller.list().length, 1);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...body, extra: "no" }) })).status, 400);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...body, version: "0".repeat(64) }) })).status, 409);
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200); assert.match((await response.json()).message, /允许此对话/);
  assert.equal(await pending, "session");
  assert.match(controller.decide("group", row.id, "accept"), /没有待审批/);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) })).status, 409);
  assert.deepEqual((await (await fetch(`${server.url}/api/approvals`)).json()).approvals, []);
  const html = await (await fetch(server.url)).text(); assert.match(html, /data-view="approvals"/);
  const asset = await fetch(`${server.url}/approvals.js`); assert.equal(asset.status, 200); assert.match(await asset.text(), /createApprovalView/);
});
