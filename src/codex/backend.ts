import type { CodexAccountBalance } from "./account-balance.js";
import type { CodexApprovalHandler } from "./approval.js";
import type { CodexExecSandbox } from "./sandbox.js";

/** The two logical Codex execution engines exposed by Bridge. */
export type CodexBackendId = "exec" | "app-server";

export type CodexBackendCapabilities = {
  readonly streaming: boolean;
  readonly progress: boolean;
  readonly approvals: boolean;
  readonly dynamicTools: boolean;
  readonly userInput: boolean;
  readonly structuredOutput: boolean;
  readonly collaborationModes: boolean;
  readonly history: boolean;
  readonly runtimeInfo: boolean;
  readonly models: boolean;
  readonly accountRateLimits: boolean;
  readonly goals: boolean;
  /** Lists the projects/workspaces visible to this concrete backend. */
  readonly projectCatalog: boolean;
  /** Natively binds a thread to an app-server project id. */
  readonly projects: boolean;
  readonly threadNaming: boolean;
  readonly developerInstructions: boolean;
  readonly threadInspection: boolean;
  readonly threadLifecycle: boolean;
};

export type CodexThreadPersistence = "active" | "archived" | "ephemeral" | "missing" | "unknown";
export type CodexThreadRuntimeStatus = "notLoaded" | "idle" | "active" | "systemError" | "unknown";
export type CodexThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";
export type CodexTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export type CodexThreadState = {
  threadId: string;
  persistence: CodexThreadPersistence;
  runtimeStatus: CodexThreadRuntimeStatus;
  activeFlags: CodexThreadActiveFlag[];
  latestTurnStatus?: CodexTurnStatus;
  activeTurnId?: string;
  cwd?: string;
  projectId?: string;
  title?: string;
  preview?: string;
  updatedAt?: string;
};

export type CodexThreadListInput = {
  cwd?: string;
  projectId?: string;
  persistence?: "active" | "archived" | "all";
  limit?: number;
};

export type CodexStopResult = "interrupted" | "not-active";
export type CodexThreadStateErrorCode = "archived" | "missing" | "system-error";

export class CodexThreadStateError extends Error {
  constructor(
    readonly code: CodexThreadStateErrorCode,
    readonly threadId: string,
    message: string
  ) {
    super(message);
    this.name = "CodexThreadStateError";
  }
}

export function assertCodexThreadRunnable(state: CodexThreadState): void {
  if (state.persistence === "archived") {
    throw new CodexThreadStateError(
      "archived",
      state.threadId,
      `Codex session ${state.threadId} 已归档。请先在 Codex App 中恢复该 session 后再重试。`
    );
  }
  if (state.persistence === "missing") {
    throw new CodexThreadStateError(
      "missing",
      state.threadId,
      `Codex session ${state.threadId} 不存在或已被删除，请重新选择 session。`
    );
  }
  if (state.runtimeStatus === "systemError") {
    throw new CodexThreadStateError(
      "system-error",
      state.threadId,
      `Codex session ${state.threadId} 当前处于系统错误状态，请先在 Codex App 中打开并修复。`
    );
  }
}

export type CodexRunResult = {
  text: string;
  threadId?: string;
  turnId?: string;
  raw: string;
};

export type CodexDynamicToolCall = {
  callId: string;
  threadId: string;
  turnId: string;
  namespace?: string;
  tool: string;
  arguments: unknown;
};

export type CodexDynamicToolHandler = (call: CodexDynamicToolCall) => Promise<string>;

export type CodexUserInputQuestion = {
  header: string;
  id: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
};

export type CodexUserInputRequest = {
  itemId: string;
  threadId: string;
  turnId: string;
  autoResolutionMs?: number;
  questions: CodexUserInputQuestion[];
};

export type CodexUserInputAnswer = Record<string, { answers: string[] }>;
export type CodexUserInputHandler = (request: CodexUserInputRequest) => Promise<CodexUserInputAnswer>;

export type CodexRunnerInput = {
  prompt: string;
  developerInstructions?: string;
  cwd: string;
  hostId?: string;
  /** Desktop-facing project id, used as a hint; app-server resolves its native id by cwd. */
  projectId?: string;
  projectName?: string;
  threadId?: string;
  threadTitle?: string;
  onThreadCreated?: (threadId: string) => Promise<void> | void;
  queueKey?: string;
  model?: string;
  effort?: string;
  onDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
  onApproval?: CodexApprovalHandler;
  onDynamicToolCall?: CodexDynamicToolHandler;
  onUserInput?: CodexUserInputHandler;
  dynamicTools?: readonly Record<string, unknown>[];
  collaborationMode?: "default" | "plan";
  ephemeral?: boolean;
  outputSchema?: Record<string, unknown>;
  sandbox?: CodexExecSandbox;
};

export type EphemeralCodexRunnerInput = {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly outputSchema?: Record<string, unknown>;
};

export type CodexHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  kind?: "progress";
  createdAt?: string;
};

export type CodexRuntimeInfo = {
  model?: string;
  effort?: string;
  provider?: string;
};

export type CodexModelOption = {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultEffort?: string;
  supportedEfforts: Array<{
    effort: string;
    description: string;
  }>;
};

/** Normalized project entry returned by either concrete Codex backend. */
export type CodexProject = {
  id: string;
  name: string;
  roots: string[];
  lastUsedAt?: string;
  sessionCount?: number;
};

/** Keeps the project source explicit so fallback never mixes backend catalogs. */
export type CodexProjectCatalog = {
  backend: CodexBackendId;
  projects: CodexProject[];
};

export type CodexThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export type CodexThreadGoal = {
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

/** Shared contract implemented independently by the CLI and app-server backends. */
export interface CodexBackendAdapter {
  readonly id: CodexBackendId;
  readonly capabilities: CodexBackendCapabilities;
  run(input: CodexRunnerInput): Promise<CodexRunResult>;
  stop(threadId?: string): Promise<CodexStopResult>;
  warmUp(cwd: string): Promise<void>;
  listProjects(): Promise<CodexProjectCatalog>;
  close(): void;
}

/** @deprecated Use CodexBackendAdapter. */
export type CodexTurnBackend = CodexBackendAdapter;

/**
 * Internal continuation path used only when Codex Desktop owns the writer for
 * an app-server thread. It is deliberately not a user-selectable backend.
 */
export interface CodexThreadContinuation {
  readonly id: "desktop-relay";
  run(input: CodexRunnerInput): Promise<CodexRunResult>;
  stop(threadId?: string): Promise<CodexStopResult>;
  close(): void;
}

/** Full app-server contract. CLI intentionally does not fake these protocol-only operations. */
export interface CodexAppServerBackend extends CodexBackendAdapter {
  readonly id: "app-server";
  getHistory(threadId: string): Promise<CodexHistoryMessage[]>;
  getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo>;
  listModels(): Promise<CodexModelOption[]>;
  getAccountRateLimits(): Promise<CodexAccountBalance>;
  getGoal(threadId: string): Promise<CodexThreadGoal | undefined>;
  setGoal(
    threadId: string,
    input: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number }
  ): Promise<CodexThreadGoal | undefined>;
  clearGoal(threadId: string): Promise<void>;
  inspectThread(threadId: string): Promise<CodexThreadState>;
  listThreads(input?: CodexThreadListInput): Promise<CodexThreadState[]>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<CodexThreadState>;
  deleteThread(threadId: string): Promise<void>;
}

/** Stable facade consumed by channels, Web, intent routing, and account management. */
export interface CodexBridgeBackend {
  run(input: CodexRunnerInput): Promise<CodexRunResult>;
  stop(threadId?: string, hostId?: string): Promise<CodexStopResult>;
  runEphemeral(input: EphemeralCodexRunnerInput): Promise<CodexRunResult>;
  warmUp(cwd: string, hostId?: string): Promise<void>;
  listProjects(hostId?: string): Promise<CodexProjectCatalog>;
  getHistory(threadId: string, hostId?: string): Promise<CodexHistoryMessage[]>;
  getRuntimeInfo(cwd: string, threadId?: string, hostId?: string): Promise<CodexRuntimeInfo>;
  listModels(): Promise<CodexModelOption[]>;
  getAccountRateLimits(): Promise<CodexAccountBalance>;
  getGoal(threadId: string, hostId?: string): Promise<CodexThreadGoal | undefined>;
  setGoal(
    threadId: string,
    input: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number },
    hostId?: string
  ): Promise<CodexThreadGoal | undefined>;
  clearGoal(threadId: string, hostId?: string): Promise<void>;
  inspectThread(threadId: string, hostId?: string): Promise<CodexThreadState>;
  listThreads(input?: CodexThreadListInput, hostId?: string): Promise<CodexThreadState[]>;
  archiveThread(threadId: string, hostId?: string): Promise<void>;
  unarchiveThread(threadId: string, hostId?: string): Promise<CodexThreadState>;
  deleteThread(threadId: string, hostId?: string): Promise<void>;
  close(): void;
}

export const EXEC_BACKEND_CAPABILITIES: CodexBackendCapabilities = Object.freeze({
  streaming: false,
  progress: false,
  approvals: false,
  dynamicTools: false,
  userInput: false,
  structuredOutput: false,
  collaborationModes: false,
  history: false,
  runtimeInfo: false,
  models: false,
  accountRateLimits: false,
  goals: false,
  projectCatalog: true,
  projects: false,
  threadNaming: false,
  developerInstructions: false,
  threadInspection: false,
  threadLifecycle: false
});

export const APP_SERVER_BACKEND_CAPABILITIES: CodexBackendCapabilities = Object.freeze({
  streaming: true,
  progress: true,
  approvals: true,
  dynamicTools: true,
  userInput: true,
  structuredOutput: true,
  collaborationModes: true,
  history: true,
  runtimeInfo: true,
  models: true,
  accountRateLimits: true,
  goals: true,
  projectCatalog: true,
  projects: true,
  threadNaming: true,
  developerInstructions: true,
  threadInspection: true,
  threadLifecycle: true
});
