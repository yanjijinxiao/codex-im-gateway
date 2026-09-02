import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RestartHelperOptions = {
  parentPid: number;
  entryPath: string;
  stateDir: string;
  port: number;
};

export function launchRestartHelper(options: RestartHelperOptions): void {
  if (!Number.isInteger(options.parentPid) || options.parentPid <= 0) {
    throw new Error("Invalid parent process id");
  }
  if (!path.isAbsolute(options.entryPath) || !path.isAbsolute(options.stateDir)) {
    throw new Error("Restart paths must be absolute");
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("Invalid restart port");
  }
  const helperPath = fileURLToPath(new URL("./restart-helper.js", import.meta.url));
  if (!fs.existsSync(helperPath) || !fs.existsSync(options.entryPath)) {
    throw new Error("Updated service entry point is unavailable");
  }
  const logPath = path.join(options.stateDir, "service-restart.log");
  const logFd = fs.openSync(logPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [helperPath, String(options.parentPid), options.entryPath, logPath], {
      cwd: path.dirname(options.entryPath),
      detached: true,
      env: {
        ...process.env,
        CODEX_IM_GATEWAY_OPEN: "0",
        CODEX_IM_GATEWAY_PORT: String(options.port),
        CODEX_IM_GATEWAY_STATE_DIR: options.stateDir,
        CODEX_CHANNEL_BRIDGE_OPEN: "0",
        CODEX_CHANNEL_BRIDGE_PORT: String(options.port),
        CODEX_CHANNEL_BRIDGE_STATE_DIR: options.stateDir
      },
      shell: false,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.once("error", (error) => {
    console.error(`[codex-im-gateway] unable to launch restart helper: ${error.message}`);
  });
  child.unref();
}
