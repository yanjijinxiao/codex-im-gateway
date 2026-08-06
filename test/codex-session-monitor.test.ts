import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexSessionCompletionMonitor,
  type CodexSessionCompletion,
  type CodexSessionTask
} from "../src/server/codex-session-monitor.js";

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
  const taskChanges: CodexSessionTask[] = [];
  const monitor = new CodexSessionCompletionMonitor({
    codexHome: path.join(root, ".codex"),
    pollIntervalMs: 60_000,
    now: () => Date.parse("2026-08-01T09:00:00.000Z"),
    onCompletion: (completion) => completions.push(completion),
    onTaskChanged: (task) => taskChanges.push(task)
  });
  monitor.start();
  t.after(() => monitor.stop());
  await monitor.ready();

  appendLines(existing, [
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

function writeLines(filePath: string, lines: object[]): void {
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function appendLines(filePath: string, lines: object[]): void {
  fs.appendFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}
