#!/usr/bin/env node

import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
let nextTurn = 1;
const activeTurns = new Map();
const pendingApprovals = new Map();
const pendingToolCalls = new Map();
const pendingUserInputs = new Map();
const goals = new Map();
let externalBusyReads = 0;
let ephemeralThreadStarted = false;
let dynamicToolsEnabled = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function fail(id, message) {
  send({ id, error: { code: -32602, message } });
}

function completedTurn(id, status, error = null) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (message.jsonrpc) {
      fail(message.id, "jsonrpc header must be omitted");
      return;
    }
    if (message.params?.clientInfo?.name !== "codex-channel-bridge") {
      fail(message.id, "missing codex-channel-bridge clientInfo");
      return;
    }
    respond(message.id, {
      userAgent: "fake-codex",
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "test"
    });
    return;
  }

  if (message.method === "initialized") {
    initialized = true;
    return;
  }

  if (!initialized) {
    fail(message.id, "Not initialized");
    return;
  }

  if (!message.method && pendingApprovals.has(message.id)) {
    const approval = pendingApprovals.get(message.id);
    pendingApprovals.delete(message.id);
    const decision = approval.kind === "permissions"
      ? (Object.keys(message.result?.permissions ?? {}).length ? "accept" : "decline")
      : message.result?.decision;
    const itemId = `item-${approval.turnId}`;
    send({
      method: "item/completed",
      params: {
        threadId: approval.threadId,
        turnId: approval.turnId,
        completedAtMs: Date.now(),
        item: {
          type: "agentMessage",
          id: itemId,
          text: `approval:${approval.kind}:${decision}`,
          phase: "final_answer",
          memoryCitation: null
        }
      }
    });
    send({
      method: "turn/completed",
      params: { threadId: approval.threadId, turn: completedTurn(approval.turnId, "completed") }
    });
    activeTurns.delete(approval.threadId);
    return;
  }

  if (!message.method && pendingToolCalls.has(message.id)) {
    const pending = pendingToolCalls.get(message.id);
    pendingToolCalls.delete(message.id);
    const text = `tool:${message.result?.success}:${message.result?.contentItems?.[0]?.text ?? ""}`;
    send({ method: "item/completed", params: { threadId: pending.threadId, turnId: pending.turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `item-${pending.turnId}`, text, phase: "final_answer", memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId: pending.threadId, turn: completedTurn(pending.turnId, "completed") } });
    activeTurns.delete(pending.threadId);
    return;
  }

  if (!message.method && pendingUserInputs.has(message.id)) {
    const pending = pendingUserInputs.get(message.id);
    pendingUserInputs.delete(message.id);
    const text = `input:${message.result?.answers?.direction?.answers?.[0] ?? "none"}`;
    send({ method: "item/completed", params: { threadId: pending.threadId, turnId: pending.turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `item-${pending.turnId}`, text, phase: "final_answer", memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId: pending.threadId, turn: completedTurn(pending.turnId, "completed") } });
    activeTurns.delete(pending.threadId);
    return;
  }

  if (message.method === "thread/start") {
    if (message.params?.approvalPolicy !== "never") {
      fail(message.id, "approvalPolicy must be never");
      return;
    }
    ephemeralThreadStarted = message.params?.ephemeral === true;
    dynamicToolsEnabled = message.params?.dynamicTools?.[0]?.name === "knowledge";
    respond(message.id, {
      thread: { id: "thread-new" },
      model: message.params.model ?? "configured-model",
      reasoningEffort: "high"
    });
    return;
  }

  if (message.method === "thread/resume") {
    respond(message.id, {
      thread: { id: message.params.threadId },
      model: "resumed-model",
      reasoningEffort: "medium"
    });
    return;
  }

  if (message.method === "config/read") {
    respond(message.id, {
      config: {
        model: "configured-model",
        model_provider: "FixtureProvider",
        model_reasoning_effort: "high"
      },
      origins: {}
    });
    return;
  }

  if (message.method === "model/list") {
    respond(message.id, {
      data: [{
        id: "configured-model",
        model: "configured-model",
        displayName: "Configured Model",
        description: "Model used by the test fixture.",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deeper reasoning" }
        ],
        defaultReasoningEffort: "medium",
        isDefault: true
      }],
      nextCursor: null
    });
    return;
  }

  if (message.method === "account/rateLimits/read") {
    respond(message.id, {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 18.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
        credits: { hasCredits: true, unlimited: false, balance: "12.34" },
        individualLimit: null,
        spendControlReached: false,
        planType: "plus",
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null
    });
    return;
  }

  if (message.method === "thread/goal/get") {
    respond(message.id, { goal: goals.get(message.params.threadId) ?? null });
    return;
  }

  if (message.method === "thread/goal/set") {
    const current = goals.get(message.params.threadId);
    const goal = {
      threadId: message.params.threadId,
      objective: message.params.objective ?? current?.objective ?? "",
      status: message.params.status ?? current?.status ?? "active",
      tokenBudget: message.params.tokenBudget ?? current?.tokenBudget ?? null,
      tokensUsed: 42,
      timeUsedSeconds: 9,
      createdAt: current?.createdAt ?? 1,
      updatedAt: 2
    };
    goals.set(message.params.threadId, goal);
    respond(message.id, { goal });
    return;
  }

  if (message.method === "thread/goal/clear") {
    goals.delete(message.params.threadId);
    respond(message.id, { cleared: true });
    return;
  }

  if (message.method === "thread/list") {
    respond(message.id, { data: [{ id: "thread-new" }], nextCursor: null, backwardsCursor: null });
    return;
  }

  if (message.method === "thread/read") {
    const activeTurnId = activeTurns.get(message.params.threadId)
      ?? (message.params.threadId === "thread-external-busy" && externalBusyReads++ === 0
        ? "external-turn"
        : undefined);
    respond(message.id, {
      thread: {
        id: message.params.threadId,
        turns: [
          {
            id: "history-turn-1",
            status: "completed",
            startedAt: 1_700_000_000,
            completedAt: 1_700_000_002,
            items: [
              {
                type: "userMessage",
                id: "history-user-1",
                clientId: null,
                content: [{ type: "text", text: "hello history", text_elements: [] }]
              },
              {
                type: "agentMessage",
                id: "history-commentary-1",
                text: "working",
                phase: "commentary",
                memoryCitation: null
              },
              {
                type: "agentMessage",
                id: "history-assistant-1",
                text: "history reply",
                phase: "final_answer",
                memoryCitation: null
              },
              { type: "reasoning", id: "history-reasoning-1", summary: [], content: ["hidden"] }
            ]
          },
          ...(activeTurnId ? [completedTurn(activeTurnId, "inProgress")] : [])
        ]
      }
    });
    return;
  }

  if (message.method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const prompt = message.params?.input?.[0]?.text;
    if (message.params?.input?.[0]?.type !== "text" || typeof prompt !== "string") {
      fail(message.id, "turn/start requires text input");
      return;
    }
    const approvalKind = prompt.startsWith("approval:") ? prompt.slice("approval:".length) : undefined;
    const expectedApprovalPolicy = approvalKind ? "on-request" : "never";
    if (message.params?.approvalPolicy !== expectedApprovalPolicy) {
      fail(message.id, `turn approvalPolicy must be ${expectedApprovalPolicy}`);
      return;
    }
    if (prompt === "verify-danger-full-access"
      && message.params?.sandboxPolicy?.type !== "dangerFullAccess") {
      fail(message.id, "turn/start must propagate the configured danger-full-access sandbox");
      return;
    }
    if (prompt === "classify-intent"
      && (!ephemeralThreadStarted
        || message.params?.sandboxPolicy?.type !== "readOnly"
        || message.params?.outputSchema?.properties?.intent?.type !== "string")) {
      fail(message.id, "intent classification must use an ephemeral read-only thread with output schema");
      return;
    }
    if (prompt === "plan-mode" && message.params?.collaborationMode?.mode !== "plan") {
      fail(message.id, "turn/start must propagate plan collaboration mode");
      return;
    }
    activeTurns.set(message.params.threadId, turnId);
    respond(message.id, { turn: completedTurn(turnId, "inProgress") });
    if (["command", "file", "permissions"].includes(approvalKind)) {
      const approvalId = `approval-${turnId}`;
      pendingApprovals.set(approvalId, {
        kind: approvalKind,
        threadId: message.params.threadId,
        turnId
      });
      const method = approvalKind === "command"
        ? "item/commandExecution/requestApproval"
        : approvalKind === "file"
          ? "item/fileChange/requestApproval"
          : "item/permissions/requestApproval";
      send({
        id: approvalId,
        method,
        params: {
          threadId: message.params.threadId,
          turnId,
          itemId: `approval-item-${turnId}`,
          startedAtMs: Date.now(),
          cwd: "/tmp/project",
          command: approvalKind === "command" ? "touch approved.txt" : null,
          reason: `fixture ${approvalKind} approval`,
          grantRoot: approvalKind === "file" ? "/tmp/project" : null,
          permissions: approvalKind === "permissions" ? { network: { enabled: true } } : undefined
        }
      });
      return;
    }
    if (prompt === "hold") {
      return;
    }
    if (prompt === "dynamic-tool") {
      if (!dynamicToolsEnabled) {
        fail(message.id, "thread/start must register knowledge dynamic tools");
        return;
      }
      const requestId = `tool-${turnId}`;
      pendingToolCalls.set(requestId, { threadId: message.params.threadId, turnId });
      send({ id: requestId, method: "item/tool/call", params: { callId: requestId, threadId: message.params.threadId, turnId, namespace: "knowledge", tool: "search", arguments: { query: "fixture", limit: 3 } } });
      return;
    }
    if (prompt === "request-user-input") {
      const requestId = `input-${turnId}`;
      pendingUserInputs.set(requestId, { threadId: message.params.threadId, turnId });
      send({ id: requestId, method: "item/tool/requestUserInput", params: { itemId: requestId, threadId: message.params.threadId, turnId, questions: [{ header: "方向", id: "direction", question: "选择方向", options: [{ label: "方案 A", description: "使用 A" }, { label: "方案 B", description: "使用 B" }] }] } });
      return;
    }
    const sendProgress = () => {
      const progressItemId = `progress-${turnId}`;
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: { type: "agentMessage", id: progressItemId, text: "", phase: "commentary", memoryCitation: null }
        }
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId: message.params.threadId, turnId, itemId: progressItemId, delta: `working:${prompt}` }
      });
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: "agentMessage", id: progressItemId, text: `working:${prompt}`, phase: "commentary", memoryCitation: null }
        }
      });
    };
    const sendFinal = () => {
      const itemId = `item-${turnId}`;
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer", memoryCitation: null }
        }
      });
      for (const delta of ["reply:", prompt]) {
        send({
          method: "item/agentMessage/delta",
          params: { threadId: message.params.threadId, turnId, itemId, delta }
        });
      }
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: "agentMessage", id: itemId, text: `reply:${prompt}`, phase: "final_answer", memoryCitation: null }
        }
      });
      send({
        method: "turn/completed",
        params: { threadId: message.params.threadId, turn: completedTurn(turnId, "completed") }
      });
      activeTurns.delete(message.params.threadId);
    };
    if (prompt === "sliding-timeout") {
      setTimeout(sendProgress, 120);
      setTimeout(sendFinal, 260);
    } else {
      setTimeout(() => {
        sendProgress();
        sendFinal();
      }, prompt.startsWith("slow:") ? 75 : 5);
    }
    return;
  }

  if (message.method === "turn/interrupt") {
    const activeTurnId = activeTurns.get(message.params.threadId);
    if (activeTurnId !== message.params.turnId) {
      fail(message.id, "turn/interrupt used the wrong turnId");
      return;
    }
    respond(message.id, {});
    send({
      method: "turn/completed",
      params: { threadId: message.params.threadId, turn: completedTurn(activeTurnId, "interrupted") }
    });
    activeTurns.delete(message.params.threadId);
    return;
  }

  fail(message.id, `unsupported method: ${message.method}`);
});
