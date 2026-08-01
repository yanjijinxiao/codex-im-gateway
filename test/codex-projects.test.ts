import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listCodexProjectCandidates, listCodexSessionCandidates } from "../src/server/codex-projects.js";

test("reads and deduplicates existing projects from Codex session metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-project-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "projects", "嘉兴AI社区");
  const otherProject = path.join(root, "projects", "视频项目");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(otherProject);
  const sessions = path.join(root, ".codex", "sessions", "2026", "07", "30");
  const archived = path.join(root, ".codex", "archived_sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });

  // Given Codex session metadata with repeated and missing workspaces
  writeSession(path.join(sessions, "one.jsonl"), project, "2026-07-30T08:00:00.000Z");
  writeSession(path.join(sessions, "two.jsonl"), project, "2026-07-30T09:00:00.000Z");
  writeSession(path.join(sessions, "subagent.jsonl"), project, "2026-07-30T09:30:00.000Z", "subagent");
  writeSession(path.join(archived, "three.jsonl"), otherProject, "2026-07-29T09:00:00.000Z");
  writeSession(path.join(sessions, "missing.jsonl"), path.join(root, "missing"), "2026-07-30T10:00:00.000Z");
  fs.writeFileSync(path.join(sessions, "malformed.jsonl"), "not-json\n");
  fs.writeFileSync(path.join(sessions, "wrong-cwd-type.jsonl"), JSON.stringify({
    type: "session_meta",
    payload: { cwd: { path: project } }
  }));
  fs.writeFileSync(path.join(sessions, "missing-payload.jsonl"), JSON.stringify({
    type: "session_meta"
  }));
  fs.writeFileSync(path.join(sessions, "truncated.jsonl"), JSON.stringify({
    type: "session_meta",
    payload: { cwd: project }
  }).slice(0, -3));
  fs.writeFileSync(path.join(sessions, "oversized.jsonl"), JSON.stringify({
    type: "session_meta",
    payload: { cwd: project },
    padding: "x".repeat(140 * 1024)
  }));
  if (process.platform !== "win32") {
    const linkedProject = path.join(root, "projects", "linked-video-project");
    fs.symlinkSync(otherProject, linkedProject);
    writeSession(path.join(sessions, "symlink-workspace.jsonl"), linkedProject, "2026-07-29T10:00:00.000Z");
    const externalSessions = path.join(root, "external-sessions");
    fs.mkdirSync(externalSessions);
    writeSession(path.join(externalSessions, "outside.jsonl"), project, "2026-07-30T11:00:00.000Z");
    fs.symlinkSync(externalSessions, path.join(sessions, "linked-session-directory"));
  }

  // When Codex projects are listed
  const projects = listCodexProjectCandidates(path.join(root, ".codex"));

  // Then existing directories are deduplicated and ordered by last use
  assert.deepEqual(projects, [{
    name: "嘉兴AI社区",
    workspace: fs.realpathSync(project),
    lastUsedAt: "2026-07-30T09:00:00.000Z",
    sessionCount: 2
  }, {
    name: "视频项目",
    workspace: fs.realpathSync(otherProject),
    lastUsedAt: process.platform === "win32"
      ? "2026-07-29T09:00:00.000Z"
      : "2026-07-29T10:00:00.000Z",
    sessionCount: process.platform === "win32" ? 1 : 2
  }]);
});

test("lists the latest Codex sessions for one project with their real thread ids", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const otherProject = path.join(root, "other");
  const sessions = path.join(root, ".codex", "sessions", "2026", "08", "01");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(otherProject);
  fs.mkdirSync(sessions, { recursive: true });
  writeSessionWithMessages(
    path.join(sessions, "older.jsonl"),
    "thread-older",
    project,
    "2026-08-01T08:00:00.000Z",
    ["最初的问题", "继续处理"]
  );
  writeSessionWithMessages(
    path.join(sessions, "newer.jsonl"),
    "thread-newer",
    project,
    "2026-08-01T09:00:00.000Z",
    ["最新项目会话"]
  );
  writeSessionWithMessages(
    path.join(sessions, "other.jsonl"),
    "thread-other",
    otherProject,
    "2026-08-01T10:00:00.000Z",
    ["其他项目"]
  );
  writeSessionWithMessages(
    path.join(sessions, "subagent.jsonl"),
    "thread-subagent",
    project,
    "2026-08-01T11:00:00.000Z",
    ["子任务"] ,
    "subagent"
  );

  assert.deepEqual(listCodexSessionCandidates(project, path.join(root, ".codex")), [{
    threadId: "thread-newer",
    workspace: fs.realpathSync(project),
    lastUsedAt: "2026-08-01T09:00:01.000Z",
    lastUserMessage: "最新项目会话"
  }, {
    threadId: "thread-older",
    workspace: fs.realpathSync(project),
    lastUsedAt: "2026-08-01T08:00:02.000Z",
    lastUserMessage: "继续处理"
  }]);
});

function writeSession(filePath: string, cwd: string, timestamp: string, threadSource = "user"): void {
  fs.writeFileSync(filePath, `${JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: { cwd, timestamp, thread_source: threadSource }
  })}\n${JSON.stringify({ type: "response_item", payload: {} })}\n`);
}

function writeSessionWithMessages(
  filePath: string,
  threadId: string,
  cwd: string,
  timestamp: string,
  messages: string[],
  threadSource = "user"
): void {
  const start = Date.parse(timestamp);
  fs.writeFileSync(filePath, `${[
    {
      timestamp,
      type: "session_meta",
      payload: { id: threadId, cwd, timestamp, thread_source: threadSource }
    },
    ...messages.map((message, index) => ({
      timestamp: new Date(start + (index + 1) * 1_000).toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message }
    }))
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);
}
