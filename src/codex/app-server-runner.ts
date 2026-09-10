import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { rolloutIdentity } from "./rollout-identity.js";
import { desktopSessionMembership } from "./desktop-session-membership.js";
import { readDesktopSessionCatalog, isDesktopCatalogThread } from "./desktop-session-catalog.js";

import { resolveCodexCommand } from "./exec-runner.js";
import { parseAccountRateLimits, type CodexAccountBalance } from "./account-balance.js";
import {
  appServerApprovalResult,
  isAppServerApprovalMethod,
  parseAppServerApproval,
  type CodexApprovalHandler
} from "./approval.js";
import type { CodexExecSandbox } from "./sandbox.js";
import type { AppServerTransport } from "./app-server-transport.js";
import {
  APP_SERVER_BACKEND_CAPABILITIES,
  CodexThreadStateError,
  assertCodexThreadRunnable,
  assertCodexProjectBinding,
  type CodexAppServerBackend,
  type CodexDynamicToolCall,
  type CodexDynamicToolHandler,
  type CodexHistoryPage,
  type CodexHistoryPageInput,
  type CodexHistoryMessage,
  type CodexModelOption,
  type CodexProject,
  type CodexProjectCatalog,
  type CodexSessionCatalog,
  type CodexRunResult,
  type CodexRunnerInput,
  type CodexRuntimeInfo,
  type CodexSteerInput,
  type CodexSteerResult,
  type CodexStopResult,
  type CodexThreadActiveFlag,
  type CodexThreadGoal,
  type CodexThreadGoalStatus,
  type CodexThreadListInput,
  type CodexThreadPersistence,
  type CodexThreadRuntimeStatus,
  type CodexThreadState,
  type CodexTurnStatus,
  type CodexUserInputAnswer,
  type CodexUserInputHandler,
  type CodexUserInputQuestion,
  type CodexUserInputRequest
} from "./backend.js";

export type {
  CodexDynamicToolCall,
  CodexDynamicToolHandler,
  CodexHistoryMessage,
  CodexModelOption,
  CodexRunnerInput,
  CodexRuntimeInfo,
  CodexThreadGoal,
  CodexThreadGoalStatus,
  CodexUserInputAnswer,
  CodexUserInputHandler,
  CodexUserInputQuestion,
  CodexUserInputRequest
} from "./backend.js";
export type { AppServerTransport } from "./app-server-transport.js";

export type AppServerRunnerOptions = {
  codexHome?: string;
  hostId?: string;
  codexBin?: string;
  requestTimeoutMs?: number;
  sandbox?: CodexExecSandbox;
  transport?: AppServerTransport;
};

type JsonRpcId = number | string;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnCompletion = {
  status: string;
  text: string;
  raw: string;
  error?: string;
};

type TurnWaiter = {
  resolve: (value: CodexRunResult) => void;
  reject: (error: Error) => void;
};

type TurnStream = {
  onDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
  chain: Promise<void>;
};

type QueuedTurnEvent = {
  type: "delta" | "progress";
  text: string;
};

type AppServerSandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly" }
  | { readonly type: "workspaceWrite" };

type WireMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export class AppServerCodexRunner implements CodexAppServerBackend {
  readonly id = "app-server" as const;
  readonly capabilities = APP_SERVER_BACKEND_CAPABILITIES;
  private child?: ChildProcessWithoutNullStreams;
  private lines?: readline.Interface;
  private connectPromise?: Promise<void>;
  private initialized = false;
  private closed = false;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly activeTurns = new Map<string, string>();
  private readonly approvalHandlersByThread = new Map<string, CodexApprovalHandler>();
  private readonly dynamicToolHandlersByThread = new Map<string, CodexDynamicToolHandler>();
  private readonly userInputHandlersByThread = new Map<string, CodexUserInputHandler>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly turnEvents = new Map<string, string[]>();
  private readonly turnTexts = new Map<string, string>();
  private readonly completedTurns = new Map<string, TurnCompletion>();
  private readonly turnStreams = new Map<string, TurnStream>();
  private readonly queuedTurnEvents = new Map<string, QueuedTurnEvent[]>();
  private readonly itemPhasesByTurn = new Map<string, Map<string, string>>();
  private readonly reasoningSummariesByTurn = new Map<string, Map<string, string>>();
  private readonly runtimeInfoByThread = new Map<string, CodexRuntimeInfo>();
  private readonly threadStates = new Map<string, CodexThreadState>();
  private readonly projectIdsByRoot = new Map<string, string>();
  private operationLeases = 0;
  private projectCatalogSupported?: boolean;
  private modelOptions?: CodexModelOption[];

  constructor(private readonly options: AppServerRunnerOptions = {}) {}

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    assertCodexProjectBinding(input);
    this.operationLeases += 1;
    try {
      return await this.runWithLease(input);
    } finally {
      this.operationLeases -= 1;
      await this.recyclePrivateTransportIfIdle();
    }
  }

  private async runWithLease(input: CodexRunnerInput): Promise<CodexRunResult> {
    await this.ensureConnected();

    if (input.threadId) {
      try {
        assertCodexThreadRunnable(await this.inspectThread(input.threadId));
        // inspectThread intentionally recycles a private stdio app-server so a
        // read-only probe cannot retain Desktop's writer lock. Reconnect for
        // the actual queued turn lifecycle.
        await this.ensureConnected();
        await this.waitForThreadIdle(input.threadId, input.onProgress);
      } catch (error) {
        throw normalizeThreadOperationError(error, input.threadId);
      }
    }

    const nativeProjectId = input.projectId || input.projectName
      ? await this.resolveProjectId(input.cwd, input.projectId, input.projectName)
      : undefined;
    let threadResponse: Record<string, unknown>;
    try {
      threadResponse = await this.request(
        input.threadId ? "thread/resume" : "thread/start",
        compactObject({
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(!input.threadId ? { ephemeral: input.ephemeral } : {}),
          cwd: input.cwd,
          model: input.model,
          developerInstructions: input.developerInstructions,
          approvalPolicy: "never",
          ...(!input.threadId && nativeProjectId ? { projectId: nativeProjectId } : {}),
          ...(!input.threadId && input.projectBinding === "none" ? { projectId: null } : {}),
          ...(!input.threadId && input.dynamicTools ? { dynamicTools: input.dynamicTools } : {})
        })
      ) as Record<string, unknown>;
    } catch (error) {
      if (input.threadId) throw normalizeThreadOperationError(error, input.threadId);
      throw error;
    }
    const thread = threadResponse.thread as Record<string, unknown> | undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : input.threadId;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id");
    }
    try {
    const currentProjectId = typeof thread?.projectId === "string" ? thread.projectId : undefined;
    if (!input.threadId && input.projectBinding === "none" && currentProjectId) {
      // Some servers may infer a project. The protocol uses an empty string (not
      // null) to clear metadata. Never reassign an existing bound thread here.
      await this.request("thread/metadata/update", { threadId, projectId: "" });
      if (thread) thread.projectId = null;
    }
    if (input.threadId && nativeProjectId && currentProjectId !== nativeProjectId) {
      try {
        await this.request("thread/metadata/update", { threadId, projectId: nativeProjectId });
      } catch (error) {
        if (!isMissingProjectError(error)) throw error;
        this.projectIdsByRoot.delete(path.normalize(input.cwd));
        const refreshedProjectId = await this.resolveProjectId(input.cwd, undefined, input.projectName);
        if (!refreshedProjectId || refreshedProjectId === currentProjectId) throw error;
        await this.request("thread/metadata/update", { threadId, projectId: refreshedProjectId });
      }
    }
    const currentName = typeof thread?.name === "string" ? thread.name : undefined;
    const threadTitle = cleanThreadTitle(input.threadTitle);
    if (threadTitle && (!input.threadId || shouldRepairBridgeThreadName(currentName))) {
      await this.request("thread/name/set", { threadId, name: threadTitle });
    }
    if (!input.threadId) {
      await input.onThreadCreated?.(threadId);
    }
    if (thread) {
      this.threadStates.set(threadId, parseThreadState(
        thread,
        input.ephemeral ? "ephemeral" : persistenceFromThread(thread)
      ));
    }
    this.runtimeInfoByThread.set(threadId, runtimeInfoFromThreadResponse(threadResponse));

    const runtimeInfo = this.runtimeInfoByThread.get(threadId);
    const collaborationModel = input.collaborationMode
      ? input.model ?? runtimeInfo?.model ?? (await this.getRuntimeInfo(input.cwd, threadId)).model
      : undefined;
    if (input.collaborationMode && !collaborationModel) {
      throw new Error("Codex collaboration mode requires a resolved model");
    }

    const turnParams = compactObject({
      threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      approvalPolicy: input.onApproval ? "on-request" : "never",
      sandboxPolicy: appServerSandboxPolicy(input.sandbox ?? this.options.sandbox),
      model: input.model,
      effort: input.effort,
      outputSchema: input.outputSchema,
      ...(input.collaborationMode ? {
        collaborationMode: {
          mode: input.collaborationMode,
          settings: {
            model: collaborationModel,
            reasoning_effort: input.effort ?? runtimeInfo?.effort ?? null,
            developer_instructions: null
          }
        }
      } : {})
    });
    let turnResponse: Record<string, unknown>;
    if (input.onApproval) this.approvalHandlersByThread.set(threadId, input.onApproval);
    if (input.onDynamicToolCall) this.dynamicToolHandlersByThread.set(threadId, input.onDynamicToolCall);
    if (input.onUserInput) this.userInputHandlersByThread.set(threadId, input.onUserInput);
    try {
      turnResponse = await this.request("turn/start", turnParams) as Record<string, unknown>;
    } catch (error) {
      if (!input.threadId || !isThreadBusyError(error)) {
        this.approvalHandlersByThread.delete(threadId);
        this.dynamicToolHandlersByThread.delete(threadId);
        this.userInputHandlersByThread.delete(threadId);
        throw error;
      }
      await input.onProgress?.("当前会话刚刚开始了另一条任务，已排队等待完成。");
      await this.waitForThreadIdle(input.threadId);
      try {
        turnResponse = await this.request("turn/start", turnParams) as Record<string, unknown>;
      } catch (retryError) {
        this.approvalHandlersByThread.delete(threadId);
        this.dynamicToolHandlersByThread.delete(threadId);
        this.userInputHandlersByThread.delete(threadId);
        throw retryError;
      }
    }
    const turn = turnResponse.turn as Record<string, unknown> | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : undefined;
    if (!turnId) {
      this.approvalHandlersByThread.delete(threadId);
      this.dynamicToolHandlersByThread.delete(threadId);
      this.userInputHandlersByThread.delete(threadId);
      throw new Error("Codex app-server did not return a turn id");
    }

    this.activeTurns.set(threadId, turnId);
    const previousState = this.threadStates.get(threadId);
    this.threadStates.set(threadId, {
      threadId,
      persistence: previousState?.persistence ?? (input.ephemeral ? "ephemeral" : "active"),
      runtimeStatus: "active",
      activeFlags: [],
      latestTurnStatus: "inProgress",
      activeTurnId: turnId,
      ...(previousState?.cwd ? { cwd: previousState.cwd } : { cwd: input.cwd }),
      ...(previousState?.projectId ? { projectId: previousState.projectId } : {}),
      ...(previousState?.title ? { title: previousState.title } : {})
    });
    if (input.onDelta || input.onProgress) {
      const key = turnKey(threadId, turnId);
      this.turnStreams.set(key, {
        onDelta: input.onDelta,
        onProgress: input.onProgress,
        chain: Promise.resolve()
      });
      for (const event of this.queuedTurnEvents.get(key) ?? []) {
        this.enqueueTurnEvent(key, event);
      }
      this.queuedTurnEvents.delete(key);
    }
    await input.onTurnStarted?.({ threadId, turnId });
    return await this.waitForTurn(threadId, turnId);
    } finally {
      await this.unsubscribeThread(threadId);
      await this.recyclePrivateTransportIfIdle();
    }
  }

  private async unsubscribeThread(threadId: string): Promise<void> {
    try {
      await this.request(
        "thread/unsubscribe",
        { threadId },
        Math.min(this.options.requestTimeoutMs ?? 600_000, 10_000)
      );
    } catch (error) {
      // Releasing ownership is best-effort and must never replace the actual
      // turn result. A closed transport already releases all of its threads.
      console.warn(
        `[codex-im-gateway] Unable to release Codex session ${threadId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * A private stdio app-server keeps an unsubscribed thread loaded for its
   * inactivity grace period. While loaded, its OS writer lock prevents Codex
   * Desktop from opening the same task. Once the last Bridge turn is done,
   * close the private process so Desktop can take ownership immediately.
   *
   * Managed daemon and remote transports have a shared lifecycle and must not
   * be stopped by an individual Bridge client.
   */
  private async recyclePrivateTransportIfIdle(): Promise<void> {
    if (this.options.transport || this.operationLeases || this.activeTurns.size || this.pending.size) return;
    const child = this.child;
    if (!child || child.exitCode !== null) return;

    const exited = new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
    });
    this.child = undefined;
    this.initialized = false;
    this.lines?.close();
    this.lines = undefined;
    try {
      child.stdin.end();
    } catch {
      child.kill();
    }
    const graceful = await Promise.race([
      exited,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))
    ]);
    if (!graceful && child.exitCode === null) child.kill();
  }

  async inspectThread(threadId: string, observation?: { includeTurns: false; timeoutMs: number }): Promise<CodexThreadState> {
    const membership = this.sessionMembership(true);
    await this.ensureConnected();
    try {
      let response: Record<string, unknown>;
      try {
        response = await this.request("thread/read", { threadId, includeTurns: observation?.includeTurns ?? true }, observation?.timeoutMs) as Record<string, unknown>;
      } catch (error) {
        if (!/ephemeral threads do not support includeTurns/i.test(String(error))) throw error;
        response = await this.request("thread/read", { threadId, includeTurns: false }) as Record<string, unknown>;
      }
      const thread = response.thread as Record<string, unknown> | undefined;
      if (!thread) throw new Error(`Codex app-server returned no thread for ${threadId}`);
      const state = membership(parseThreadState(thread, persistenceFromThread(thread)));
      const activeTurnId = this.activeTurns.get(threadId);
      if (activeTurnId) {
        state.activeTurnId = activeTurnId;
        state.latestTurnStatus = "inProgress";
        state.runtimeStatus = "active";
      }
      this.threadStates.set(threadId, state);
      return state;
    } catch (error) {
      const archived = await this.findListedThread(threadId, true);
      if (archived) {
        const state = membership(parseThreadState(archived, "archived"));
        this.threadStates.set(threadId, state);
        return state;
      }
      const active = await this.findListedThread(threadId, false);
      if (active) {
        const state = membership(parseThreadState(active, persistenceFromThread(active)));
        this.threadStates.set(threadId, state);
        return state;
      }
      if (isMissingOrArchivedThreadError(error)) {
        const state: CodexThreadState = {
          threadId,
          persistence: "missing",
          runtimeStatus: "unknown",
          activeFlags: []
        };
        this.threadStates.set(threadId, state);
        return state;
      }
      throw error;
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async listSessionCatalog(input: CodexThreadListInput = {}): Promise<CodexSessionCatalog> {
    // Do not load threads or start a second app-server just to discover what
    // Desktop already indexes, including hosts with no saved project.
    const catalog = readDesktopSessionCatalog(this.options.codexHome, this.options.hostId, input);
    if (catalog) return catalog;
    await this.ensureConnected();
    try {
      const threads = await this.listThreadsByPersistence(input, false, input.limit ?? Infinity, true);
      return { backend: this.id, source: "app-server-storage", hostIds: [this.options.hostId ?? "local"], complete: true,
        threads: threads.map(state => ({ ...state,
          // A private reader's notLoaded/idle says nothing about Desktop.
          runtimeStatus: this.options.transport?.mode === "remote-daemon" || state.runtimeStatus === "active" || state.runtimeStatus === "systemError"
            ? state.runtimeStatus : "unknown"
        })),
        warnings: ["Codex App 目录不可用；当前显示 app-server 存储中符合 App 筛选规则的会话，不保证与 App 侧栏完全一致。ChatGPT 聊天不支持绑定。"] };
    } finally { await this.recyclePrivateTransportIfIdle(); }
  }

  async listThreads(input: CodexThreadListInput = {}): Promise<CodexThreadState[]> {
    await this.ensureConnected();
    const persistence = input.persistence ?? "all";
    const limit = input.limit === undefined ? Infinity : Math.max(1, input.limit);
    const results: CodexThreadState[] = [];
    if (persistence === "active" || persistence === "all") {
      results.push(...await this.listThreadsByPersistence(input, false, limit));
    }
    if (persistence === "archived" || persistence === "all") {
      results.push(...await this.listThreadsByPersistence(input, true, limit));
    }
    const deduped = new Map<string, CodexThreadState>();
    for (const state of results) {
      deduped.set(state.threadId, state);
      this.threadStates.set(state.threadId, state);
    }
    return [...deduped.values()]
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .slice(0, limit);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.ensureConnected();
    try {
      await this.request("thread/archive", { threadId });
      this.threadStates.set(threadId, {
        threadId,
        persistence: "archived",
        runtimeStatus: "notLoaded",
        activeFlags: []
      });
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async unarchiveThread(threadId: string): Promise<CodexThreadState> {
    await this.ensureConnected();
    try {
      const response = await this.request("thread/unarchive", { threadId }) as Record<string, unknown>;
      const thread = response.thread as Record<string, unknown> | undefined;
      const state = thread
        ? this.sessionMembership()(parseThreadState(thread, "active"))
        : await this.inspectThread(threadId);
      this.threadStates.set(threadId, state);
      return state;
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.ensureConnected();
    try {
      await this.request("thread/delete", { threadId });
      this.threadStates.set(threadId, {
        threadId,
        persistence: "missing",
        runtimeStatus: "unknown",
        activeFlags: []
      });
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  private async listThreadsByPersistence(
    input: CodexThreadListInput,
    archived: boolean,
    limit: number,
    desktopCatalogOnly = false
  ): Promise<CodexThreadState[]> {
    const states: CodexThreadState[] = [];
    const membership = this.sessionMembership(desktopCatalogOnly);
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const response = await this.request("thread/list", compactObject({
        cursor,
        limit: Math.min(100, limit - states.length),
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        ...(desktopCatalogOnly ? { modelProviders: [], useStateDbOnly: true } : {}),
        archived,
        // Explicit project membership can span worktrees with different cwd.
        cwd: input.projectId ? undefined : input.cwd
      }), Math.min(this.options.requestTimeoutMs ?? 15_000, 15_000)) as Record<string, unknown>;
      for (const value of Array.isArray(response.data) ? response.data : []) {
        if (!isRecord(value)) continue;
        if (desktopCatalogOnly && !isDesktopCatalogThread(value)) continue;
        const state = membership(parseThreadState(value, archived ? "archived" : persistenceFromThread(value)));
        if (state.internal || (input.unassigned && state.projectId)) continue;
        if (input.projectId && state.projectId !== input.projectId && value.projectId !== input.projectId) continue;
        states.push(state);
        if (states.length >= limit) break;
      }
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (states.length >= limit || !nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return states;
  }

  private sessionMembership(legacyWorkspaceFallback = false): (state: CodexThreadState) => CodexThreadState {
    // A remote transport without a host identity must not consume local membership.
    if (this.options.transport?.mode === "remote-daemon" && !this.options.hostId) return (state) => state;
    return desktopSessionMembership(this.options.codexHome, this.options.hostId, legacyWorkspaceFallback);
  }

  private async findListedThread(threadId: string, archived: boolean): Promise<Record<string, unknown> | undefined> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    try {
      do {
        const response = await this.request("thread/list", compactObject({
          cursor,
          limit: 100,
          sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
          archived
        })) as Record<string, unknown>;
        for (const value of Array.isArray(response.data) ? response.data : []) {
          if (isRecord(value) && value.id === threadId) return value;
        }
        const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
          ? response.nextCursor
          : undefined;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async resolveProjectId(cwd: string, projectId?: string, projectName?: string): Promise<string | undefined> {
    const root = path.normalize(cwd);
    const cached = this.projectIdsByRoot.get(root);
    if (cached) return cached;
    if (this.projectCatalogSupported === false) return undefined;

    let projects: AppServerProject[];
    try {
      projects = await this.requestProjects();
      this.projectCatalogSupported = true;
    } catch (error) {
      if (!isUnsupportedProjectCatalogError(error)) throw error;
      // Older Desktop daemons do not expose project/list. thread/start still
      // accepts cwd and Desktop associates the new task with its remote project.
      this.projectCatalogSupported = false;
      return undefined;
    }
    const match = projects.find((project) => (
      project.id === projectId || project.roots.some((candidate) => path.normalize(candidate) === root)
    ));
    if (match) {
      this.projectIdsByRoot.set(root, match.id);
      return match.id;
    }
    if (!projectName) return undefined;

    const idempotencyKey = `codex-im-gateway:${crypto.createHash("sha256").update(root).digest("hex")}`;
    try {
      const response = await this.request("project/create", {
        name: projectName,
        roots: [{ path: root }],
        metadata: { source: "codex-im-gateway" },
        idempotencyKey
      }) as Record<string, unknown>;
      const project = parseAppServerProject(response.project);
      if (!project) throw new Error("Codex app-server did not return the created project");
      this.projectIdsByRoot.set(root, project.id);
      return project.id;
    } catch (error) {
      // A concurrent client may have registered the same root after our list.
      const retry = (await this.requestProjects()).find((project) => (
        project.roots.some((candidate) => path.normalize(candidate) === root)
      ));
      if (!retry) throw error;
      this.projectIdsByRoot.set(root, retry.id);
      return retry.id;
    }
  }

  async warmUp(cwd: string): Promise<void> {
    await this.getRuntimeInfo(cwd);
  }

  async listProjects(): Promise<CodexProjectCatalog> {
    await this.ensureConnected();
    try {
      if (this.projectCatalogSupported === false) {
        return { backend: "app-server", projects: [] };
      }
      let projects: AppServerProject[];
      try {
        projects = await this.requestProjects();
        this.projectCatalogSupported = true;
      } catch (error) {
        if (!isUnsupportedProjectCatalogError(error)) throw error;
        this.projectCatalogSupported = false;
        projects = [];
      }
      return {
        backend: "app-server",
        projects
      };
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  private async requestProjects(): Promise<AppServerProject[]> {
    const projects: AppServerProject[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.request("project/list", compactObject({ cursor, limit: 100 }), Math.min(this.options.requestTimeoutMs ?? 15_000, 15_000)) as Record<string, unknown>;
      for (const value of Array.isArray(response.data) ? response.data : []) {
        const project = parseAppServerProject(value);
        if (project) projects.push(project);
      }
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return projects;
  }

  async getHistory(threadId: string): Promise<CodexHistoryMessage[]> {
    await this.ensureConnected();
    try {
      const response = await this.request("thread/read", { threadId, includeTurns: true }) as Record<string, unknown>;
      const thread = response.thread as Record<string, unknown> | undefined;
      if (!thread) throw new CodexThreadStateError("missing", threadId, `Codex session ${threadId} 不存在。`);
      const state = parseThreadState(thread, persistenceFromThread(thread));
      this.threadStates.set(threadId, state);
      assertCodexThreadRunnable(state);
      return parseThreadHistory(thread);
    } catch (error) {
      throw normalizeThreadOperationError(error, threadId);
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async readThreadSnapshot(threadId: string): Promise<import("./backend.js").CodexThreadSnapshot> {
    // Keep both observation reads on one connection and bound their payload.
    // A five-second follow tick must not reload an entire long-lived history.
    this.operationLeases++;
    try {
      const timeoutMs = Math.min(this.options.requestTimeoutMs ?? 15_000, 15_000);
      const state = await this.inspectThread(threadId, { includeTurns: false, timeoutMs });
      if (state.persistence === "missing" || state.persistence === "archived") return { state, turns: [] };
      await this.ensureConnected();
      const response = await this.request("thread/turns/list", {
        threadId, limit: 20, sortDirection: "desc", itemsView: "full"
      }, timeoutMs) as { data?: Array<{ id: string; status: import("./backend.js").CodexTurnStatus }> };
      return { state, turns: (response.data ?? []).slice().reverse().map((turn) => ({
        id: turn.id, status: turn.status, messages: parseThreadHistory({ turns: [turn] })
      })) };
    } finally {
      this.operationLeases--;
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async getHistoryPage(
    threadId: string,
    input: CodexHistoryPageInput = {}
  ): Promise<CodexHistoryPage> {
    await this.ensureConnected();
    try {
      const response = await this.request("thread/turns/list", compactObject({
        threadId,
        cursor: input.cursor,
        limit: Math.max(1, Math.min(input.limit ?? 20, 100)),
        sortDirection: input.sortDirection ?? "desc",
        itemsView: "full"
      })) as Record<string, unknown>;
      const turns = Array.isArray(response.data) ? response.data.slice() : [];
      if ((input.sortDirection ?? "desc") === "desc") turns.reverse();
      return {
        messages: parseThreadHistory({ turns }),
        ...(typeof response.nextCursor === "string" && response.nextCursor
          ? { nextCursor: response.nextCursor }
          : {}),
        ...(typeof response.backwardsCursor === "string" && response.backwardsCursor
          ? { backwardsCursor: response.backwardsCursor }
          : {})
      };
    } catch (error) {
      throw normalizeThreadOperationError(error, threadId);
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async steer(input: CodexSteerInput): Promise<CodexSteerResult> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("介入内容不能为空。");
    await this.ensureConnected();

    let turnId = input.expectedTurnId ?? this.activeTurns.get(input.threadId);
    if (!turnId) {
      const state = await this.inspectThread(input.threadId);
      assertCodexThreadRunnable(state);
      turnId = state.activeTurnId;
      await this.ensureConnected();
    }
    if (!turnId) {
      throw new Error(`Codex session ${input.threadId} 当前没有正在执行的任务，无法介入。`);
    }

    try {
      const response = await this.request("turn/steer", {
        threadId: input.threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        expectedTurnId: turnId
      }) as Record<string, unknown>;
      const acceptedTurnId = typeof response.turnId === "string" ? response.turnId : turnId;
      return { status: "accepted", threadId: input.threadId, turnId: acceptedTurnId };
    } catch (error) {
      throw normalizeSteerError(error, input.threadId, turnId);
    }
  }

  async getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo> {
    const active = threadId ? this.runtimeInfoByThread.get(threadId) : undefined;
    if (active?.model || active?.effort) {
      return active;
    }
    await this.ensureConnected();
    const response = await this.request("config/read", { cwd, includeLayers: false }) as Record<string, unknown>;
    const config = response.config as Record<string, unknown> | undefined;
    return compactRuntimeInfo({
      model: config?.model,
      effort: config?.model_reasoning_effort,
      provider: config?.model_provider ?? config?.modelProvider
    });
  }

  async listModels(): Promise<CodexModelOption[]> {
    if (this.modelOptions) {
      return structuredClone(this.modelOptions);
    }
    await this.ensureConnected();
    const models: CodexModelOption[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.request("model/list", compactObject({
        cursor,
        includeHidden: false,
        limit: 100
      })) as Record<string, unknown>;
      const data = Array.isArray(response.data) ? response.data : [];
      for (const item of data) {
        const option = parseModelOption(item);
        if (option && !models.some((candidate) => candidate.model === option.model)) {
          models.push(option);
        }
      }
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    this.modelOptions = models;
    return structuredClone(models);
  }

  async getAccountRateLimits(): Promise<CodexAccountBalance> {
    await this.ensureConnected();
    return parseAccountRateLimits(await this.request("account/rateLimits/read", {}));
  }

  async getGoal(threadId: string): Promise<CodexThreadGoal | undefined> {
    await this.ensureConnected();
    const response = await this.request("thread/goal/get", { threadId }) as { goal?: unknown };
    return parseThreadGoal(response.goal);
  }

  async setGoal(
    threadId: string,
    input: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number }
  ): Promise<CodexThreadGoal | undefined> {
    await this.ensureConnected();
    const response = await this.request("thread/goal/set", {
      threadId,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {})
    }) as { goal?: unknown };
    return parseThreadGoal(response.goal);
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.ensureConnected();
    await this.request("thread/goal/clear", { threadId });
  }

  async stop(threadId?: string): Promise<CodexStopResult> {
    if (threadId) await this.ensureConnected();
    if (!this.initialized || !this.child || this.child.exitCode !== null) {
      return "not-active";
    }

    let target = threadId && this.activeTurns.has(threadId)
      ? { threadId, turnId: this.activeTurns.get(threadId) as string }
      : undefined;
    if (threadId && !target) {
      const state = await this.inspectThread(threadId);
      assertCodexThreadRunnable(state);
      if (state.latestTurnStatus === "inProgress" && state.activeTurnId) {
        target = { threadId, turnId: state.activeTurnId };
      }
      await this.ensureConnected();
    }
    if (!threadId) {
      target = Array.from(this.activeTurns.entries(), ([activeThreadId, turnId]) => ({
        threadId: activeThreadId,
        turnId
      })).at(-1);
    }
    if (!target) {
      return "not-active";
    }

    await this.request("turn/interrupt", target);
    return "interrupted";
  }

  close(): void {
    this.closed = true;
    this.failTransport(new Error("Codex app-server runner closed"), true);
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) {
      throw new Error("Codex app-server runner is closed");
    }
    if (this.initialized && this.child?.exitCode === null && !this.child.stdin.destroyed) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.startAppServer().finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
  }

  private async startAppServer(): Promise<void> {
    await this.options.transport?.prepare?.();
    const localCommand = resolveCodexCommand(this.options.codexBin ?? "codex");
    const command = this.options.transport?.command ?? localCommand.command;
    const args = this.options.transport?.args
      ?? [...localCommand.argsPrefix, "app-server", "--stdio"];
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    this.child = child;
    this.stderr = "";
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleMessage(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-20_000);
    });
    child.once("error", (error) => this.handleChildFailure(child, error));
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.handleChildFailure(
        child,
        new Error(
          `Codex app-server${this.options.transport?.label ? ` (${this.options.transport.label})` : ""} ` +
          `exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${suffix}`
        )
      );
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "codex-im-gateway",
          title: "Codex IM Gateway",
          version: "0.4.0"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      }, Math.min(Math.max(this.options.requestTimeoutMs ?? 600_000, 5_000), 60_000));
      this.notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      this.failTransport(error instanceof Error ? error : new Error(String(error)), true);
      throw error;
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? 600_000
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`app-server request ${method} timed out after ${timeoutMs}ms`);
        this.pending.delete(id);
        reject(error);
        this.failTransport(error, true);
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        clearTimeout(timer);
        this.pending.delete(id);
        reject(normalizedError);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: WireMessage): void {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) {
      throw new Error("Codex app-server stdio transport is not connected");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleMessage(raw: string): void {
    let message: WireMessage;
    try {
      message = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.handleNotification(message.method, message.params ?? {}, raw);
      return;
    }
    if (message.id === undefined) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const code = message.error.code === undefined ? "" : ` (${message.error.code})`;
      pending.reject(new Error(`app-server ${pending.method} failed${code}: ${message.error.message ?? "unknown error"}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>, raw: string): void {
    if (method === "thread/status/changed") {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (threadId) {
        const previous = this.threadStates.get(threadId);
        this.threadStates.set(threadId, {
          threadId,
          persistence: previous?.persistence ?? "active",
          ...parseRuntimeStatus(params.status),
          ...(previous?.latestTurnStatus ? { latestTurnStatus: previous.latestTurnStatus } : {}),
          ...(previous?.activeTurnId ? { activeTurnId: previous.activeTurnId } : {}),
          ...(previous?.cwd ? { cwd: previous.cwd } : {}),
          ...(previous?.projectId ? { projectId: previous.projectId } : {}),
          ...(previous?.title ? { title: previous.title } : {}),
          ...(previous?.preview ? { preview: previous.preview } : {}),
          ...(previous?.updatedAt ? { updatedAt: previous.updatedAt } : {})
        });
      }
      return;
    }

    if (["thread/archived", "thread/unarchived", "thread/deleted", "thread/closed"].includes(method)) {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (threadId) {
        const previous = this.threadStates.get(threadId);
        const persistence: CodexThreadPersistence = method === "thread/archived"
          ? "archived"
          : method === "thread/deleted"
            ? "missing"
            : previous?.persistence === "ephemeral"
              ? "ephemeral"
              : "active";
        this.threadStates.set(threadId, {
          threadId,
          persistence,
          runtimeStatus: "notLoaded",
          activeFlags: [],
          ...(previous?.cwd ? { cwd: previous.cwd } : {}),
          ...(previous?.projectId ? { projectId: previous.projectId } : {}),
          ...(previous?.title ? { title: previous.title } : {}),
          ...(previous?.preview ? { preview: previous.preview } : {}),
          ...(previous?.updatedAt ? { updatedAt: previous.updatedAt } : {})
        });
      }
      return;
    }

    if (method === "item/started") {
      const key = turnKeyFromParams(params);
      const item = params.item as Record<string, unknown> | undefined;
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (key && itemId && item?.type === "agentMessage" && typeof item.phase === "string") {
        const phases = this.itemPhasesByTurn.get(key) ?? new Map<string, string>();
        phases.set(itemId, item.phase);
        this.itemPhasesByTurn.set(key, phases);
      }
      const progress = describeItemProgress(item, false);
      if (key && progress) this.emitProgress(key, progress);
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      const key = turnKeyFromParams(params);
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!key || !itemId || !delta) return;
      const summaries = this.reasoningSummariesByTurn.get(key) ?? new Map<string, string>();
      const summary = `${summaries.get(itemId) ?? ""}${delta}`.trim();
      summaries.set(itemId, summary);
      this.reasoningSummariesByTurn.set(key, summaries);
      if (summary) this.emitProgress(key, `🤔 ${boundedText(summary, 600)}`);
      return;
    }

    if (method === "item/agentMessage/delta") {
      const key = turnKeyFromParams(params);
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!key || !itemId || !delta || this.itemPhasesByTurn.get(key)?.get(itemId) === "commentary") {
        return;
      }
      if (this.turnStreams.has(key)) {
        this.enqueueTurnEvent(key, { type: "delta", text: delta });
      } else {
        this.queueTurnEvent(key, { type: "delta", text: delta });
      }
      return;
    }

    if (method === "item/completed") {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      if (!threadId || !turnId) {
        return;
      }
      const key = turnKey(threadId, turnId);
      this.appendTurnEvent(key, raw);
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "commentary") {
          const progress = item.text.trim();
          if (progress) {
            if (this.turnStreams.has(key)) {
              this.enqueueTurnEvent(key, { type: "progress", text: progress });
            } else {
              this.queueTurnEvent(key, { type: "progress", text: progress });
            }
          }
        } else {
          this.turnTexts.set(key, item.text);
        }
      } else {
        const progress = describeItemProgress(item, true);
        if (progress) this.emitProgress(key, progress);
      }
      return;
    }

    if (method !== "turn/completed") {
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turn = params.turn as Record<string, unknown> | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : undefined;
    if (!threadId || !turnId) {
      return;
    }
    const key = turnKey(threadId, turnId);
    this.appendTurnEvent(key, raw);
    const status = typeof turn?.status === "string" ? turn.status : "completed";
    const errorValue = turn?.error as Record<string, unknown> | undefined;
    const completion: TurnCompletion = {
      status,
      text: this.turnTexts.get(key) ?? extractAgentMessageFromTurn(turn),
      raw: (this.turnEvents.get(key) ?? []).join("\n"),
      error: typeof errorValue?.message === "string" ? errorValue.message : undefined
    };
    this.activeTurns.delete(threadId);
    const previousState = this.threadStates.get(threadId);
    this.threadStates.set(threadId, {
      threadId,
      persistence: previousState?.persistence ?? "active",
      runtimeStatus: "idle",
      activeFlags: [],
      ...(normalizeTurnStatus(status) ? { latestTurnStatus: normalizeTurnStatus(status) } : {}),
      ...(previousState?.cwd ? { cwd: previousState.cwd } : {}),
      ...(previousState?.projectId ? { projectId: previousState.projectId } : {}),
      ...(previousState?.title ? { title: previousState.title } : {}),
      ...(previousState?.preview ? { preview: previousState.preview } : {})
    });
    this.approvalHandlersByThread.delete(threadId);
    this.dynamicToolHandlersByThread.delete(threadId);
    this.userInputHandlersByThread.delete(threadId);
    const waiter = this.turnWaiters.get(key);
    if (!waiter) {
      this.completedTurns.set(key, completion);
      return;
    }
    this.turnWaiters.delete(key);
    void this.finishTurn(threadId, key, completion, waiter.resolve, waiter.reject);
  }

  private waitForTurn(threadId: string, turnId: string): Promise<CodexRunResult> {
    const key = turnKey(threadId, turnId);
    const completed = this.completedTurns.get(key);
    if (completed) {
      this.completedTurns.delete(key);
      return new Promise((resolve, reject) => {
        void this.finishTurn(threadId, key, completed, resolve, reject);
      });
    }

    return new Promise((resolve, reject) => {
      // A turn is an agent job, not a request/response RPC. Once app-server
      // accepts it, let it run until Codex completes it, the user interrupts
      // it, or the underlying transport actually disconnects.
      this.turnWaiters.set(key, { resolve, reject });
    });
  }

  private async waitForThreadIdle(
    threadId: string,
    onProgress?: (message: string) => Promise<void> | void
  ): Promise<void> {
    let notified = false;
    while (true) {
      const response = await this.request("thread/read", { threadId, includeTurns: true }) as Record<string, unknown>;
      const thread = response.thread as Record<string, unknown> | undefined;
      if (!thread) throw new CodexThreadStateError("missing", threadId, `Codex session ${threadId} 不存在。`);
      const state = parseThreadState(thread, persistenceFromThread(thread));
      this.threadStates.set(threadId, state);
      assertCodexThreadRunnable(state);
      const busy = state.runtimeStatus === "active" || state.latestTurnStatus === "inProgress";
      if (!busy) return;
      if (!notified) {
        notified = true;
        const detail = state.activeFlags.includes("waitingOnApproval")
          ? "当前会话正在等待审批，已排队等待处理。"
          : state.activeFlags.includes("waitingOnUserInput")
            ? "当前会话正在等待用户输入，已排队等待处理。"
            : "当前会话的上一条任务仍在执行，已排队等待完成。";
        await onProgress?.(detail);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private async finishTurn(
    threadId: string,
    key: string,
    completion: TurnCompletion,
    resolve: (value: CodexRunResult) => void,
    reject: (error: Error) => void
  ): Promise<void> {
    const stream = this.turnStreams.get(key);
    this.turnStreams.delete(key);
    await stream?.chain;
    this.turnEvents.delete(key);
    this.turnTexts.delete(key);
    this.queuedTurnEvents.delete(key);
    this.itemPhasesByTurn.delete(key);
    this.reasoningSummariesByTurn.delete(key);
    if (completion.status === "completed") {
      resolve({ text: completion.text, threadId, turnId: key.slice(threadId.length + 1), raw: completion.raw });
      return;
    }
    if (completion.status === "interrupted") {
      reject(new Error("Codex app-server turn was interrupted"));
      return;
    }
    reject(new Error(completion.error ?? `Codex app-server turn ended with status ${completion.status}`));
  }

  private appendTurnEvent(key: string, raw: string): void {
    const events = this.turnEvents.get(key) ?? [];
    events.push(raw);
    this.turnEvents.set(key, events);
  }

  private queueTurnEvent(key: string, event: QueuedTurnEvent): void {
    const queued = this.queuedTurnEvents.get(key) ?? [];
    queued.push(event);
    this.queuedTurnEvents.set(key, queued);
  }

  private emitProgress(key: string, text: string): void {
    if (this.turnStreams.has(key)) {
      this.enqueueTurnEvent(key, { type: "progress", text });
    } else {
      this.queueTurnEvent(key, { type: "progress", text });
    }
  }

  private enqueueTurnEvent(key: string, event: QueuedTurnEvent): void {
    const stream = this.turnStreams.get(key);
    if (!stream) return;
    const callback = event.type === "progress" ? stream.onProgress : stream.onDelta;
    if (!callback) return;
    stream.chain = stream.chain
      .then(() => callback(event.text))
      .then(() => undefined)
      .catch((error) => {
        console.warn(`Codex ${event.type} callback failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private handleServerRequest(message: WireMessage): void {
    const id = message.id as JsonRpcId;
    if (isAppServerApprovalMethod(message.method)) {
      const method = message.method;
      const request = parseAppServerApproval(method, message.params ?? {});
      const handler = request ? this.approvalHandlersByThread.get(request.threadId) : undefined;
      if (!request || !handler) {
        const fallback = request ?? {
          kind: "command" as const,
          threadId: "",
          turnId: "",
          itemId: ""
        };
        this.send({ id, result: appServerApprovalResult(method, fallback, "decline") });
        return;
      }
      Promise.resolve(handler(request))
        .then((decision) => {
          this.send({ id, result: appServerApprovalResult(method, request, decision) });
        })
        .catch((error) => {
          try {
            this.send({ id, result: appServerApprovalResult(method, request, "decline") });
          } catch (sendError) {
            const approvalError = error instanceof Error ? error.message : String(error);
            const transportError = sendError instanceof Error ? sendError.message : String(sendError);
            console.warn(`Codex approval failed (${approvalError}) and decline could not be sent: ${transportError}`);
          }
        });
      return;
    }
    switch (message.method) {
      case "execCommandApproval":
      case "applyPatchApproval":
        this.send({ id, result: { decision: "denied" } });
        return;
      case "item/tool/requestUserInput":
        this.handleUserInputRequest(id, message.params ?? {});
        return;
      case "mcpServer/elicitation/request":
        this.send({ id, result: { action: "cancel", content: null, _meta: null } });
        return;
      case "item/tool/call":
        this.handleDynamicToolRequest(id, message.params ?? {});
        return;
      case "currentTime/read":
        this.send({ id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } });
        return;
      default:
        this.send({
          id,
          error: { code: -32601, message: `Unsupported app-server request: ${message.method ?? "unknown"}` }
        });
    }
  }

  private handleDynamicToolRequest(id: JsonRpcId, params: Record<string, unknown>): void {
    const call = parseDynamicToolCall(params);
    const handler = call ? this.dynamicToolHandlersByThread.get(call.threadId) : undefined;
    if (!call || !handler) {
      this.send({
        id,
        result: {
          contentItems: [{ type: "inputText", text: "当前会话没有启用该动态工具。" }],
          success: false
        }
      });
      return;
    }
    Promise.resolve(handler(call))
      .then((text) => this.send({
        id,
        result: { contentItems: [{ type: "inputText", text }], success: true }
      }))
      .catch((error) => this.send({
        id,
        result: {
          contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
          success: false
        }
      }));
  }

  private handleUserInputRequest(id: JsonRpcId, params: Record<string, unknown>): void {
    const request = parseUserInputRequest(params);
    const handler = request ? this.userInputHandlersByThread.get(request.threadId) : undefined;
    if (!request || !handler) {
      this.send({ id, result: { answers: {} } });
      return;
    }
    Promise.resolve(handler(request))
      .then((answers) => this.send({ id, result: { answers } }))
      .catch(() => this.send({ id, result: { answers: {} } }));
  }

  private handleChildFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) {
      return;
    }
    this.failTransport(error, false);
  }

  private failTransport(error: Error, kill: boolean): void {
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    this.lines?.close();
    this.lines = undefined;
    if (kill && child?.exitCode === null) {
      child.kill();
    }
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [key, waiter] of this.turnWaiters.entries()) {
      this.turnWaiters.delete(key);
      waiter.reject(error);
    }
    this.activeTurns.clear();
    this.approvalHandlersByThread.clear();
    this.dynamicToolHandlersByThread.clear();
    this.userInputHandlersByThread.clear();
    this.turnEvents.clear();
    this.turnTexts.clear();
    this.completedTurns.clear();
    this.turnStreams.clear();
    this.queuedTurnEvents.clear();
    this.itemPhasesByTurn.clear();
    this.reasoningSummariesByTurn.clear();
    this.runtimeInfoByThread.clear();
    this.threadStates.clear();
    this.projectIdsByRoot.clear();
    this.projectCatalogSupported = undefined;
    this.modelOptions = undefined;
  }
}

function describeItemProgress(item: Record<string, unknown> | undefined, completed: boolean): string | undefined {
  if (!item || typeof item.type !== "string") return undefined;
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
  const succeeded = !status || status === "completed" || status === "success" || status === "succeeded";
  const icon = completed ? succeeded ? "✅" : "❌" : "🔎";
  switch (item.type) {
    case "reasoning": {
      if (!completed) return undefined;
      const summary = reasoningSummaryText(item.summary);
      return summary ? `🤔 ${boundedText(summary, 600)}` : undefined;
    }
    case "commandExecution": {
      const command = safeCommandPreview(item.command);
      if (!completed) return `${icon} 正在执行命令${command ? `：${command}` : ""}`;
      const exitCode = typeof item.exitCode === "number" ? `，退出码 ${item.exitCode}` : "";
      const duration = formatDuration(item.durationMs);
      return `${icon} 命令${succeeded ? "完成" : "失败"}${command ? `：${command}` : ""}${exitCode}${duration}`;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.flatMap((value) => {
        const change = value as Record<string, unknown>;
        return typeof change.path === "string" ? [change.path] : [];
      });
      const suffix = paths.length ? `：${paths.slice(0, 3).map(shortPath).join("、")}${paths.length > 3 ? ` 等 ${paths.length} 个文件` : ""}` : "";
      return `${completed ? icon : "✏️"} ${completed ? `文件修改${succeeded ? "完成" : "失败"}` : "正在修改文件"}${suffix}`;
    }
    case "mcpToolCall": {
      const server = typeof item.server === "string" ? item.server : "MCP";
      const tool = typeof item.tool === "string" ? item.tool : "工具";
      return `${completed ? icon : "🔌"} ${completed ? `工具调用${succeeded ? "完成" : "失败"}` : "正在调用工具"}：${boundedText(`${server}/${tool}`, 120)}`;
    }
    case "dynamicToolCall": {
      const tool = typeof item.tool === "string" ? item.tool : "动态工具";
      return `${completed ? icon : "🧩"} ${completed ? `动态工具${succeeded ? "完成" : "失败"}` : "正在调用动态工具"}：${boundedText(tool, 120)}`;
    }
    case "collabToolCall": {
      const tool = typeof item.tool === "string" ? item.tool : "协作任务";
      return `${completed ? icon : "👥"} ${completed ? `协作步骤${succeeded ? "完成" : "失败"}` : "正在执行协作步骤"}：${boundedText(tool, 120)}`;
    }
    case "webSearch": {
      const query = typeof item.query === "string" ? boundedText(item.query, 180) : "";
      return `${completed ? icon : "🌐"} ${completed ? "网页检索完成" : "正在检索网页"}${query ? `：${query}` : ""}`;
    }
    case "imageView": {
      const imagePath = typeof item.path === "string" ? shortPath(item.path) : "";
      return `${completed ? icon : "🖼️"} ${completed ? "图片检查完成" : "正在检查图片"}${imagePath ? `：${imagePath}` : ""}`;
    }
    case "contextCompaction":
      return completed ? "✅ 上下文整理完成" : "🧹 正在整理长会话上下文";
    default:
      return undefined;
  }
}

function reasoningSummaryText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? [record.text] : [];
  }).join("\n").trim();
}

function safeCommandPreview(value: unknown): string {
  const command = Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string").join(" ")
    : typeof value === "string" ? value : "";
  if (!command) return "";
  const redacted = command
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 ***")
    .replace(/\b(token|secret|password|passwd|api[_-]?key)(\s*[:=]\s*)([^\s'\"]+)/gi, "$1$2***")
    .replace(/([?&](?:access_token|token|api_key)=)[^&\s]+/gi, "$1***");
  return `\`${boundedText(redacted.replace(/\s+/g, " ").trim(), 220).replaceAll("`", "'")}\``;
}

function shortPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return boundedText(parts.slice(-2).join("/") || normalized, 100);
}

function boundedText(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function formatDuration(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  return value < 1_000 ? `，${Math.round(value)}ms` : `，${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function appServerSandboxPolicy(sandbox: CodexExecSandbox | undefined): AppServerSandboxPolicy | undefined {
  switch (sandbox) {
    case undefined:
      return undefined;
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
}

function parseDynamicToolCall(params: Record<string, unknown>): CodexDynamicToolCall | undefined {
  if (
    typeof params.callId !== "string"
    || typeof params.threadId !== "string"
    || typeof params.turnId !== "string"
    || typeof params.tool !== "string"
  ) {
    return undefined;
  }
  return {
    callId: params.callId,
    threadId: params.threadId,
    turnId: params.turnId,
    tool: params.tool,
    arguments: params.arguments,
    ...(typeof params.namespace === "string" ? { namespace: params.namespace } : {})
  };
}

function parseUserInputRequest(params: Record<string, unknown>): CodexUserInputRequest | undefined {
  if (
    typeof params.itemId !== "string"
    || typeof params.threadId !== "string"
    || typeof params.turnId !== "string"
    || !Array.isArray(params.questions)
  ) {
    return undefined;
  }
  const questions = params.questions.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.header !== "string" || typeof item.id !== "string" || typeof item.question !== "string") {
      return [];
    }
    const options = Array.isArray(item.options)
      ? item.options.flatMap((rawOption) => {
          if (!rawOption || typeof rawOption !== "object") return [];
          const option = rawOption as Record<string, unknown>;
          return typeof option.label === "string" && typeof option.description === "string"
            ? [{ label: option.label, description: option.description }]
            : [];
        })
      : [];
    return [{
      header: item.header,
      id: item.id,
      question: item.question,
      ...(options.length ? { options } : {})
    }];
  });
  if (!questions.length) return undefined;
  return {
    itemId: params.itemId,
    threadId: params.threadId,
    turnId: params.turnId,
    questions,
    ...(typeof params.autoResolutionMs === "number" ? { autoResolutionMs: params.autoResolutionMs } : {})
  };
}

function parseThreadGoal(value: unknown): CodexThreadGoal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const goal = value as Record<string, unknown>;
  if (
    typeof goal.threadId !== "string"
    || typeof goal.objective !== "string"
    || !isGoalStatus(goal.status)
    || typeof goal.tokensUsed !== "number"
    || typeof goal.timeUsedSeconds !== "number"
    || typeof goal.createdAt !== "number"
    || typeof goal.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(typeof goal.tokenBudget === "number" ? { tokenBudget: goal.tokenBudget } : {})
  };
}

function isGoalStatus(value: unknown): value is CodexThreadGoalStatus {
  return value === "active"
    || value === "paused"
    || value === "blocked"
    || value === "usageLimited"
    || value === "budgetLimited"
    || value === "complete";
}

function isThreadBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already.*(active|running)|turn.*(active|in progress|running)|thread.*busy/i.test(message);
}

function isMissingProjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /project.*(?:not found|does not exist|missing)|(?:not found|does not exist|missing).*project/i.test(message);
}

function isUnsupportedProjectCatalogError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /project\/list/i.test(message)
    && /unknown variant|unknown method|method not found|unsupported|not implemented|expected one of/i.test(message);
}

function turnKeyFromParams(params: Record<string, unknown>): string | undefined {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  return threadId && turnId ? turnKey(threadId, turnId) : undefined;
}

type AppServerProject = {
  id: string;
  name: string;
  roots: string[];
};

function parseAppServerProject(value: unknown): AppServerProject | undefined {
  const project = value as Record<string, unknown> | undefined;
  if (!project || typeof project.id !== "string" || !project.id) return undefined;
  const roots = Array.isArray(project.roots)
    ? project.roots.flatMap((value) => {
      const root = value as Record<string, unknown>;
      return typeof root.path === "string" && root.path ? [root.path] : [];
    })
    : [];
  return {
    id: project.id,
    name: typeof project.name === "string" ? project.name : project.id,
    roots
  };
}

function cleanThreadTitle(value?: string): string | undefined {
  const title = value?.replace(/\s+/g, " ").trim();
  if (!title) return undefined;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

function shouldRepairBridgeThreadName(value?: string): boolean {
  if (!value?.trim()) return true;
  return /^(?:WeChat|Codex channel) bridge rule:|^\[codex-(?:weixin|channel-bridge)-private-knowledge]/i.test(value.trim());
}

function parseModelOption(value: unknown): CodexModelOption | undefined {
  const model = value as Record<string, unknown>;
  const modelId = typeof model.model === "string" && model.model
    ? model.model
    : typeof model.id === "string" ? model.id : "";
  if (!modelId || model.hidden === true) return undefined;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((value) => {
      const effort = value as Record<string, unknown>;
      return typeof effort.reasoningEffort === "string" && effort.reasoningEffort
        ? [{
          effort: effort.reasoningEffort,
          description: typeof effort.description === "string" ? effort.description : ""
        }]
        : [];
    })
    : [];
  return {
    model: modelId,
    displayName: typeof model.displayName === "string" && model.displayName ? model.displayName : modelId,
    description: typeof model.description === "string" ? model.description : "",
    isDefault: model.isDefault === true,
    ...(typeof model.defaultReasoningEffort === "string" && model.defaultReasoningEffort
      ? { defaultEffort: model.defaultReasoningEffort }
      : {}),
    supportedEfforts: efforts
  };
}

function runtimeInfoFromThreadResponse(response: Record<string, unknown>): CodexRuntimeInfo {
  return compactRuntimeInfo({
    model: response.model,
    effort: response.reasoningEffort,
    provider: response.modelProvider ?? response.model_provider
  });
}

function compactRuntimeInfo(input: { model?: unknown; effort?: unknown; provider?: unknown }): CodexRuntimeInfo {
  return {
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
    ...(typeof input.effort === "string" && input.effort ? { effort: input.effort } : {}),
    ...(typeof input.provider === "string" && input.provider ? { provider: input.provider } : {})
  };
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function persistenceFromThread(thread: Record<string, unknown>): CodexThreadPersistence {
  if (thread.ephemeral === true) return "ephemeral";
  const rolloutPath = typeof thread.path === "string"
    ? thread.path.replaceAll("\\", "/").toLowerCase()
    : "";
  return rolloutPath.includes("/archived_sessions/") ? "archived" : "active";
}

function parseRuntimeStatus(value: unknown): {
  runtimeStatus: CodexThreadRuntimeStatus;
  activeFlags: CodexThreadActiveFlag[];
} {
  const status = isRecord(value) ? value : undefined;
  const type = typeof value === "string"
    ? value
    : typeof status?.type === "string"
      ? status.type
      : undefined;
  const runtimeStatus: CodexThreadRuntimeStatus = type === "notLoaded"
    || type === "idle"
    || type === "active"
    || type === "systemError"
    ? type
    : "unknown";
  const activeFlags = Array.isArray(status?.activeFlags)
    ? status.activeFlags.filter((flag): flag is CodexThreadActiveFlag => (
      flag === "waitingOnApproval" || flag === "waitingOnUserInput"
    ))
    : [];
  return { runtimeStatus, activeFlags };
}

function normalizeTurnStatus(value: unknown): CodexTurnStatus | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.replaceAll(/[-_\s]/g, "").toLowerCase()) {
    case "inprogress":
    case "running":
    case "started":
      return "inProgress";
    case "completed":
    case "complete":
      return "completed";
    case "interrupted":
    case "aborted":
    case "cancelled":
    case "canceled":
      return "interrupted";
    case "failed":
    case "error":
      return "failed";
    default:
      return undefined;
  }
}

function parseThreadState(
  thread: Record<string, unknown>,
  persistence: CodexThreadPersistence
): CodexThreadState {
  const threadId = typeof thread.id === "string" ? thread.id : "";
  const turns = Array.isArray(thread.turns) ? thread.turns.filter(isRecord) : [];
  const latestTurn = turns.at(-1);
  const latestTurnStatus = normalizeTurnStatus(latestTurn?.status);
  const parsedRuntime = parseRuntimeStatus(thread.status);
  const runtimeStatus = parsedRuntime.runtimeStatus === "unknown"
    ? latestTurnStatus === "inProgress"
      ? "active"
      : "idle"
    : parsedRuntime.runtimeStatus;
  const updatedAt = unixTimestampToIso(
    thread.updatedAt ?? latestTurn?.completedAt ?? latestTurn?.startedAt ?? thread.createdAt
  );
  const preview = typeof thread.preview === "string" && thread.preview.trim()
    ? boundedText(thread.preview.replace(/\s+/g, " "), 240)
    : extractLastUserMessageFromTurn(latestTurn);
  return {
    threadId,
    persistence,
    runtimeStatus,
    ...(rolloutIdentity({ source: thread.source, thread_source: thread.threadSource ?? thread.thread_source }).internal ? { internal: true } : {}),
    activeFlags: parsedRuntime.activeFlags,
    ...(latestTurnStatus ? { latestTurnStatus } : {}),
    ...(latestTurnStatus === "inProgress" && typeof latestTurn?.id === "string"
      ? { activeTurnId: latestTurn.id }
      : {}),
    ...(typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
    ...(typeof thread.projectId === "string" ? { projectId: thread.projectId } : {}),
    ...(typeof thread.name === "string" && thread.name.trim() ? { title: thread.name.trim() } : {}),
    ...(preview ? { preview } : {}),
    ...(updatedAt ? { updatedAt } : {})
  };
}

function extractLastUserMessageFromTurn(turn: Record<string, unknown> | undefined): string | undefined {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isRecord(item) || item.type !== "userMessage") continue;
    const text = extractUserMessageText(item.content);
    if (text) return boundedText(text.replace(/\s+/g, " "), 240);
  }
  return undefined;
}

function unixTimestampToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return new Date(milliseconds).toISOString();
}

function normalizeThreadOperationError(error: unknown, threadId: string): Error {
  if (error instanceof CodexThreadStateError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/archiv|unarchive|已归档/i.test(message)) {
    return new CodexThreadStateError(
      "archived",
      threadId,
      `Codex session ${threadId} 已归档。请先在 Codex App 中恢复该 session 后再重试。`
    );
  }
  if (/not found|no rollout|does not exist|不存在|unknown thread|missing thread/i.test(message)) {
    return new CodexThreadStateError(
      "missing",
      threadId,
      `Codex session ${threadId} 不存在或已被删除，请重新选择 session。`
    );
  }
  if (/system.?error/i.test(message)) {
    return new CodexThreadStateError(
      "system-error",
      threadId,
      `Codex session ${threadId} 当前处于系统错误状态，请先在 Codex App 中打开并修复。`
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function normalizeSteerError(error: unknown, threadId: string, expectedTurnId: string): Error {
  const normalized = normalizeThreadOperationError(error, threadId);
  if (normalized instanceof CodexThreadStateError) return normalized;
  const message = normalized.message;
  if (/no active turn|not.*active|没有.*(?:任务|turn)|already completed/i.test(message)) {
    return new Error(`Codex session ${threadId} 的任务已经结束，无法介入；请把消息作为下一轮发送。`);
  }
  if (/expectedTurnId|expected turn|different turn|mismatch/i.test(message)) {
    return new Error(`Codex session ${threadId} 的活动任务已变化（原 turn ${expectedTurnId}），请刷新后重试。`);
  }
  if (/not steerable|review turn|compact turn|active_turn_not_steerable/i.test(message)) {
    return new Error(`Codex session ${threadId} 当前任务类型不支持运行中介入，请等待完成或先停止任务。`);
  }
  return normalized;
}

function isMissingOrArchivedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /archiv|unarchive|not found|no rollout|does not exist|不存在|unknown thread|missing thread/i.test(message);
}

function extractAgentMessageFromTurn(turn: Record<string, unknown> | undefined): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as Record<string, unknown>;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

export function parseThreadHistory(thread: Record<string, unknown> | undefined): CodexHistoryMessage[] {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages: CodexHistoryMessage[] = [];
  for (const rawTurn of turns) {
    const turn = rawTurn as Record<string, unknown>;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const userCreatedAt = unixSecondsToIso(turn.startedAt);
    const assistantCreatedAt = unixSecondsToIso(turn.completedAt ?? turn.startedAt);
    for (const rawItem of items) {
      const item = rawItem as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : `${String(turn.id ?? "turn")}:${messages.length}`;
      if (item.type === "userMessage") {
        const text = extractUserMessageText(item.content);
        if (text) {
          messages.push({ id, role: "user", text, ...(userCreatedAt ? { createdAt: userCreatedAt } : {}) });
        }
        continue;
      }
      if (
        item.type === "agentMessage"
        && typeof item.text === "string"
        && item.text.trim()
      ) {
        messages.push({
          id,
          role: "assistant",
          text: item.text.trim(),
          ...(item.phase === "commentary" ? { kind: "progress" as const } : {}),
          ...(assistantCreatedAt ? { createdAt: assistantCreatedAt } : {})
        });
      }
    }
  }
  return messages;
}

function extractUserMessageText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map((raw) => {
    const item = raw as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
    if (item.type === "localImage" && typeof item.path === "string") {
      return `[本机图片: ${item.path}]`;
    }
    if (item.type === "image" && typeof item.url === "string") {
      return `[图片: ${item.url}]`;
    }
    return "";
  }).filter(Boolean).join("\n").trim();
}

function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value * 1_000).toISOString();
}
