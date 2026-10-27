import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
function fixture() {
  const fields = new Map<string, any>(); const field = (id: string) => { if (!fields.has(id)) fields.set(id, { hidden: true, disabled: false }); return fields.get(id); };
  const intervals: Array<() => void> = [], notices: string[] = [], renders: string[] = [];
  const context = vm.createContext({ document: { addEventListener() {}, querySelector: field }, AbortSignal, TextDecoder, TextEncoder,
    window: { setInterval(fn: () => void) { intervals.push(fn); return intervals.length; }, clearInterval() {}, setTimeout, clearTimeout, requestAnimationFrame() {} } });
  vm.runInContext(source, context); const state = vm.runInContext("state", context), els = vm.runInContext("els", context);
  for (const name of ["renderMetrics", "renderAccounts", "renderSessions", "renderTaskboardStatus", "renderTaskboardWorkbench", "drawIcons"])
    context[name] = () => renders.push(name);
  context.selectedSession = () => undefined; context.isTaskboardEditing = () => false; context.toast = (s: string) => notices.push(s);
  els.qrFrame = { innerHTML: "" }; els.qrStatus = { textContent: "", className: "" };
  els.qrDialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  return { context, state, els, renders, intervals, notices };
}
test("optional Taskboard reads cannot prevent core account/session views from refreshing", async () => {
  const f = fixture(), release = Promise.withResolvers<any>();
  f.context.api = async (url: string) => url === "/api/taskboard" ? release.promise : ({ accounts: ["fresh-account"], projects: [], knowledgeBases: [], sessions: [] });
  let completed = false; const work = f.context.refreshData(false).then(() => { completed = true; });
  await new Promise(r => setTimeout(r, 20));
  try { assert.equal(completed, true); assert.ok(f.renders.includes("renderAccounts")); assert.equal(f.state.accounts[0], "fresh-account"); }
  finally { release.resolve({ enabled: false, available: false }); await work; }
});
test("an older Taskboard list response cannot replace a newer refresh", async () => {
  const f = fixture(), release = Promise.withResolvers<any>(); f.state.taskboard = { available: true }; let reads = 0;
  f.context.api = async () => ++reads === 1 ? release.promise : { issues: [{ identifier: "NEW" }] };
  const old = f.context.loadTaskboardIssues(false); await f.context.loadTaskboardIssues(false); release.resolve({ issues: [{ identifier: "OLD" }] }); await old;
  assert.equal(f.state.taskboardIssues[0].identifier, "NEW");
});
test("a late Taskboard detail cannot populate a different selected issue", async () => {
  const f = fixture(), release = Promise.withResolvers<any>();
  f.context.api = async (url: string) => url.endsWith("/OLD") ? release.promise : { issue: { identifier: "NEW" } };
  const old = f.context.loadTaskboardIssueDetail("OLD", false); await f.context.loadTaskboardIssueDetail("NEW", false);
  release.resolve({ issue: { identifier: "OLD" } }); await old;
  assert.equal(f.state.selectedTaskboardIssue, "NEW"); assert.equal(f.state.taskboardIssueDetail.issue.identifier, "NEW");
});
test("a successful Taskboard selection clears an earlier issue's error", async () => {
  const f = fixture(); f.context.api = async () => { throw Error("old issue unavailable"); };
  await f.context.loadTaskboardIssueDetail("OLD", false); assert.match(f.state.taskboardIssueError, /old issue/);
  f.context.api = async () => ({ issue: { identifier: "NEW" } });
  await f.context.loadTaskboardIssueDetail("NEW", false);
  assert.equal(f.state.taskboardIssueDetail.issue.identifier, "NEW"); assert.equal(f.state.taskboardIssueError, "");
});
test("a retired QR creation response cannot replace or poll the current login", async () => {
  const f = fixture(), release = Promise.withResolvers<any>(); let starts = 0;
  f.context.api = async () => ++starts === 1 ? release.promise : { id: "new-login", qrDataUrl: "new-qr" };
  const old = f.context.beginLogin(); await f.context.beginLogin(); release.resolve({ id: "old-login", qrDataUrl: "old-qr" }); await old;
  assert.match(f.els.qrFrame.innerHTML, /new-qr/); assert.doesNotMatch(f.els.qrFrame.innerHTML, /old-qr/); assert.equal(f.intervals.length, 1);
});
test("closing a QR dialog invalidates pending poll responses and pending creation", async () => {
  const f = fixture(), release = Promise.withResolvers<any>(); f.context.api = async () => release.promise;
  const creation = f.context.beginLogin(); f.els.qrDialog.close(); f.context.stopLoginPoll(); release.resolve({ id: "retired", qrDataUrl: "retired-qr" }); await creation;
  assert.equal(f.intervals.length, 0); assert.doesNotMatch(f.els.qrFrame.innerHTML, /retired-qr/);
});
test("a retired QR poll cannot expire the newly opened login", async () => {
  const f = fixture(), release = Promise.withResolvers<any>(); let starts = 0;
  f.context.api = async (url: string) => url === "/api/logins" ? { id: ++starts === 1 ? "old-login" : "new-login", qrDataUrl: "qr" } : release.promise;
  await f.context.beginLogin(); const oldPoll = f.context.pollLogin("old-login");
  await f.context.beginLogin(); release.resolve({ status: "expired" }); await oldPoll;
  assert.equal(f.els.qrStatus.textContent, "等待微信扫码"); assert.equal(f.state.loginPoll, 2);
});
for (const failure of ["malformed", "error-event", "observer", "oversized"] as const) test(`stream reader is bounded and released after ${failure}`, async () => {
  const f = fixture(); let cancelled = 0, released = 0, reads = 0;
  const line = failure === "malformed" ? "invalid-json\n" : failure === "error-event" ? JSON.stringify({ type: "error", error: "model failed" }) + "\n"
    : failure === "oversized" ? "x".repeat(8 * 1024 * 1024 + 1) : JSON.stringify({ type: "progress", message: "working" }) + "\n";
  const reader = { async read() { return ++reads === 1 ? { value: new TextEncoder().encode(line), done: false } : { done: true }; }, async cancel() { cancelled++; }, releaseLock() { released++; } };
  f.context.fetchWithRequestContext = async () => ({ ok: true, headers: { get() { return "application/x-ndjson"; } }, body: { getReader() { return reader; } } });
  await assert.rejects(f.context.streamApi("/api/messages", { method: "POST" }, () => { if (failure === "observer") throw Error("observer failed"); }));
  assert.equal(cancelled, 1); assert.equal(released, 1);
  if (failure === "oversized") assert.equal(reads, 1);
});

test("new-session picker identifies each IM conversation and requires an explicit choice when ambiguous", () => {
  const f = fixture();
  f.state.accounts = [{ accountId: "one", pairedSenderIds: ["actor"], lastAuthorizedActorId: "actor", lastAuthorizedSenderId: "group-one" }];
  f.state.projects = [{ accountId: "one", id: "project" }];
  f.state.sessions = [{ accountId: "one", senderId: "group-one" }, { accountId: "one", senderId: "group-two" }];
  f.els.sessionDialog = { showModal() {} };
  f.context.document.querySelector("#sessionTitleInput").focus = () => {};
  f.context.updateNewSessionDefaultTitle = () => {}; f.context.updateSessionProjectOptions = () => {};
  f.context.openNewSessionDialog();
  const picker = f.context.document.querySelector("#sessionSenderInput");
  assert.match(picker.innerHTML, /group-one/); assert.match(picker.innerHTML, /group-two/);
  assert.equal(picker.value, "");
});

test("automatic knowledge refresh preserves a focused or saving binding control", () => {
  const script = fs.readFileSync(new URL("../src/web/knowledge-bases.js", import.meta.url), "utf8");
  let focused = true, saving = false, replacements = 0;
  const bindings = { contains() { return focused; }, querySelector() { return saving ? {} : null; }, set innerHTML(_value: string) { replacements++; } };
  const context = vm.createContext({ state: { knowledgeBases: [], projects: [], accounts: [] }, window: {}, emptyState: () => "empty", drawIcons() {},
    document: { addEventListener() {}, querySelector: (id: string) => id === "#knowledgeBindingList" ? bindings : { innerHTML: "" } } });
  vm.runInContext(script, context);
  context.renderKnowledgeBasesPage(); assert.equal(replacements, 0);
  focused = false; saving = true; context.renderKnowledgeBasesPage(); assert.equal(replacements, 0);
  saving = false; context.renderKnowledgeBasesPage(); assert.equal(replacements, 1);
});
