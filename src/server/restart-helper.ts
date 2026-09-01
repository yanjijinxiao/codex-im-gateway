import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [parentPidValue, entryPathValue, logPathValue] = process.argv.slice(2);
const parentPid = Number(parentPidValue);
const entryPath = path.resolve(entryPathValue || "");
const logPath = path.resolve(logPathValue || path.join(path.dirname(entryPath), "service-restart.log"));

if (!Number.isInteger(parentPid) || parentPid <= 0 || !entryPathValue || !fs.existsSync(entryPath)) {
  appendLog("Invalid restart-helper arguments");
  process.exitCode = 1;
} else {
  try {
    appendLog(`Waiting for service process ${parentPid} to exit`);
    await waitForProcessExit(parentPid, 60_000);
    await delay(400);
    const logFd = fs.openSync(logPath, "a");
    let child;
    try {
      child = spawn(process.execPath, [entryPath], {
        cwd: path.dirname(entryPath),
        detached: true,
        env: process.env,
        shell: false,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true
      });
    } finally {
      fs.closeSync(logFd);
    }
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    appendLog(`Started service process ${child.pid ?? "unknown"}`);
    child.unref();
  } catch (error) {
    appendLog(`Restart failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function appendLog(message: string): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // The helper must still attempt the restart when diagnostics cannot be written.
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for codex-channel-bridge to stop");
    }
    await delay(200);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
