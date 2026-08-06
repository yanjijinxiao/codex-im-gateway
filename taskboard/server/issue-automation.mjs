import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildTaskboardAutomationPrompt,
  parseStoredTaskboardAutomationPolicy,
} from "../shared/taskboard-automation.mjs";
import { readCodexQuotaStatus } from "../scripts/codex-rate-limits.mjs";
import { buildCodexArgs, spawnCodexTurn } from "./ai-chat-process.mjs";

export function createIssueAutomation({
  automationPoliciesPath,
  codexExecutable,
  processEnv = process.env,
  readQuota = readCodexQuotaStatus,
  spawnTurn = spawnCodexTurn,
  logger = console,
}) {
  const activeRuns = new Map();
  const pendingStarts = new Map();
  let closing = false;

  async function readPolicy(projectId) {
    let stored;
    try {
      stored = JSON.parse(await readFile(automationPoliciesPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
    return parseStoredTaskboardAutomationPolicy(stored[projectId]);
  }

  async function start(projectId) {
    if (closing) return { started: false, reason: "closing" };
    const active = activeRuns.get(projectId);
    if (active) {
      active.triggeredWhileRunning = true;
      return { started: false, reason: "already-running" };
    }

    const policy = await readPolicy(projectId);
    if (closing) return { started: false, reason: "closing" };
    if (!policy?.enabledByUser) return { started: false, reason: "disabled" };

    if (policy.quotaAware) {
      const quota = await readQuota(policy.model);
      if (closing) return { started: false, reason: "closing" };
      if (quota?.state !== "available") {
        return { started: false, reason: "quota", quota };
      }
    }

    const taskboardRoot = path.resolve(path.dirname(policy.skillPath), "../..");
    const thread = {
      sandbox: "workspace-write",
      model: policy.model,
      reasoningEffort: policy.reasoningEffort,
      codexThreadId: null,
      origin: {
        projectId: policy.taskboardProjectId,
        projectName: policy.projectName,
        workspacePath: policy.workspacePath,
      },
    };
    const args = buildCodexArgs(thread, [taskboardRoot]);
    const prompt = buildTaskboardAutomationPrompt(policy);
    const run = spawnTurn({
      executable: codexExecutable,
      args,
      prompt,
      env: processEnv,
      onRawEvent(raw) {
        if (raw?.type === "turn.failed" || raw?.type === "error") {
          logger.error(`Taskboard issue automation event failed for ${projectId}: ${raw.error?.message ?? raw.message ?? "unknown error"}`);
        }
      },
    });
    const record = {
      child: run.child,
      completion: run.completion,
      triggeredWhileRunning: false,
    };
    activeRuns.set(projectId, record);
    logger.info(`Taskboard issue automation started for ${projectId}`);

    run.completion
      .then(({ exitCode, signal }) => {
        if (exitCode !== 0) {
          logger.error(`Taskboard issue automation exited for ${projectId} (${signal ?? exitCode})`);
        }
      })
      .catch((error) => {
        logger.error(`Taskboard issue automation failed for ${projectId}: ${error.message}`);
      })
      .finally(() => {
        if (activeRuns.get(projectId) !== record) return;
        activeRuns.delete(projectId);
        logger.info(`Taskboard issue automation stopped for ${projectId}`);
        if (!closing && record.triggeredWhileRunning) {
          trigger({ projectId }).catch((error) => {
            logger.error(`Taskboard issue automation retrigger failed for ${projectId}: ${error.message}`);
          });
        }
      });

    return { started: true };
  }

  function trigger(task) {
    const projectId = task?.projectId;
    if (typeof projectId !== "string" || projectId.length === 0) {
      return Promise.resolve({ started: false, reason: "invalid-task" });
    }
    const active = activeRuns.get(projectId);
    if (active) {
      active.triggeredWhileRunning = true;
      return Promise.resolve({ started: false, reason: "already-running" });
    }
    const pending = pendingStarts.get(projectId);
    if (pending) return pending;

    const tracked = start(projectId).finally(() => {
      if (pendingStarts.get(projectId) === tracked) pendingStarts.delete(projectId);
    });
    pendingStarts.set(projectId, tracked);
    return tracked;
  }

  async function close() {
    closing = true;
    pendingStarts.clear();
    const running = [...activeRuns.values()];
    for (const { child } of running) {
      if (!Number.isInteger(child.pid)) continue;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    let graceTimeout;
    const gracePeriod = new Promise((resolve) => {
      graceTimeout = setTimeout(resolve, 2_000);
    });
    await Promise.race([
      Promise.allSettled(running.map((run) => run.completion)),
      gracePeriod,
    ]);
    clearTimeout(graceTimeout);
    for (const { child } of activeRuns.values()) {
      if (!Number.isInteger(child.pid)) continue;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    activeRuns.clear();
  }

  return { trigger, close };
}
