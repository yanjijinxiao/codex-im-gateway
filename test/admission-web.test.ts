import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(new URL("../src/web/approvals.js", import.meta.url), "utf8");
const html = (v: unknown) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
class Element { dataset: Record<string, string> = {}; hidden = false; innerHTML = ""; textContent = ""; listeners = new Map<string, any>(); addEventListener(name: string, callback: any) { this.listeners.set(name, callback); } }
const record = { id: "a".repeat(12), version: "b".repeat(64), principal: { accountId: "a", channel: "dingtalk", providerId: "robot", actorId: '<img src=x onerror="bad">' }, conversationId: "group", kind: "group", phase: "pending" };
function fixture() {
  const list = new Element(), admission = new Element(), admins = new Element(), feedback = new Element(), refresh = new Element(), count = new Element();
  const root = Object.assign(new Element(), { querySelector: (id: string) => ({ "#approvalsList": list, "#approvalFeedback": feedback, "#refreshApprovalsButton": refresh, "#admissionList": admission, "#admissionAdmins": admins })[id] });
  const state = { rows: [record], admins: [] as any[], confirm: true, fail: false }, posts: any[] = [], confirmations: string[] = [];
  const context = vm.createContext({ window: { confirm: (text: string) => { confirmations.push(text); return state.confirm; } }, document: { querySelector: (id: string) => id === "#approvalsView" ? root : count },
    FormData: class { constructor(private form: any) {} get(name: string) { return this.form[name]; } } });
  vm.runInContext(source, context);
  const view = context.window.createApprovalView({ escapeHtml: html, escapeAttr: html, api: async (url: string, input?: any) => {
    if (!input) return url === "/api/approvals" ? { approvals: [] } : { requests: state.rows, candidates: state.rows, admins: state.admins };
    posts.push([url, input.body]); if (state.fail) throw Error("未确认，不应显示成功");
    state.rows = []; return { message: "已处理这条申请" };
  } });
  const submit = async (choice = "actor", version = record.version, enroll = false) => {
    const form = { choice, identity: record.id, dataset: { admissionId: record.id, admissionVersion: version }, hasAttribute: () => enroll, querySelectorAll: () => [] };
    await (enroll ? admins : admission).listeners.get("submit")({ preventDefault() {}, target: { closest: () => form } });
  };
  return { view, admission, admins, feedback, count, state, posts, confirmations, submit };
}
test("pending tab includes admission requests, explicit native controls and local admin setup without copy clutter or implicit enrollment", async () => {
  const f = fixture(); await f.view.refresh(); assert.equal(f.count.textContent, " · 1");
  assert.match(f.admission.innerHTML, /仅允许此用户/); assert.match(f.admission.innerHTML, /允许整个群聊/);
  assert.match(f.admission.innerHTML, /&lt;img/); assert.doesNotMatch(f.admission.innerHTML, /<img|clipboard|copyable/);
  assert.match(f.admins.innerHTML, /请选择本人身份/); assert.deepEqual(f.posts, []);
  await f.submit(""); assert.deepEqual(f.posts, []);
  f.state.confirm = false; await f.submit("conversation"); assert.deepEqual(f.posts, []);
  f.state.confirm = true; await f.submit("conversation");
  assert.deepEqual(JSON.parse(JSON.stringify(f.posts)), [["/api/admission/decision", { id: record.id, version: record.version, choice: "conversation" }]]);
  assert.match(f.confirmations.at(-1)!, /群内所有成员/); assert.match(f.feedback.textContent, /已处理/);
});
test("stale rows do not retarget a newer applicant and admin enrollment is a separate confirmed action", async () => {
  const f = fixture(); await f.view.refresh(); await f.submit("actor", "c".repeat(64)); assert.deepEqual(f.posts, []);
  await f.submit("actor", record.version, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.posts)), [["/api/admission/admins", { id: record.id, version: record.version }]]);
  assert.match(f.confirmations[0], /给所属渠道的其他人/);
});
test("unconfirmed admission cannot be replayed and provider errors remain visibly failures", async () => {
  const f = fixture(); f.state.rows = [{ ...record, phase: "applying" }]; await f.view.refresh();
  assert.match(f.admission.innerHTML, /结果未确认/); assert.doesNotMatch(f.admission.innerHTML, /data-admission-id/);
  f.state.rows = [record]; await f.view.refresh(); f.state.fail = true; await f.submit();
  assert.match(f.feedback.textContent, /未确认/); assert.equal(f.posts.length, 1); assert.equal(f.count.textContent, " · 1");
});
