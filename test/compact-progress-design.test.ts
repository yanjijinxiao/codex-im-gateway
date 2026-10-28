import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "marked";
import { renderTurnProgressLayout, renderTurnProgressCard } from "../src/channels/turn-progress-card.js";

const facts = { activity: "running" as const, elapsed: "30 秒", current: "**正在梳理 JsonObject 接口边界**\n**我正梳理 JsonObject 与属性校验边界**",
  recent: [], tools: {completed: 0, failed: 0}, answerPreview: "" };

test("a short running card has one status line, ordinary progress text and a one-line optional stop hint", () => {
  const view = renderTurnProgressLayout(facts);
  assert.match(view.body, /^\*\*进行中\*\* ⏳ · 30 秒/);
  assert.match(view.body, /正在梳理 JsonObject 接口边界/);
  assert.match(view.body, /我正梳理 JsonObject 与属性校验边界/);
  assert.doesNotMatch(view.body, /当前进展|公开摘要|任务仍在执行|\*\*正在|\*\*我正/);
  assert.equal(view.footer, "停止任务：`/stop`");
  assert.equal(Lexer.lex(view.footer).filter(token => token.type === "code").length, 0);
  assert.ok(view.body.split(/\n+/).length <= 4);
});

test("formatting-only differences do not repeat the same public summary or remove its literal code", () => {
  const current = "正在检查 `checkIndexProperties`，保留 **literal** 值";
  const view = renderTurnProgressLayout({...facts, current, thought: current.replace("正在检查", "**正在检查**")});
  assert.equal((view.body.match(/checkIndexProperties/g) ?? []).length, 1);
  assert.match(view.body, /`checkIndexProperties`/);
  assert.equal(view.body.split("literal").length - 1, 1);
});

test("waiting and recovery retain explicit state while preview code cannot create an extra copy widget", () => {
  for (const activity of ["waiting-input", "waiting-approval", "recovering", "unconfirmed"] as const) {
    const view = renderTurnProgressCard({...facts, activity, notice: "等待原生状态确认", answerPreview: "```ts\nconst x = 1;"});
    assert.match(view, /等待原生状态确认/);
    assert.equal(Lexer.lex(view).filter(token => token.type === "code").length, 0);
    assert.equal((view.match(/\/stop/g) ?? []).length, 1);
    assert.equal(Lexer.lex(view).at(-1)?.type, "paragraph");
  }
});
