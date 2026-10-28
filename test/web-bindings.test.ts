import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/web/bindings.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
const escape = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
class Element {
  value = ""; textContent = ""; focused = false; markup = "";
  options: Array<{ value: string }> = [];
  listeners = new Map<string, (event: any) => unknown>();
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    this.options = [...value.matchAll(/<option value="([^"]*)"/g)].map(match => ({ value: match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&") }));
  }
  addEventListener(name: string, callback: (event: any) => unknown) { this.listeners.set(name, callback); }
  focus() { this.focused = true; }
}
const one = { accountId: "one", id: "one", senderId: "group/1", title: "same session title", threadId: "native-thread", projectId: "shared", hostId: "remote", binding: {
  bound: true, conversationId: "group/1", hostId: "remote", threadId: "native-thread", conversation: { kind: "group", name: "诊断讨论" }, deliveryRoute: "available", interaction: { current: true } } };
function fixture() {
  const controls = new Map(["#bindingsList", "#bindingAccountFilter", "#bindingProjectFilter", "#bindingSearch", "#bindingCount", "#refreshBindingsButton", "#accountsList", "h1"].map(id => [id, new Element()]));
  const state = { accounts: [{ accountId: "one", status: "running" }, { accountId: "two", status: "running" }],
    projects: [{ accountId: "one", id: "shared", name: "项目一" }, { accountId: "two", id: "shared", name: "项目二" }],
    sessions: [one, { ...one, id: "old", binding: { ...one.binding, bound: false } },
      { ...one, accountId: "two", id: "two", senderId: "different", binding: { ...one.binding, conversationId: "different", conversation: undefined, deliveryRoute: "unconfirmed", interaction: { current: false } } }] as any[] };
  const views: string[] = [], actions: any[] = [];
  const root = { querySelector: (selector: string) => controls.get(selector) };
  const context = vm.createContext({ window: {}, document: { querySelector: (selector: string) => selector === "#bindingsView" ? root : controls.get(selector) } });
  vm.runInContext(source, context);
  const overview = context.window.createBindingOverview({ snapshot: () => state, escapeHtml: escape, escapeAttr: escape,
    accountName: (id: string) => `渠道 ${id}`, showView: (view: string) => views.push(view), sessionAction: (event: unknown) => actions.push(event), refresh() {}, drawIcons() {} });
  const control = (id: string) => controls.get(id)!;
  overview.render();
  return { state, control, overview, views, actions };
}

test("binding overview presents exact edges, separates history and never infers a group name from a session", () => {
  const f = fixture(), markup = f.control("#bindingsList").innerHTML;
  assert.equal(f.control("#bindingCount").textContent, "当前绑定 2 · 历史关联 1");
  assert.match(markup, /诊断讨论/); assert.match(markup, /group\/1/); assert.match(markup, /native-thread/);
  assert.match(markup, /主机：remote/); assert.match(markup, /项目：项目一/);
  assert.match(markup, /对话名称待确认/); assert.match(markup, /投递身份待确认/);
  assert.match(markup, /<details class="binding-history" >/);
  const history = markup.slice(markup.indexOf('<details class="binding-history"'));
  assert.match(history, /历史关联 · 非当前绑定/);
  assert.doesNotMatch(history, /data-session-action="(?:primary|unbind)"/);
  assert.doesNotMatch(markup, /data-session-action="(?:activate|reset|delete)"|copyable|clipboard/);
});

test("channel and project shortcuts filter by exact composite identity without changing any binding", () => {
  const f = fixture();
  const before = JSON.stringify(f.state.sessions);
  f.overview.open("two", "shared");
  assert.deepEqual(f.views, ["bindings"]);
  assert.equal(f.control("#bindingCount").textContent, "当前绑定 1 · 历史关联 0");
  assert.match(f.control("#bindingsList").innerHTML, /项目：项目二/);
  assert.doesNotMatch(f.control("#bindingsList").innerHTML, /data-account-id="one"/);
  assert.equal(f.control("h1").focused, true);
  assert.equal(JSON.stringify(f.state.sessions), before);
  f.control("#accountsList").listeners.get("click")!({ target: { closest: () => ({ dataset: { accountId: "one" } }) } });
  assert.equal(f.control("#bindingAccountFilter").value, "one");
  assert.equal(f.control("#bindingProjectFilter").value, "");
});

test("search, archived routes, unknown metadata, account stops and late updates remain truthful", () => {
  const f = fixture();
  f.state.sessions.push({ ...one, id: "unavailable", projectId: undefined, title: '<script>alert("bad")</script>',
    binding: { ...one.binding, nativeUnavailable: true, conversation: { kind: "direct", name: '<img src=x onerror="bad">' } } });
  f.control("#bindingSearch").value = "bad"; f.overview.render();
  const markup = f.control("#bindingsList").innerHTML;
  assert.match(markup, /&lt;script&gt;/); assert.doesNotMatch(markup, /<script>|<img/);
  assert.match(markup, /已归档或不可用 · 交互暂停/); assert.match(markup, /项目：无项目/);
  assert.match(markup, /data-session-action="primary"[^>]+disabled/);
  f.control("#bindingSearch").value = "";
  f.state.sessions = f.state.sessions.map(session => ({ ...session, binding: { ...session.binding, bound: false } }));
  f.overview.render();
  assert.equal(f.control("#bindingCount").textContent, "当前绑定 0 · 历史关联 4");
  assert.match(f.control("#bindingsList").innerHTML, /当前筛选下没有有效绑定/);
  f.state.sessions = [one]; f.state.accounts[0].status = "stopped"; f.overview.render();
  assert.match(f.control("#bindingsList").innerHTML, /渠道未运行/);
});

test("account project overview counts only current server bindings, with a shortcut even for history-only projects", () => {
  const render = app.slice(app.indexOf("function renderAccountProjects("), app.indexOf("function renderChannelIdentifiers("));
  const { state } = fixture();
  const context = vm.createContext({ state, accountDisplayName: () => "DingTalk", escapeHtml: escape, escapeAttr: escape });
  vm.runInContext(render, context);
  const markup = context.renderAccountProjects({ accountId: "one" }, [{ ...state.projects[0], sessionCount: 999, boundSessions: [], runningTasks: [] }]);
  assert.match(markup, /当前绑定 1 · 历史关联 1/);
  assert.doesNotMatch(markup, /已绑定会话 999/);
  assert.match(markup, /查看项目绑定/); assert.match(markup, /data-binding-link/);
});

test("view session is navigation-only and resolves the exact account/managed record, not duplicate native IDs", async () => {
  const handle = app.slice(app.indexOf("async function handleSessionAction("), app.indexOf("async function handleProjectAction("));
  const state = { sessions: [one, { ...one, accountId: "two" }], selectedAccountId: "two", collapsedProjectKeys: new Set(["one\nshared"]) };
  const selected: unknown[] = [], views: string[] = [];
  const context = vm.createContext({ state, showView: (view: string) => views.push(view), selectSession: (session: unknown) => selected.push(session), renderSessions() {}, api() { throw Error("Navigation must not mutate"); } });
  vm.runInContext(handle, context);
  await context.handleSessionAction({ target: { closest: () => ({ dataset: { sessionAction: "inspect", accountId: "one", sessionId: "one" } }) } });
  assert.equal(selected[0], one); assert.deepEqual(views, ["sessions"]);
  assert.equal(state.selectedAccountId, "one"); assert.equal(state.collapsedProjectKeys.has("one\nshared"), false);
});

test("system recovery progress is visible and escaped on the current exact binding", () => {
  const f = fixture();
  f.state.sessions[0] = { ...f.state.sessions[0], runtimeRecovery: { phase: "recovering", message: "正在恢复 <script>unsafe</script>" } };
  f.overview.render(); const markup = f.control("#bindingsList").innerHTML;
  assert.match(markup, /系统恢复：正在恢复 &lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>unsafe/);
});
