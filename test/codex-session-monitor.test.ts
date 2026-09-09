import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexSessionCompletionMonitor,
  type CodexSessionActivity,
  type CodexSessionCompletion,
  type CodexSessionTask
} from "../src/server/codex-session-monitor.js";

test("excludes internal reviews at startup, live append and new-file discovery without suppressing the main task", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-monitor-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir);
  const main = path.join(dir, "main.jsonl");
  const meta = (id: string, extra = {}) => ({ type: "session_meta", payload: {
    id, session_id: "parent", cwd: root, ...extra
  } });
  writeLines(main, [meta("main", { source: "cli" }), taskStarted("main-turn")]);
  const variants = [{ thread_source: "guardian_review" }, { thread_source: "subagent" },
    { source: { subagent: { other: "guardian" } } }];
  for (const [i, source] of variants.entries()) writeLines(path.join(dir, `internal-${i}.jsonl`), [
    meta(`internal-${i}`, source), taskStarted(`review-${i}`), taskComplete(`review-${i}`, "INTERNAL_REVIEW")
  ]);
  const activities: CodexSessionActivity[] = [];
  const completions: CodexSessionCompletion[] = [];
  const recovered: CodexSessionCompletion[] = [];
  const tasks: CodexSessionTask[] = [];
  const monitor = new CodexSessionCompletionMonitor({ codexHome: root, pollIntervalMs: 60_000,
    now: () => Date.parse("2026-08-01T09:00:00.000Z"),
    onActivity: (x) => { activities.push(x); }, onCompletion: (x) => { completions.push(x); },
    onTaskChanged: (x) => { tasks.push(x); }, onRecoveredCompletion: (x) => { recovered.push(x); }
  });
  monitor.start();
  t.after(() => monitor.stop());
  await monitor.ready();
  for (const [i, source] of variants.entries()) {
    const events = [taskStarted(`fresh-${i}`), responseCommentary("INTERNAL_PROGRESS"), taskComplete(`fresh-${i}`, "INTERNAL_REVIEW")];
    appendLines(path.join(dir, `internal-${i}.jsonl`), events);
    writeLines(path.join(dir, `new-internal-${i}.jsonl`), [meta(`new-internal-${i}`, source), ...events]);
  }
  appendLines(main, [completedDesktopItem("CommandExecution", "foreign-turn"),
    taskComplete("foreign-turn", "FOREIGN_COMPLETION"), responseCommentary("正常进展"),
    taskComplete("main-turn", '{"outcome":"allow"}')]);
  await monitor.scanNow();
  await monitor.scanNow();
  assert.deepEqual(activities.map((x) => [x.sessionId, x.turnId, x.text]), [["main", "main-turn", "正常进展"]]);
  assert.deepEqual(completions.map((x) => [x.sessionId, x.turnId, x.text]), [["main", "main-turn", '{"outcome":"allow"}']]);
  assert.equal(recovered.length, 0);
  assert.ok(tasks.length > 0 && tasks.every((x) => x.sessionId === "main" && x.turnId === "main-turn"));
});

test("restores progress when a long turn start is outside the bounded tail", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-monitor-long-turn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir);
  const file = path.join(dir, "long.jsonl");
  writeLines(file, [sessionMeta("long-session", root), taskStarted("long-turn"),
    { type: "padding", payload: "x".repeat(9 * 1024 * 1024) },
    { type: "turn_context", timestamp: "2026-08-01T08:59:00.000Z", payload: { turn_id: "long-turn" } },
    { type: "token_usage_record", timestamp: "2026-08-01T08:59:01.000Z", payload: { turn_id: "long-turn" } }
  ]);
  const activities: CodexSessionActivity[] = [];
  const monitor = new CodexSessionCompletionMonitor({ codexHome: root, pollIntervalMs: 60_000,
    now: () => Date.parse("2026-08-01T09:00:00.000Z"), onCompletion: () => undefined,
    onActivity: (activity) => { activities.push(activity); }
  });
  monitor.start();
  t.after(() => monitor.stop());
  await monitor.ready();
  appendLines(file, [responseCommentary("重启后的真实进展")]);
  await monitor.scanNow();
  assert.equal(activities.at(-1)?.turnId, "long-turn");
  assert.equal(activities.at(-1)?.text, "重启后的真实进展");
});

test("offers persisted terminal evidence only to the recovery callback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-monitor-recovered-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "sessions"));
  writeLines(path.join(root, "sessions", "complete.jsonl"), [sessionMeta("session", root),
    taskStarted("turn"), taskComplete("turn", "已在停机期间完成")]);
  const recovered: CodexSessionCompletion[] = [];
  const monitor = new CodexSessionCompletionMonitor({ codexHome: root, pollIntervalMs: 60_000,
    now: () => Date.parse("2026-08-01T09:00:00.000Z"),
    onCompletion: () => { throw new Error("must not replay old completion notifications"); },
    onRecoveredCompletion: (completion) => { recovered.push(completion); }
  });
  monitor.start();
  t.after(() => monitor.stop());
  await monitor.ready();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].text, "已在停机期间完成");
});

test("reports only new Codex task completions from existing and new sessions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-monitor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");
  const sessionDir = path.join(root, ".codex", "sessions", "2026", "08", "01");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const existing = path.join(sessionDir, "existing.jsonl");
  writeLines(existing, [
    sessionMeta("session-existing", workspace),
    taskComplete("historical-turn", "历史结果"),
    taskStarted("new-turn"),
    userMessage("服务重启前已开始的任务")
  ]);
  const completions: CodexSessionCompletion[] = [];
  const activities: CodexSessionActivity[] = [];
  const taskChanges: CodexSessionTask[] = [];
  const monitor = new CodexSessionCompletionMonitor({
    codexHome: path.join(root, ".codex"),
    pollIntervalMs: 60_000,
    now: () => Date.parse("2026-08-01T09:00:00.000Z"),
    onCompletion: (completion) => completions.push(completion),
    onActivity: (activity) => activities.push(activity),
    onTaskChanged: (task) => taskChanges.push(task)
  });
  monitor.start();
  t.after(() => monitor.stop());
  await monitor.ready();

  appendLines(existing, [
    agentReasoning("正在分析现有实现"),
    completedReasoning("正在兼容 Desktop 新格式"),
    responseReasoning("正在兼容 Desktop 新格式"),
    completedCommentary("已经找到进度丢失的位置"),
    responseCommentary("已经找到进度丢失的位置"),
    completedDesktopItem("CommandExecution", "new-turn"),
    completedDesktopItem("ImageView", "new-turn"),
    completedDesktopItem("McpToolCall", "new-turn"),
    customToolCall("call-1", "functions.exec"),
    customToolCallOutput("call-1"),
    taskComplete("new-turn", "修复完成")
  ]);
  const created = path.join(sessionDir, "created.jsonl");
  writeLines(created, [
    sessionMeta("session-created", workspace),
    taskStarted("aborted-turn"),
    userMessage("执行新任务"),
    turnAborted("aborted-turn")
  ]);

  await monitor.scanNow();
  await monitor.scanNow();

  assert.deepEqual(completions.sort((left, right) => left.turnId.localeCompare(right.turnId)), [{
    sessionId: "session-created",
    turnId: "aborted-turn",
    workspace: path.resolve(workspace),
    taskTitle: "执行新任务",
    text: "Codex 任务已中断：interrupted",
    success: false,
    completedAt: "2026-08-01T08:00:04.000Z"
  }, {
    sessionId: "session-existing",
    turnId: "new-turn",
    workspace: path.resolve(workspace),
    taskTitle: "服务重启前已开始的任务",
    text: "修复完成",
    success: true,
    completedAt: "2026-08-01T08:00:03.000Z"
  }]);
  assert.equal(taskChanges.some((task) =>
    task.turnId === "new-turn" && task.status === "running" && task.title === "服务重启前已开始的任务"
  ), true);
  assert.equal(taskChanges.some((task) =>
    task.turnId === "new-turn" && task.status === "completed"
  ), true);
  assert.equal(taskChanges.some((task) =>
    task.turnId === "aborted-turn" && task.status === "running" && task.title === "执行新任务"
  ), true);
  assert.equal(taskChanges.some((task) =>
    task.turnId === "aborted-turn" && task.status === "interrupted"
  ), true);
  assert.deepEqual(
    activities.filter((activity) => activity.turnId === "new-turn").map((activity) => activity.text),
    [
      "🤔 正在分析现有实现",
      "🤔 正在兼容 Desktop 新格式",
      "已经找到进度丢失的位置",
      "✅ 执行本地操作完成",
      "✅ 检查图片完成",
      "✅ 调用 MCP 工具完成",
      "🔎 正在执行本地操作",
      "✅ 执行本地操作完成"
    ]
  );
});

test("does not restore a seven-hour-old unfinished turn from a recently touched session file", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-monitor-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");
  const sessionDir = path.join(root, ".codex", "sessions", "2026", "08", "01");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  writeLines(path.join(sessionDir, "stale.jsonl"), [
    sessionMeta("stale-session", workspace),
    taskStarted("stale-turn", "2026-08-01T02:00:01.000Z"),
    userMessage("已经过期的任务")
  ]);
  const taskChanges: CodexSessionTask[] = [];
  const monitor = new CodexSessionCompletionMonitor({
    codexHome: path.join(root, ".codex"),
    pollIntervalMs: 60_000,
    now: () => Date.parse("2026-08-01T09:00:00.000Z"),
    onCompletion: () => undefined,
    onTaskChanged: (task) => taskChanges.push(task)
  });
  monitor.start();
  t.after(() => monitor.stop());
  await monitor.ready();

  assert.deepEqual(taskChanges, []);
});

test("captures a completion appended while existing sessions are still initializing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-monitor-startup-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");
  const sessionDir = path.join(root, ".codex", "sessions", "2026", "08", "01");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const existing = path.join(sessionDir, "existing.jsonl");
  writeLines(existing, [
    sessionMeta("startup-session", workspace),
    taskStarted("startup-turn"),
    userMessage("启动期间完成的任务")
  ]);
  const completions: CodexSessionCompletion[] = [];
  const monitor = new CodexSessionCompletionMonitor({
    codexHome: path.join(root, ".codex"),
    pollIntervalMs: 60_000,
    now: () => Date.parse("2026-08-01T08:00:02.500Z"),
    onCompletion: (completion) => completions.push(completion)
  });

  monitor.start();
  t.after(() => monitor.stop());
  appendLines(existing, [taskComplete("startup-turn", "启动写入已保留")]);
  await monitor.ready();
  await monitor.scanNow();

  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.turnId, "startup-turn");
  assert.equal(completions[0]?.text, "启动写入已保留");
});

test("stops emitting completed turns once a live Codex session is archived", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-monitor-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "08", "01");
  const archivedSessionDir = path.join(codexHome, "archived_sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(archivedSessionDir, { recursive: true });
  const liveSession = path.join(sessionDir, "session.jsonl");
  writeLines(liveSession, [
    sessionMeta("archived-session", workspace),
    taskStarted("historical-turn"),
    userMessage("归档前已经完成的任务"),
    taskComplete("historical-turn", "历史结果")
  ]);
  const completions: CodexSessionCompletion[] = [];
  const monitor = new CodexSessionCompletionMonitor({
    codexHome,
    pollIntervalMs: 60_000,
    now: () => Date.parse("2026-08-01T09:00:00.000Z"),
    onCompletion: (completion) => completions.push(completion)
  });
  monitor.start();
  t.after(() => monitor.stop());
  await monitor.ready();

  const archivedSession = path.join(archivedSessionDir, "session.jsonl");
  fs.renameSync(liveSession, archivedSession);
  appendLines(archivedSession, [
    taskStarted("post-archive-turn"),
    userMessage("归档后继续写入的任务"),
    taskComplete("post-archive-turn", "归档后结果")
  ]);
  await monitor.scanNow();

  assert.deepEqual(completions, []);
});

test("does not emit restored task state after the monitor is stopped", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-monitor-stop-init-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");
  const sessionDir = path.join(root, ".codex", "sessions", "2026", "08", "01");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  writeLines(path.join(sessionDir, "existing.jsonl"), [
    sessionMeta("stopped-session", workspace),
    taskStarted("stopped-turn"),
    userMessage("停止后不应恢复")
  ]);
  const taskChanges: CodexSessionTask[] = [];
  const monitor = new CodexSessionCompletionMonitor({
    codexHome: path.join(root, ".codex"),
    pollIntervalMs: 60_000,
    now: () => Date.parse("2026-08-01T09:00:00.000Z"),
    onCompletion: () => undefined,
    onTaskChanged: (task) => taskChanges.push(task)
  });

  monitor.start();
  await monitor.stop();
  await monitor.ready();

  assert.deepEqual(taskChanges, []);
});

function sessionMeta(sessionId: string, cwd: string): object {
  return { timestamp: "2026-08-01T08:00:00.000Z", type: "session_meta", payload: { session_id: sessionId, cwd } };
}

function userMessage(message: string): object {
  return { timestamp: "2026-08-01T08:00:02.000Z", type: "event_msg", payload: { type: "user_message", message } };
}

function taskStarted(turnId: string, timestamp = "2026-08-01T08:00:01.000Z"): object {
  return { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: turnId } };
}

function taskComplete(turnId: string, message: string): object {
  return { timestamp: "2026-08-01T08:00:03.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: message } };
}

function turnAborted(turnId: string): object {
  return { timestamp: "2026-08-01T08:00:04.000Z", type: "event_msg", payload: { type: "turn_aborted", turn_id: turnId, reason: "interrupted" } };
}

function agentReasoning(text: string): object {
  return { timestamp: "2026-08-01T08:00:02.100Z", type: "event_msg", payload: { type: "agent_reasoning", text } };
}

function completedReasoning(text: string): object {
  return {
    timestamp: "2026-08-01T08:00:02.110Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: "new-turn",
      item: { type: "Reasoning", summary_text: [text], raw_content: [] }
    }
  };
}

function responseReasoning(text: string): object {
  return {
    timestamp: "2026-08-01T08:00:02.120Z",
    type: "response_item",
    payload: { type: "reasoning", summary: [{ type: "summary_text", text }] }
  };
}

function completedCommentary(text: string): object {
  return {
    timestamp: "2026-08-01T08:00:02.130Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: "new-turn",
      item: { type: "AgentMessage", phase: "commentary", content: [{ type: "Text", text }] }
    }
  };
}

function responseCommentary(text: string): object {
  return {
    timestamp: "2026-08-01T08:00:02.140Z",
    type: "response_item",
    payload: {
      type: "message",
      phase: "commentary",
      content: [{ type: "output_text", text }]
    }
  };
}

function completedDesktopItem(type: string, turnId: string): object {
  return {
    timestamp: "2026-08-01T08:00:02.150Z",
    type: "event_msg",
    payload: { type: "item_completed", turn_id: turnId, item: { type, status: "completed" } }
  };
}

function customToolCall(callId: string, name: string): object {
  return { timestamp: "2026-08-01T08:00:02.200Z", type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name, input: "{}" } };
}

function customToolCallOutput(callId: string): object {
  return { timestamp: "2026-08-01T08:00:02.300Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output: "ok" } };
}

function writeLines(filePath: string, lines: object[]): void {
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function appendLines(filePath: string, lines: object[]): void {
  fs.appendFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}
