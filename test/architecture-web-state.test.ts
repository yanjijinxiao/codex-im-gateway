import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
function fixture() {
  const sessions = [{ accountId: "one", id: "same", title: "A", workspace: "/a", responding: false },
    { accountId: "two", id: "same", title: "B", workspace: "/b", responding: false }];
  const key = (s: any) => `${s.accountId}:${s.id}`;
  const state = { selectedSessionKey: key(sessions[0]), sendingSessions: new Set<string>(), savingRuntimeSessions: new Set<string>(),
    config: { streamReplies: false }, chatFiles: [], sessionMessages: [], loadingMessages: false };
  let markup = "", releases: Array<() => void> = [];
  const elements = Object.fromEntries(["chatInput", "chatAttachButton", "chatFileInput", "refreshMessagesButton", "chatTitle", "chatContext"]
    .map(k => [k, { value: "new message", focus() {} }]));
  const context = vm.createContext({ state, els: elements, selectedSession: () => sessions.find(s => key(s) === state.selectedSessionKey), sessionKey: key,
    renderComposerFiles() {}, updateComposerState() {}, renderSessionRuntimeControls() {}, accountDisplayName: () => "Account", FormData, crypto,
    setChatMessagesHtml: (html: string) => { markup = html; }, renderTypingIndicator: () => "TYPING", emptyChatState: () => "EMPTY", renderConversationMessages: () => "MESSAGES",
    scrollChatToEnd() {}, async api() { await new Promise<void>(r => { releases.push(r); }); }, async refreshData() {}, async loadSelectedSessionMessages() {}, toast() {} });
  vm.runInContext(source.slice(source.indexOf("function isSessionSending("), source.indexOf("function renderConversationMessages(")), context);
  vm.runInContext(source.slice(source.indexOf("async function sendSessionMessage("), source.indexOf("function scheduleStreamingRender(")), context);
  return { state, sessions, key, elements, context, releases, markup: () => markup,
    render: () => vm.runInContext("renderChatPanel()", context), send: () => vm.runInContext("sendSessionMessage({preventDefault(){}})", context) as Promise<void> };
}

test("sending and saving runtime settings cannot disable or mark another account's same-ID session busy", () => {
  const f = fixture(); f.state.sendingSessions.add(f.key(f.sessions[0])); f.state.savingRuntimeSessions.add(f.key(f.sessions[0]));
  f.state.selectedSessionKey = f.key(f.sessions[1]); f.render();
  assert.equal((f.elements.chatInput as any).disabled, false); assert.equal(f.markup(), "EMPTY");
  f.state.selectedSessionKey = f.key(f.sessions[0]); f.render();
  assert.equal((f.elements.chatInput as any).disabled, true); assert.equal(f.markup(), "TYPING");
});

test("two independent sends can overlap, and completion clears only its own session", async () => {
  const f = fixture(); const first = f.send();
  f.state.selectedSessionKey = f.key(f.sessions[1]); f.elements.chatInput.value = "B message"; const second = f.send();
  assert.equal(f.state.sendingSessions.size, 2);
  f.releases[0](); await first;
  assert.equal(f.state.sendingSessions.has(f.key(f.sessions[0])), false); assert.equal(f.state.sendingSessions.has(f.key(f.sessions[1])), true);
  f.releases[1](); await second; assert.equal(f.state.sendingSessions.size, 0);
});

test("a duplicate send in the same session stays blocked while the original request is pending", async () => {
  const f = fixture(); const first = f.send(); f.elements.chatInput.value = "double click"; await f.send();
  assert.equal(f.releases.length, 1); f.releases[0](); await first;
});

test("uncertain Web sends keep the receipt identity and never refill the original input; only explicit not-submitted can refill", async () => {
  for (const phase of [undefined, "unconfirmed", "accepted", "not-submitted"]) {
    const f = fixture();
    vm.runInContext(`api = async () => { throw Object.assign(new Error('lost response'), { submission: ${JSON.stringify(phase) ?? 'undefined'} }); };`, f.context);
    await f.send();
    const receipt = vm.runInContext("state.submissionReceipts.get(state.selectedSessionKey)", f.context);
    assert.match(receipt.requestId, /^[a-f0-9]{32}$/);
    assert.equal(receipt.phase, phase ?? "unconfirmed");
    assert.equal(f.elements.chatInput.value, phase === "not-submitted" ? "new message" : "");
  }
});

test("same-session history reads discard an older response, including an older error", async () => {
  const f = fixture(), releases: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
  Object.assign(f.context, { api: () => new Promise((resolve, reject) => releases.push({ resolve, reject })) });
  const start = source.indexOf("let messageLoadGeneration =");
  vm.runInContext(source.slice(start, source.indexOf("\nfunction renderChatPanel(", start)), f.context);
  const first = vm.runInContext("loadSelectedSessionMessages()", f.context), second = vm.runInContext("loadSelectedSessionMessages()", f.context);
  releases[1].resolve({ messages: [{ id: "new", text: "current" }] }); await second;
  releases[0].reject(Error("stale read failed")); await first;
  assert.equal((f.state.sessionMessages[0] as any).id, "new"); assert.equal(f.state.loadingMessages, false);
});
