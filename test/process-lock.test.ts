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

test("preserves a lock when process inspection is denied", (t) => {
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
    assert.throws(() => acquireServiceProcessLock(root), /already running/);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 424_242);
  } finally {
    process.kill = originalKill;
  }
});

test("two starters recovering the same stale lock cannot both become state writers", async t => {
  const {fork} = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-lock-race-"));
  const child = fork(new URL("./fixtures/process-lock-contender.mjs", import.meta.url), [root], {execArgv: ["--import", "tsx"], silent: true});
  t.after(() => { child.kill(); fs.rmSync(root, {recursive: true, force: true}); });
  fs.writeFileSync(path.join(root, "service.lock"), JSON.stringify({pid: 2147483647, startedAt: new Date().toISOString()}));
  const result = new Promise<{acquired: boolean}>(resolve => child.once("message", message => resolve(message as {acquired: boolean})));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(root, "paused")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(path.join(root, "paused")));
  assert.throws(() => acquireServiceProcessLock(root), /recovery is already claimed/);
  fs.writeFileSync(path.join(root, "proceed"), "yes");
  assert.equal((await result).acquired, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "service.lock"), "utf8")).pid, child.pid);
  child.send("release"); await new Promise(resolve => child.once("exit", resolve));
});

test("an old handle cannot release a replacement lock with the same PID", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-lock-token-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const first = acquireServiceProcessLock(root), file = path.join(root, "service.lock");
  fs.rmSync(file); const replacement = acquireServiceProcessLock(root);
  first.release(); assert.equal(fs.existsSync(file), true);
  replacement.release(); assert.equal(fs.existsSync(file), false);
});
