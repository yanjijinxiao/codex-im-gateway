import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/web/approvals.js", import.meta.url), "utf8");
const escape = (v: unknown) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
class Element {
  dataset: Record<string, string> = {}; hidden = false; innerHTML = ""; textContent = "";
  listeners = new Map<string, (event: any) => Promise<void>>();
  addEventListener(name: string, listener: any) { this.listeners.set(name, listener); }
}
const row = { accountId: "account", recipientId: "group", id: "A1", hostId: "local", version: "1".repeat(64),
  expiresAt: Date.now() + 60_000, body: '<img src=x onerror="bad">',
  options: [{ id: "accept", label: "批准本次", description: "当前请求" }, { id: "always", label: "始终允许", description: "mock.app" }] };
function fixture() {
  const list = new Element(), root = new Element(), feedback = new Element(), count = new Element(), refresh = new Element();
  Object.assign(root, { querySelector: (id: string) => ({ "#approvalsList": list, "#approvalFeedback": feedback, "#refreshApprovalsButton": refresh })[id] });
  const posts: any[] = [], confirms: string[] = [];
  const state = { rows: [row], allow: true, fail: false };
  const context = vm.createContext({ window: { confirm: (text: string) => { confirms.push(text); return state.allow; } },
    document: { querySelector: (id: string) => id === "#approvalsView" ? root : count },
    FormData: class { constructor(private form: any) {} get() { return this.form.choice; } } });
  vm.runInContext(source, context);
  const view = context.window.createApprovalView({ escapeHtml: escape, escapeAttr: escape, api: async (_path: string, input: any) => {
    if (!input) return { approvals: state.rows };
    posts.push(input.body); if (state.fail) throw new Error("审批已失效，请刷新");
    state.rows = []; return { message: "已提交，等待 Codex 确认" };
  } });
  async function submit(choice: string, record = row) {
    const form = { choice, dataset: { approvalKey: JSON.stringify([record.accountId, record.recipientId, record.id, record.version]) }, querySelectorAll: () => [] };
    await list.listeners.get("submit")!({ preventDefault() {}, target: { closest: () => form } });
  }
  return { view, list, feedback, count, state, posts, confirms, submit };
}

test("Web approval is a native select, escapes details, and has no copy button or automatic approval", async () => {
  const f = fixture(); await f.view.refresh();
  assert.match(f.list.innerHTML, /select name="choice" required/);
  assert.match(f.list.innerHTML, /value="" selected disabled/);
  assert.match(f.list.innerHTML, /&lt;img/);
  assert.doesNotMatch(f.list.innerHTML, /<img|clipboard|copyable/);
  assert.equal(f.posts.length, 0); assert.equal(f.count.textContent, " · 1");
});
test("Web persistent decision requires an explicit choice, scope confirmation and exact request version", async () => {
  const f = fixture(); await f.view.refresh();
  await f.submit(""); assert.equal(f.posts.length, 0);
  f.state.allow = false; await f.submit("always"); assert.equal(f.posts.length, 0);
  f.state.allow = true; await f.submit("always");
  assert.deepEqual(JSON.parse(JSON.stringify(f.posts)), [{ accountId: row.accountId, recipientId: row.recipientId, id: row.id, version: row.version, choice: "always" }]);
  assert.match(f.confirms[0], /mock.app/); assert.match(f.feedback.textContent, /等待 Codex 确认/);
  await f.submit("always"); assert.equal(f.posts.length, 1);
});
test("stale DOM identity cannot target a replacement request and failed receipt is never displayed as success", async () => {
  const f = fixture(); await f.view.refresh();
  f.state.rows = [{ ...row, version: "2".repeat(64) }]; await f.view.refresh();
  await f.submit("always"); assert.equal(f.posts.length, 0);
  f.state.fail = true; await f.submit("always", f.state.rows[0]);
  assert.match(f.feedback.textContent, /已失效/); assert.equal(f.posts.length, 1);
  assert.equal(f.count.textContent, " · 1");
});
