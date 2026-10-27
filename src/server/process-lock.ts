import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ensureDir } from "../state/json-store.js";

type LockRecord = {
  pid: number;
  startedAt: string;
  token?: string;
};

export type ServiceProcessLock = {
  path: string;
  release: () => void;
};

export function acquireServiceProcessLock(stateRoot: string): ServiceProcessLock {
  ensureDir(stateRoot);
  const lockPath = path.join(stateRoot, "service.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      const token = randomUUID();
      const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString(), token };
      try { fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8"); }
      finally { fs.closeSync(descriptor); }
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          const current = readLockRecord(lockPath);
          if (current?.pid === process.pid && current.token === token) {
            fs.rmSync(lockPath, { force: true });
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Serialize stale-file removal. Without this second exclusive claim,
      // two starters can both read a dead PID; the slower one then deletes the
      // faster starter's NEW lock and both become writers of the same state.
      const recoveryPath = `${lockPath}.recovery`, recoveryToken = randomUUID();
      let recovery: number;
      try { recovery = fs.openSync(recoveryPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(`Gateway lock recovery is already claimed: ${recoveryPath}; check its owner before removing a stale recovery record`);
        throw error;
      }
      try {
        try { fs.writeFileSync(recovery, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: recoveryToken })); }
        finally { fs.closeSync(recovery); }
        const existing = readLockRecord(lockPath);
        if (!existing) throw new Error(`codex-im-gateway lock is unreadable: ${lockPath}`);
        if (isProcessRunning(existing.pid))
          throw new Error(`codex-im-gateway is already running for ${stateRoot} (PID ${existing.pid})`);
        fs.rmSync(lockPath, { force: true });
      } finally {
        if (readLockRecord(recoveryPath)?.token === recoveryToken) fs.rmSync(recoveryPath, { force: true });
      }
    }
  }
  throw new Error(`Unable to acquire codex-im-gateway lock: ${lockPath}`);
}

function readLockRecord(lockPath: string): LockRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    return Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.startedAt === "string"
      ? value as LockRecord
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A sandbox/security policy can also deny inspection of a live same-user
    // process. Only a definite missing PID permits stale-lock removal.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
