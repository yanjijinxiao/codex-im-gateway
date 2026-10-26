import type { CodexAccountBalance } from "./account-balance.js";
import type { CodexApprovalHandler, CodexApprovalResultHandler } from "./approval.js";
import type { CodexExecSandbox } from "./sandbox.js";
import { codexFailureCode, type CodexFailureCode } from "./turn-failure.js";
import type { CodexTurnRecovery } from "./turn-recovery.js";

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
  /** Pages stored thread history without resuming or taking writer ownership. */
  readonly historyPaging: boolean;
  /** Appends user input to the currently active turn. */
  readonly turnSteering: boolean;
  /** Experimental native queue API; older servers can explicitly reject it. */
  readonly nativeQueue?: boolean;
  /** Can follow activity produced by a turn that was started elsewhere. */
  readonly liveFollow: boolean;
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
  internal?: boolean;
  persistence: CodexThreadPersistence;
  runtimeStatus: CodexThreadRuntimeStatus;
  activeFlags: CodexThreadActiveFlag[];
  latestTurnStatus?: CodexTurnStatus;
  /** Only the current failed tail, normalized at the native boundary; no raw provider body. */
  lastTurnFailure?: { turnId: string; code: CodexFailureCode };
  /** Nonterminal native error observation, scoped to the exact active turn. */
  recovery?: CodexTurnRecovery;
  activeTurnId?: string;
  /** The owner has an unacknowledged UI turn, but no actual active execution. */
  pendingTurnWithoutId?: boolean;
  /** Live execution authority; a private storage reader is not the Desktop owner. */
  executionOwner?: "desktop";
  cwd?: string;
  projectId?: string;
  /** Explicit membership, distinct from a legacy cwd-derived display group.
   * Unknown observations must not grant IDE access or erase a known binding. */
  projectMembership?: "assigned" | "none" | "unknown";
  /** CLI's derived workspace catalog key, for display grouping only; not native membership. */
  workspaceProjectId?: string;
  title?: string;
  preview?: string;
  updatedAt?: string;
};

export type CodexThreadListInput = {
  cwd?: string;
  projectId?: string;
  /** Filter by native project membership, not by matching a working directory. */
  unassigned?: boolean;
  persistence?: "active" | "archived" | "all";
  limit?: number;
};

/** User-facing discovery is not the same operation as listing backend storage.
 * In particular, Desktop owns its catalog, while CLI discovers local rollouts.
 */
export type CodexSessionCatalog = {
  backend: CodexBackendId;
  source: "desktop-catalog" | "app-server-storage" | "cli-rollouts";
  threads: CodexThreadState[];
  hostIds: string[];
  complete: boolean;
  warnings: string[];
};

export type CodexStopResult = "interrupted" | "not-active";
export type CodexInputReceipt = {
  status: "accepted";
  threadId: string;
  turnId: string;
};
export type CodexSteerResult = CodexInputReceipt;

/** Ordinary input targets a conversation, not a caller-selected execution.
 * The native owner selects its receiving turn; this is NOT compare-and-steer.
 */
export type CodexThreadMessageInput = {
  threadId: string;
  prompt: string;
  cwd: string;
  clientUserMessageId: string;
  /** Recheck binding identity immediately before the native write. */
  assertCurrent?: () => void;
};

export type CodexSteerInput = {
  threadId: string;
  prompt: string;
  /** Compare-and-steer guard. Required by app-server when the caller knows the active turn. */
  expectedTurnId?: string;
  /** Used by the Codex Desktop relay to reconstruct the visible user message. */
  cwd?: string;
  clientUserMessageId?: string;
};

export type CodexQueuedSubmission = {
  id: string;
  clientUserMessageId: string;
  input: Array<{ type: string; text?: string; [key: string]: unknown }>;
};
export type CodexQueuePage = { data: CodexQueuedSubmission[]; nextCursor?: string };
export type CodexQueueAddInput = {
  threadId: string; prompt: string; clientUserMessageId: string;
  onApproval?: CodexApprovalHandler;
  onApprovalResult?: CodexApprovalResultHandler;
  onUserInput?: CodexUserInputHandler;
  onUserInputResult?: CodexUserInputResultHandler;
  onAccepted?: (turnId: string) => Promise<void> | void;
};
/** Queue execution consumes a server-owned item, never resubmits its prompt. */
export type CodexQueuedRunInput = Omit<CodexRunnerInput, "prompt" | "threadId"> & {
  threadId: string;
  queuedSubmissionId?: string;
  clientUserMessageId?: string;
  /** Observe an already consumed native item, without starting anything. */
  acceptedTurnId?: string;
  /** Terminal receipt recovery may read a result even after ownership changes. */
  observeOnly?: boolean;
  onQueueStarting?: () => Promise<void> | void;
};

export interface CodexNativeQueue {
  addQueuedSubmission(input: CodexQueueAddInput, hostId?: string): Promise<CodexQueuedSubmission>;
  listQueuedSubmissions(threadId: string, cursor?: string, hostId?: string): Promise<CodexQueuePage>;
  deleteQueuedSubmission(threadId: string, queuedSubmissionId: string, hostId?: string): Promise<boolean>;
  runQueuedSubmission(input: CodexQueuedRunInput): Promise<CodexRunResult>;
}

export type CodexHistoryPageInput = {
  cursor?: string;
  limit?: number;
  sortDirection?: "asc" | "desc";
};

export type CodexHistoryPage = {
  messages: CodexHistoryMessage[];
  nextCursor?: string;
  backwardsCursor?: string;
};

export class CodexBackendCapabilityError extends Error {
  constructor(readonly capability: keyof CodexBackendCapabilities, backend: CodexBackendId) {
    super(`Codex ${backend} backend does not support ${capability}`);
    this.name = "CodexBackendCapabilityError";
  }
}
export class CodexInterventionError extends Error {
  constructor(message: string) { super(message); this.name = "CodexInterventionError"; }
}
export class CodexTurnExecutionError extends Error {
  readonly failureCode: CodexFailureCode;
  constructor(readonly status: "interrupted" | "failed", message: string, failureCode?: CodexFailureCode) {
    super(message); this.name = "CodexTurnExecutionError";
    this.failureCode = failureCode ?? codexFailureCode(message);
  }
}
/** Explicit negative discovery BEFORE submission; never a transport timeout or an uncertain acknowledgement. */
export class CodexOwnerUnavailableError extends Error {
  readonly code = "no-client-found";
  readonly operation = "thread-owner-discovery";
  constructor() {
    super("Codex Desktop has no live thread owner (no-client-found); no message was submitted");
    this.name = "CodexOwnerUnavailableError";
  }
}
export type CodexThreadStateErrorCode = "archived" | "missing" | "system-error";

export class CodexThreadStateError extends Error {
  constructor(
    readonly code: CodexThreadStateErrorCode,
    readonly threadId: string,
    message: string,
    readonly lastTurnFailure?: CodexThreadState["lastTurnFailure"]
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
      `Codex session ${state.threadId} 当前处于系统错误状态，请先在 Codex App 中打开并修复。`,
      state.lastTurnFailure
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
  valueSchema?: import("./elicitation.js").ElicitationField;
  header: string;
  id: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  isSecret?: boolean;
  isOther?: boolean;
};

export type CodexUserInputRequest = {
  kind?: "sync" | "async";
  requestId?: string | number;
  hostId?: string;
  itemId: string;
  threadId: string;
  turnId: string;
  autoResolutionMs?: number | null;
  questions: CodexUserInputQuestion[];
};

export type CodexUserInputAnswer = Record<string, { answers: string[] }>;
export type CodexUserInputHandler = (request: CodexUserInputRequest) => Promise<CodexUserInputAnswer | undefined>;
export type CodexUserInputResult = "confirmed" | "failed" | "withdrawn" | "suspended";
export type CodexUserInputResultHandler = (request: CodexUserInputRequest, result: CodexUserInputResult) => Promise<void> | void;

export type CodexRunnerInput = {
  prompt: string;
  developerInstructions?: string;
  cwd: string;
  hostId?: string;
  /** Desktop-facing project id, used as a hint; app-server resolves its native id by cwd. */
  projectId?: string;
  projectName?: string;
  /** Explicitly unassigned. New turns must not infer a project from the cwd. */
  projectBinding?: "none";
  threadId?: string;
  threadTitle?: string;
  onThreadCreated?: (threadId: string) => Promise<void> | void;
  /** Persist the accepted turn identity before waiting for its output. */
  onTurnStarted?: (event: { threadId: string; turnId: string }) => Promise<void> | void;
  queueKey?: string;
  model?: string;
  effort?: string;
  onDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
  onRecovery?: (recovery: CodexTurnRecovery) => Promise<void> | void;
  onApproval?: CodexApprovalHandler;
  onApprovalResult?: CodexApprovalResultHandler;
  onDynamicToolCall?: CodexDynamicToolHandler;
  onUserInput?: CodexUserInputHandler;
  onUserInputResult?: CodexUserInputResultHandler;
  dynamicTools?: readonly Record<string, unknown>[];
  collaborationMode?: "default" | "plan";
  ephemeral?: boolean;
  outputSchema?: Record<string, unknown>;
  sandbox?: CodexExecSandbox;
};

/** Explicit, journaled empty-input continuation; never replay the original prompt. */
export type CodexCapacityResumeInput = Pick<CodexRunnerInput, "onApproval" | "onApprovalResult" | "onUserInput" | "onUserInputResult"> & {
  threadId: string;
  hostId?: string;
  failedTurnId: string;
  clientUserMessageId: string;
  assertCurrent: () => void;
  onTurnStarted: NonNullable<CodexRunnerInput["onTurnStarted"]>;
  onProgress?: CodexRunnerInput["onProgress"];
  onRecovery?: CodexRunnerInput["onRecovery"];
};

export function assertCapacityResume(snapshot: CodexThreadSnapshot, failedTurnId: string): void {
  const tail = snapshot.turns.at(-1);
  if (snapshot.state.persistence !== "active" || !["idle", "systemError"].includes(snapshot.state.runtimeStatus)
    || snapshot.state.pendingTurnWithoutId || snapshot.state.activeFlags.length || tail?.id !== failedTurnId || tail.status !== "failed"
    || snapshot.state.lastTurnFailure?.turnId !== failedTurnId || snapshot.state.lastTurnFailure.code !== "model-capacity") {
    throw new CodexInterventionError("容量恢复条件已变化，未启动后续轮次。");
  }
}

export function assertCodexProjectBinding(input: CodexRunnerInput): void {
  if (input.projectBinding === "none" && (input.projectId || input.projectName)) {
    throw new Error("An independent session cannot also specify a project");
  }
}

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
  /** Exact server correlation, never inferred by comparing message text. */
  clientUserMessageId?: string;
  turnId?: string;
  turnStatus?: CodexTurnStatus;
};

export type CodexThreadSnapshot = {
  state: CodexThreadState;
  /** Native oldest-to-newest order; a bounded window may later expand backwards. */
  turns: Array<{
    id: string;
    status: CodexTurnStatus;
    /** Native start time, when available; never inferred from the turn ID. */
    startedAt?: string;
    messages: CodexHistoryMessage[];
  }>;
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
export interface CodexBackendAdapter extends CodexBackendControls {
  readonly id: CodexBackendId;
  readonly capabilities: CodexBackendCapabilities;
  run(input: CodexRunnerInput): Promise<CodexRunResult>;
  steer(input: CodexSteerInput): Promise<CodexSteerResult>;
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
  steer(input: CodexSteerInput): Promise<CodexSteerResult>;
  submitThreadMessage?(input: CodexThreadMessageInput): Promise<CodexInputReceipt>;
  stop(threadId?: string): Promise<CodexStopResult>;
  close(): void;
}

/** Every backend implements this boundary; unavailable operations reject explicitly. */
export interface CodexBackendControls {
  getHistory(threadId: string): Promise<CodexHistoryMessage[]>;
  getHistoryPage(threadId: string, input?: CodexHistoryPageInput): Promise<CodexHistoryPage>;
  readThreadSnapshot(threadId: string): Promise<CodexThreadSnapshot>;
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
  listSessionCatalog(input?: CodexThreadListInput): Promise<CodexSessionCatalog>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<CodexThreadState>;
  deleteThread(threadId: string): Promise<void>;
}

export type CodexMetadataObservation = { includeTurns: false; timeoutMs: number };
export interface CodexAppServerBackend extends CodexBackendAdapter, Partial<CodexNativeQueue> {
  resumeAfterCapacity?(input: CodexCapacityResumeInput): Promise<CodexRunResult>;
  /** Read metadata without loading the complete turn history for message preflight. */
  inspectThread(threadId: string, observation?: CodexMetadataObservation): Promise<CodexThreadState>;
  readonly id: "app-server";
}

/** Stable facade consumed by channels, Web, intent routing, and account management. */
export interface CodexBridgeBackend extends Partial<CodexNativeQueue> {
  resumeAfterCapacity?(input: CodexCapacityResumeInput): Promise<CodexRunResult>;
  stageAttachments?: import("./inbound-files.js").StageInboundFiles;
  backendInfo(hostId?: string): { id: CodexBackendAdapter["id"]; capabilities: CodexBackendCapabilities };
  readThreadSnapshot(threadId: string, hostId?: string): Promise<CodexThreadSnapshot>;
  run(input: CodexRunnerInput): Promise<CodexRunResult>;
  steer(input: CodexSteerInput, hostId?: string): Promise<CodexSteerResult>;
  /** Thread-scoped ordinary input; never falls back to starting or queuing a task. */
  submitThreadMessage?(input: CodexThreadMessageInput, hostId?: string): Promise<CodexInputReceipt>;
  stop(threadId?: string, hostId?: string): Promise<CodexStopResult>;
  runEphemeral(input: EphemeralCodexRunnerInput): Promise<CodexRunResult>;
  warmUp(cwd: string, hostId?: string): Promise<void>;
  listProjects(hostId?: string, observation?: Pick<CodexMetadataObservation, "timeoutMs">): Promise<CodexProjectCatalog>;
  getHistory(threadId: string, hostId?: string): Promise<CodexHistoryMessage[]>;
  getHistoryPage(
    threadId: string,
    input?: CodexHistoryPageInput,
    hostId?: string
  ): Promise<CodexHistoryPage>;
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
  inspectThread(threadId: string, hostId?: string, observation?: CodexMetadataObservation): Promise<CodexThreadState>;
  listThreads(input?: CodexThreadListInput, hostId?: string): Promise<CodexThreadState[]>;
  listSessionCatalog(input?: CodexThreadListInput, hostId?: string): Promise<CodexSessionCatalog>;
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
  history: true,
  historyPaging: true,
  turnSteering: false,
  nativeQueue: false,
  liveFollow: false,
  runtimeInfo: false,
  models: false,
  accountRateLimits: false,
  goals: false,
  projectCatalog: true,
  projects: false,
  threadNaming: false,
  developerInstructions: false,
  threadInspection: true,
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
  historyPaging: true,
  turnSteering: true,
  nativeQueue: true,
  liveFollow: true,
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
