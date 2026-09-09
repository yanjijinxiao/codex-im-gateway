import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireServiceProcessLock } from "../src/server/process-lock.js";

test("allows only one service process per state directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = acquireServiceProcessLock(root);
  t.after(() => first.release());

  assert.throws(() => acquireServiceProcessLock(root), /already running/);
  first.release();

  const second = acquireServiceProcessLock(root);
  second.release();
});

test("replaces a stale service process lock", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stale-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "service.lock"), JSON.stringify({
    pid: 2_147_483_647,
    startedAt: "2026-01-01T00:00:00.000Z"
  }));

  const lock = acquireServiceProcessLock(root);
  lock.release();
});

test("replaces a stale lock whose PID belongs to another account", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-eperm-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "service.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 424_242,
    startedAt: "2026-01-01T00:00:00.000Z"
  }));
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === 424_242 && signal === 0) {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    return originalKill(pid, signal);
  }) as typeof process.kill;

  try {
    const lock = acquireServiceProcessLock(root);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
    lock.release();
  } finally {
    process.kill = originalKill;
  }
});
