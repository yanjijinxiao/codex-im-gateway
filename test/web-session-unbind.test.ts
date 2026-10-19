import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
const render = source.slice(source.indexOf("function renderSessions()"), source.indexOf("function renderSettings()"));
const handle = source.slice(source.indexOf("async function handleSessionAction("), source.indexOf("async function handleProjectAction("));
const selected = { accountId: "one/account", id: "managed-record", senderId: "group/with+symbols=", title: "same title", workspace: "/same/path",
  active: true, threadId: "native-thread", updatedAt: "2026-10-19T00:00:00Z",
  binding: { conversationId: "group/with+symbols=", hostId: "remote-host", threadId: "native-thread", bound: true } };

test("web list distinguishes exact IM conversation/native IDs and keeps unbind separate from deletion", () => {
  const other = { ...selected, id: "other-record", senderId: "<different-group>", active: false,
    binding: { ...selected.binding, conversationId: "<different-group>", bound: false } };
  const state = { sessions: [selected, other], projects: [], accounts: [], selectedAccountId: selected.accountId,
    selectedSessionKey: selected.id };
  const els = { sessionListCount: {}, sessionAccountTabs: {}, sessionsList: { innerHTML: "" } };
  const escape = (v: unknown) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const context = vm.createContext({ state, els, selectedSession: () => selected, sessionKey: (s: typeof selected) => s.id,
    accountDisplayName: () => "DingTalk account", escapeAttr: escape, escapeHtml: escape, relativeTime: () => "just now",
    renderChatPanel() {}, drawIcons() {} });
  vm.runInContext(`${render}\nrenderSessions();`, context);
  const html = els.sessionsList.innerHTML;
  assert.match(html, /对话：group\/with\+symbols=/);
  assert.match(html, /主机：remote-host/);
  assert.match(html, /Session：native-thread/);
  assert.match(html, /&lt;different-group&gt;/); assert.doesNotMatch(html, /<different-group>/);
  assert.match(html, /data-session-action="unbind"[^>]+data-session-id="managed-record"[^>]*><i/);
  assert.match(html, /data-session-action="unbind"[^>]+data-session-id="other-record" disabled/);
  assert.match(html, /data-session-action="delete"/);
  assert.doesNotMatch(html, /微信当前/);
});

for (const confirm of [false, true]) {
  test(`web unbind confirmation=${confirm}: passes only the precise snapshot and never calls delete/reset/activate`, async () => {
    const calls: Array<{ url: string; options: { method: string; body: unknown } }> = [];
    let confirmation = "", refreshes = 0;
    const button = { dataset: { sessionAction: "unbind", accountId: selected.accountId, sessionId: selected.id }, disabled: false };
    const context = vm.createContext({ state: { sessions: [selected] },
      window: { confirm(text: string) { confirmation = text; return confirm; } },
      accountDisplayName: () => "DingTalk account", toast() {},
      async api(url: string, options: { method: string; body: unknown }) { calls.push({ url, options }); },
      async refreshData() { refreshes++; } });
    vm.runInContext(handle, context);
    await context.handleSessionAction({ target: { closest: () => button } });
    assert.ok(confirmation.includes(selected.senderId)); assert.ok(confirmation.includes(selected.threadId));
    assert.ok(confirmation.includes(selected.binding.hostId)); assert.match(confirmation, /不删除 session、不停止任务/);
    assert.equal(button.disabled, false);
    assert.equal(calls.length, confirm ? 1 : 0); assert.equal(refreshes, confirm ? 1 : 0);
    if (confirm) {
      assert.equal(calls[0].url, "/api/sessions/one%2Faccount/managed-record/unbind");
      assert.equal(calls[0].options.method, "POST");
      assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options.body)), { conversationId: selected.senderId, hostId: "remote-host", threadId: selected.threadId });
    }
  });
}
