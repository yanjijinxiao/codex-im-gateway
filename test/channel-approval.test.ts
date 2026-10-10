import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelApprovalController } from "../src/bridge/approval.js";
import type { CodexApprovalRequest } from "../src/codex/approval.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

function request(): CodexApprovalRequest {
  return { kind: "command", threadId: "thread", turnId: "turn", itemId: "item", command: "echo test" };
}

test("approval decisions are conversation-scoped and report submission before backend confirmation", async () => {
  const notices: string[] = [];
  const approvals = new ChannelApprovalController(async (_sender, notice) => { notices.push(notice.text); });
  const approval = request();
  const decision = approvals.request("room-one", approval);
  assert.match(notices[0]!, /会话：thread/);
  assert.match(approvals.decide("room-two", "A1", "accept"), /没有待审批/);
  assert.match(approvals.decide("room-one", "A1", "accept"), /已提交批准/);
  assert.equal(await decision, "accept");
  assert.equal(notices.some(text => text.includes("已确认接收")), false);
  await approvals.reportResult("room-two", approval, "confirmed");
  assert.equal(notices.length, 1);
  await approvals.reportResult("room-one", approval, "confirmed");
  assert.match(notices[1]!, /Codex 已确认接收审批 A1/);
  await approvals.reportResult("room-one", approval, "failed");
  assert.equal(notices.length, 2);
});

test("withdrawn Desktop approvals cannot be accepted through a stale IM notice", async () => {
  const notices: string[] = [];
  const approvals = new ChannelApprovalController(async (_sender, notice) => { notices.push(notice.text); });
  const approval = request();
  const decision = approvals.request("room", approval);
  await approvals.reportResult("room", approval, "withdrawn");
  assert.equal(await decision, "decline");
  assert.match(approvals.decide("room", "A1", "accept"), /没有待审批/);
  assert.match(notices.at(-1)!, /A1 已失效/);
});

test("a failed receipt never reports the approval as effective", async () => {
  const notices: string[] = [];
  const approvals = new ChannelApprovalController(async (_sender, notice) => { notices.push(notice.text); });
  const approval = request();
  const decision = approvals.request("room", approval);
  approvals.decide("room", "A1", "accept");
  await decision;
  await approvals.reportResult("room", approval, "failed");
  assert.match(notices.at(-1)!, /未获 Codex 确认/);
  assert.equal(notices.some(text => text.includes("已确认接收")), false);
});

test("multiple pending approvals require an explicit ID", async () => {
  const approvals = new ChannelApprovalController(async () => {});
  const first = approvals.request("room", request());
  const second = approvals.request("room", { ...request(), itemId: "second" });
  assert.match(approvals.decide("room", "", "accept"), /没有待审批/);
  approvals.declineAll("room");
  assert.deepEqual(await Promise.all([first, second]), ["decline", "decline"]);
});

test("approval IDs continue across service restarts instead of reusing old notice IDs", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-sequence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const first = new RuntimeStateStore(paths);
  assert.equal(first.allocateApprovalId(), "A1");
  const restarted = new RuntimeStateStore(paths);
  assert.equal(restarted.allocateApprovalId(), "A2");
});
