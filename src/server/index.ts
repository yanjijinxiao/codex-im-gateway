#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import open from "open";

import { loadConfig } from "../state/config.js";
import { preferredStateDir, resolveStatePaths } from "../state/paths.js";
import { TaskboardLifecycle } from "../taskboard/lifecycle.js";
import { AccountManager } from "./account-manager.js";
import { parseServerCommand, serverHelpText } from "./arguments.js";
import { startLocalHttpServer } from "./http-server.js";
import { acquireServiceProcessLock } from "./process-lock.js";
import { launchRestartHelper } from "./restart.js";
import { cleanupResources } from "./cleanup.js";

async function main(): Promise<void> {
  const stateDir = process.env.CODEX_IM_GATEWAY_STATE_DIR
    ?? process.env.CODEX_CHANNEL_BRIDGE_STATE_DIR
    ?? process.env.CODEX_WEIXIN_STATE_DIR
    ?? preferredStateDir();
  const port = parsePort(
    process.env.CODEX_IM_GATEWAY_PORT
      ?? process.env.CODEX_CHANNEL_BRIDGE_PORT
      ?? process.env.CODEX_WEIXIN_PORT
  );
  const paths = resolveStatePaths(stateDir);
  const config = loadConfig(paths);
  const processLock = acquireServiceProcessLock(paths.root);
  const accountManager = new AccountManager({ paths });
  let server: Awaited<ReturnType<typeof startLocalHttpServer>> | undefined;
  const taskboard = new TaskboardLifecycle(paths.taskboardDir);
  let shutdownTask: Promise<void> | undefined;
  let restartScheduled = false;
  const shutdown = () => shutdownTask ??= cleanupResources([
    () => accountManager.stopAll(), () => server?.close(), () => taskboard.close()
  ], "Gateway 部分资源清理失败，其余资源已继续清理", () => processLock.release());
  const exitAfterShutdown = () => void shutdown().then(() => process.exit(0), error => {
    console.error(`[codex-im-gateway] shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  const scheduleRestart = (version: string) => {
    if (restartScheduled) return;
    restartScheduled = true;
    const timer = setTimeout(async () => {
      try {
        await launchRestartHelper({
          parentPid: process.pid,
          entryPath: fileURLToPath(import.meta.url),
          stateDir: paths.root,
          port
        });
      } catch (error) {
        restartScheduled = false;
        console.error(`[codex-im-gateway] unable to restart after update: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      console.log(`[codex-im-gateway] updated to ${version}; restarting`);
      exitAfterShutdown();
    }, 500);
    timer.unref();
  };
  try {
    await taskboard.apply(config);
    server = await startLocalHttpServer({ paths, accountManager, port, onUpdateInstalled: scheduleRestart,
      onTaskboardConfig: next => taskboard.apply(next) });
    await accountManager.startAll();
  } catch (error) {
    try { await shutdown(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Gateway 启动失败且清理发生异常；已尝试清理全部资源"); }
    throw error;
  }

  console.log(`codex-im-gateway is running at ${server.url}`);
  console.log(`State directory: ${paths.root}`);
  if (config.taskboardEnabled) console.log(`Taskboard is available at ${config.taskboardUrl}`);
  if ((process.env.CODEX_IM_GATEWAY_OPEN
    ?? process.env.CODEX_CHANNEL_BRIDGE_OPEN
    ?? process.env.CODEX_WEIXIN_OPEN) !== "0") {
    void open(server.url).catch((error: unknown) => {
      console.warn(`Unable to open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  process.once("SIGINT", exitAfterShutdown);
  process.once("SIGTERM", exitAfterShutdown);
}

function parsePort(value: string | undefined): number {
  if (!value) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid CODEX_IM_GATEWAY_PORT: ${value}`);
  }
  return port;
}

async function run(): Promise<void> {
  const command = parseServerCommand(process.argv.slice(2));
  if (command === "help") {
    console.log(serverHelpText());
    return;
  }
  await main();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
