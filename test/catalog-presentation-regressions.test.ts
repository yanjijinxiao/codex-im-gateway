import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Lexer } from "marked";
import { BridgeService } from "../src/bridge/service.js";
import { createChoiceCard, type ChannelActionCard } from "../src/channels/action-card.js";
import { dingTalkProgressContent } from "../src/channels/dingtalk-markdown.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import type { CodexProjectCandidate } from "../src/server/codex-projects.js";
import type { FriendlyChannelIntent } from "../src/bridge/channel-intent.js";

const candidate = (id: string, name = id, hostId = "local"): CodexProjectCandidate => ({ projectId: id, name, hostId,
  projectKind: hostId === "local" ? "local" : "remote", workspace: "/" + id, sessionCount: 0, lastUsedAt: "" });
const codeValues = (text: string) => Lexer.lex(text).filter(t => t.type === "code").map(t => t.text);
function fixture(t: { after(fn: () => void): void }, initial: CodexProjectCandidate[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-catalog-regression-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)), texts: string[] = [], cards: ChannelActionCard[] = [], runs: unknown[] = [];
  let candidates = initial, intent: FriendlyChannelIntent | undefined, sequence = 0;
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["room"], streamReplies: false, codexBackend: "app-server" },
    stateStore: store, listCodexProjects: () => candidates, intentResolver: { async resolve() { return intent; } },
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: "text" }; },
      async sendActionCard(x) { cards.push(x.card); return { messageId: "card" }; } },
    runner: { async run(input: unknown) { runs.push(input); return { text: "done", threadId: "native", raw: "" }; },
      async listThreads() { return Array.from({ length: 55 }, (_, i) => ({ threadId: `t${i}`, title: `Task ${i}`, cwd: "/repo",
        persistence: "active", runtimeStatus: "unknown", activeFlags: [], updatedAt: new Date(100000 - i).toISOString() })); } } as never });
  const send = (text: string, senderId = "alice") => service.handleMessage({ senderId, replyTargetId: "room", text, id: String(sequence++), raw: {} });
  return { store, texts, cards, runs, send, service, setCandidates(value: CodexProjectCandidate[]) { candidates = value; },
    setIntent(value: FriendlyChannelIntent) { intent = value; } };
}

test("native action body has no duplicate copy instructions; text fallback keeps complete inert replies", () => {
  const card = createChoiceCard({ title: "Approve", body: "Choose a scope", fallbackText: "Choose a scope", choices: [
    { label: "允许一次", command: "approve", arg: "A7 once" }, { label: "拒绝", command: "reject", arg: "A7" } ] });
  assert.equal(card.body, "Choose a scope");
  assert.deepEqual(codeValues(card.fallbackText), ["/approve A7 once", "/reject A7"]);
  assert.equal(card.actionGroups.flat().length, 2);
});

test("persisted 50-row preference does not generate 50 copy boxes; default is a short page", async t => {
  const f = fixture(t);
  await f.send("/sessions");
  assert.equal(f.cards[0].table!.rows.length, 10);
  assert.deepEqual(codeValues(f.cards[0].fallbackText), ["/session R编号", "/sessions more"]);
  assert.match(f.cards[0].fallbackText, /模板/);
  assert.deepEqual(codeValues(f.cards[0].body), []);
  await f.send("/sessions size 50");
  const card = f.cards.at(-1)!;
  assert.equal(card.table!.rows.length, 50);
  assert.equal(card.actionGroups.flat().length, 51, "native buttons retain all exact choices");
  assert.deepEqual(codeValues(card.fallbackText), ["/session R编号", "/sessions more"]);
  assert.ok(card.fallbackText.length < 4000);
  await f.send("/sessions more");
  assert.equal(f.cards.at(-1)!.table!.rows[0][0], "R51");
});

test("historical native registration cannot make the current App project name ambiguous", async t => {
  const f = fixture(t, [candidate("remote-project", "Same", "remote")]);
  const legacy = f.store.createProject("Same", "/old-local", { sourceProjectId: "old-native" });
  await f.send("/new Same");
  assert.equal(f.store.getActiveProject("room")?.sourceProjectId, "remote-project");
  assert.equal(f.store.listProjects().some(p => p.id === legacy.id), true, "history is retained, never deleted to repair presentation");
  assert.equal(f.runs.length, 0);
  await f.send("/projects");
  assert.equal(f.cards.at(-1)!.table!.rows.length, 1);
  assert.match(f.cards.at(-1)!.fallbackText, /历史登记/);
  assert.doesNotMatch(f.cards.at(-1)!.fallbackText, /old-local/);
  await f.send("/project retained");
  assert.equal(f.cards.at(-1)!.table!.rows[0][1], "Same");
});

for (const bound of [false, true]) test(`explicit ambiguous project selection preserves the current binding (bound=${bound})`, async t => {
  const f = fixture(t, [candidate("one", "Same"), candidate("two", "Same", "remote")]);
  if (bound) { const p = f.store.createProject("Current", "/current"); f.store.activateProject("room", p.id); f.store.createSession("room", p.workspace, undefined, p.id); }
  const before = f.store.getActiveSession("room")?.id;
  f.setIntent({ kind: "command_sequence", commands: [{ name: "project", arg: "Same" }, { name: "new", arg: "" }, { name: "plan", arg: "on" }] });
  await f.send("/project Same");
  assert.equal(f.texts.length, 1);
  assert.match(f.texts[0], /多个同名项目/);
  assert.equal(f.cards.length, 0);
  assert.equal(f.store.getActiveSession("room")?.id, before);
  assert.equal(f.runs.length, 0, "never runs the instruction on an old/default session");
});

test("explicit new-session failure leaves the current state intact", async t => {
  const f = fixture(t);
  f.setIntent({ kind: "command_sequence", commands: [{ name: "new", arg: "missing" }, { name: "mode", arg: "task" }] });
  await f.send("/new missing");
  assert.equal(f.texts.length, 1); assert.match(f.texts[0], /没有找到/);
  assert.equal(f.store.listSessions().length, 0); assert.equal(f.runs.length, 0);
});

test("project selectors preserve identities through reordered discovery and reject removed candidates", async t => {
  const a = candidate("a"), b = candidate("b"), f = fixture(t, [a, b]);
  await f.send("/project"); f.setCandidates([b, a]);
  await f.send("/new C1"); assert.equal(f.store.getActiveProject("room")?.sourceProjectId, "a");
  await f.send("/project"); const before = f.store.getActiveSession("room")?.id;
  f.setCandidates([a]); await f.send("/new C1");
  assert.match(f.texts.at(-1)!, /变化或过期/); assert.equal(f.store.getActiveSession("room")?.id, before);
});

test("project catalog paginates without per-row copy boxes and distinguishes hosts", async t => {
  const f = fixture(t, Array.from({length: 23}, (_, i) => candidate(`p${i}`, "Same", `remote-${i}`)));
  await f.send("/project");
  const first = f.cards.at(-1)!;
  assert.equal(first.table!.rows.length, 10);
  assert.ok(first.table!.rows.every(row => row[3] === "可选择"), "an unbound row must not be marked current when no project is selected");
  assert.deepEqual(codeValues(first.fallbackText), ["/project 项目编号", "/project page 2"]);
  assert.equal(new Set(first.table!.rows.map(row => row[2])).size, 10);
  await f.send("/project page 2"); assert.equal(f.cards.at(-1)!.table!.rows[0][0], "C11");
  await f.send("/new C11"); assert.equal(f.store.getActiveProject("room")?.sourceProjectId, "p10");
});

test("active DingTalk snapshot stays a single complete paragraph, retaining summaries across repeated rewrites", () => {
  for (const text of ["概览 **summary**\n\n- 第一项\n- 第二项\n\n任务仍在执行", "摘要 <img src=x onerror=evil>\n\n```text\ncode\n```\n\n任务仍在执行"]) {
    const content = dingTalkProgressContent(text);
    assert.deepEqual(Lexer.lex(content).map(t => t.type), ["paragraph"]);
    assert.match(content, /摘要|概览/); assert.ok(content.endsWith("任务仍在执行"));
    assert.doesNotMatch(content, /<img|```|\n/);
  }
});

test("project codes cannot borrow another actor's list or survive a restart as reindexed choices", async t => {
  const f = fixture(t, [candidate("a"), candidate("b")]);
  await f.send("/project", "alice");
  await f.send("/new C1", "bob");
  assert.equal(f.store.listSessions().length, 0);
  assert.match(f.texts.at(-1)!, /当前没有这份项目列表/);
  f.setCandidates([candidate("b"), candidate("a")]);
  await f.send("/project", "bob");
  await f.send("/new C1", "alice");
  assert.equal(f.store.getActiveProject("room")?.sourceProjectId, "a", "each actor retains the catalog they saw");
  await f.send("/new C1", "bob");
  assert.equal(f.store.getActiveProject("room")?.sourceProjectId, "b");
});

test("project details expose full paths read-only and a newly registered C code cannot create duplicates", async t => {
  const f = fixture(t, [candidate("a")]);
  await f.send("/project");
  await f.send("/project detail C1");
  assert.match(f.texts.at(-1)!, /目录：\/a/); assert.match(f.texts.at(-1)!, /项目 ID：a/);
  assert.equal(f.store.listProjects().length, 0); assert.equal(f.store.listSessions().length, 0);
  await f.send("/new C1"); await f.send("/new C1");
  assert.equal(f.store.listProjects().length, 1); assert.equal(f.store.listSessions().length, 2);
});
