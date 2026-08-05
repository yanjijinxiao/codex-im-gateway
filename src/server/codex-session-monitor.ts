import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RESTORED_TASK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SESSION_CONTEXT_TAIL_BYTES = 8 * 1024 * 1024;
const STARTUP_MTIME_TOLERANCE_MS = 1_000;

export type CodexSessionCompletion = {
  sessionId: string;
  turnId: string;
  workspace: string;
  taskTitle: string;
  text: string;
  success: boolean;
  completedAt: string;
};

export type CodexSessionTaskStatus = "running" | "completed" | "failed" | "interrupted";

export type CodexSessionTask = {
  sessionId: string;
  turnId: string;
  workspace: string;
  title: string;
  status: CodexSessionTaskStatus;
  startedAt: string;
  updatedAt: string;
};

export type CodexSessionCompletionMonitorOptions = {
  codexHome?: string;
  pollIntervalMs?: number;
  now?: () => number;
  onCompletion: (completion: CodexSessionCompletion) => void | Promise<void>;
  onTaskChanged?: (task: CodexSessionTask) => void | Promise<void>;
};

type SessionCursor = {
  offset: number;
  emitAfter?: number;
  workspace?: string;
  sessionId?: string;
  taskTitle?: string;
  threadSource?: string;
  activeTurnId?: string;
  activeStartedAt?: string;
};

export class CodexSessionCompletionMonitor {
  private readonly codexHome: string;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly cursors = new Map<string, SessionCursor>();
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly pendingFiles = new Set<string>();
  private readonly processingFiles = new Set<string>();
  private initialization: Promise<void> = Promise.resolve();
  private scan?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private started = false;
  private runId = 0;

  constructor(private readonly options: CodexSessionCompletionMonitorOptions) {
    this.codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const runId = ++this.runId;
    const startedAt = this.now();
    const startedWallClock = Date.now();
    for (const root of this.sessionRoots()) this.watchRoot(root);
    this.initialization = this.initialize(runId, startedAt, startedWallClock).catch((error) => {
      console.error(`[codex-channel-bridge] unable to initialize Codex session monitor: ${String(error)}`);
    });
    this.timer = setInterval(() => {
      this.scanNow().catch((error) => {
        console.error(`[codex-channel-bridge] unable to scan Codex sessions: ${String(error)}`);
      });
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    const initialization = this.initialization;
    const scan = this.scan;
    this.started = false;
    this.runId += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    this.pendingFiles.clear();
    await Promise.allSettled(scan ? [initialization, scan] : [initialization]);
  }

  async scanNow(): Promise<void> {
    if (!this.started) return;
    if (this.scan) return this.scan;
    this.scan = this.performScan(this.runId);
    try {
      await this.scan;
    } finally {
      this.scan = undefined;
    }
  }

  async ready(): Promise<void> {
    await this.initialization;
  }

  private async initialize(runId: number, startedAt: number, startedWallClock: number): Promise<void> {
    const files = await this.listSessionFiles();
    if (!this.isActiveRun(runId)) return;
    const snapshots = await Promise.all(files.map(async (filePath) => ({
      filePath,
      stat: await safeFileStat(filePath)
    })));
    snapshots.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    for (const { filePath, stat } of snapshots) {
      if (!this.isActiveRun(runId)) return;
      // A real Codex home can contain gigabytes of session history. Yield once
      // per file so startup indexing never starves the local HTTP server.
      await yieldToEventLoop();
      if (!this.isActiveRun(runId)) return;
      const replayStartupWrite = this.pendingFiles.has(filePath)
        || stat.mtimeMs >= startedWallClock - STARTUP_MTIME_TOLERANCE_MS;
      const initialContext = await readInitialSessionContext(filePath, this.now(), stat);
      if (!this.isActiveRun(runId)) return;
      const cursor = {
        offset: replayStartupWrite ? Math.max(0, stat.size - SESSION_CONTEXT_TAIL_BYTES) : stat.size,
        ...(replayStartupWrite ? { emitAfter: startedAt } : {}),
        ...initialContext
      };
      this.cursors.set(filePath, cursor);
      if (replayStartupWrite) await this.processFile(filePath, runId);
      if (!this.isActiveRun(runId)) return;
      const task = taskFromCursor(cursor, "running", cursor.activeStartedAt);
      const activeStartedAt = Date.parse(cursor.activeStartedAt ?? "");
      const shouldRestoreReplayedTask = Number.isFinite(activeStartedAt)
        && activeStartedAt < startedAt
        && startedAt - activeStartedAt <= RESTORED_TASK_MAX_AGE_MS;
      if (task && (!replayStartupWrite || shouldRestoreReplayedTask)) {
        await this.options.onTaskChanged?.(task);
      }
    }
  }

  private isActiveRun(runId: number): boolean {
    return this.started && this.runId === runId;
  }

  private async performScan(runId: number): Promise<void> {
    await this.ready();
    if (!this.isActiveRun(runId)) return;
    const files = new Set([...await this.listSessionFiles(), ...this.pendingFiles]);
    if (!this.isActiveRun(runId)) return;
    this.pendingFiles.clear();
    for (const filePath of files) {
      if (!this.isActiveRun(runId)) return;
      await this.processFile(filePath, runId);
    }
  }

  private sessionRoots(): string[] {
    return [path.join(this.codexHome, "sessions"), path.join(this.codexHome, "archived_sessions")];
  }

  private watchRoot(root: string): void {
    if (!isDirectory(root)) return;
    try {
      const watcher = fs.watch(root, { recursive: true }, (_event, fileName) => {
        if (!fileName || !String(fileName).endsWith(".jsonl")) return;
        const filePath = path.resolve(root, String(fileName));
        if (!isWithin(root, filePath)) return;
        this.pendingFiles.add(filePath);
        setTimeout(() => void this.scanNow(), 150).unref();
      });
      this.watchers.push(watcher);
    } catch (error) {
      console.warn(`[codex-channel-bridge] unable to watch Codex sessions under ${root}: ${String(error)}`);
    }
  }

  private async listSessionFiles(): Promise<string[]> {
    return (await Promise.all(this.sessionRoots().map((root) => listJsonlFiles(root)))).flat();
  }

  private async processFile(filePath: string, runId?: number): Promise<void> {
    if (runId !== undefined && !this.isActiveRun(runId)) return;
    if (this.processingFiles.has(filePath)) return;
    this.processingFiles.add(filePath);
    try {
      const size = await safeFileSize(filePath);
      if (runId !== undefined && !this.isActiveRun(runId)) return;
      const cursor = this.cursors.get(filePath) ?? { offset: 0 };
      if (size < cursor.offset) cursor.offset = 0;
      if (size === cursor.offset) {
        this.cursors.set(filePath, cursor);
        return;
      }
      const buffer = await readFileRange(filePath, cursor.offset, size - cursor.offset);
      if (runId !== undefined && !this.isActiveRun(runId)) return;
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline < 0) return;
      const complete = buffer.subarray(0, lastNewline + 1);
      cursor.offset += complete.length;
      this.cursors.set(filePath, cursor);
      for (const line of complete.toString("utf8").split("\n")) {
        if (runId !== undefined && !this.isActiveRun(runId)) return;
        if (!line) continue;
        const event = parseRecord(line);
        if (!event) continue;
        await this.processEvent(cursor, event);
      }
      cursor.emitAfter = undefined;
    } catch (error) {
      console.error(`[codex-channel-bridge] unable to read Codex session completion: ${String(error)}`);
    } finally {
      this.processingFiles.delete(filePath);
    }
  }

  private async processEvent(cursor: SessionCursor, event: Record<string, unknown>): Promise<void> {
    const payload = recordValue(event.payload);
    if (event.type === "session_meta" && payload) {
      if (typeof payload.cwd === "string") cursor.workspace = path.resolve(payload.cwd);
      if (typeof payload.session_id === "string") cursor.sessionId = payload.session_id;
      else if (typeof payload.id === "string") cursor.sessionId = payload.id;
      if (typeof payload.thread_source === "string") cursor.threadSource = payload.thread_source;
      return;
    }
    if (event.type !== "event_msg" || !payload || cursor.threadSource === "subagent") return;
    const timestamp = eventTimestamp(event);
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      cursor.activeTurnId = payload.turn_id;
      cursor.activeStartedAt = timestamp;
      cursor.taskTitle = "";
      if (shouldEmitEvent(cursor, timestamp)) await this.emitTask(cursor, "running", timestamp);
      return;
    }
    if (payload.type === "user_message") {
      const message = typeof payload.message === "string" ? payload.message : "";
      cursor.taskTitle = oneLine(message).slice(0, 100);
      if (cursor.activeTurnId && shouldEmitEvent(cursor, timestamp)) {
        await this.emitTask(cursor, "running", timestamp);
      }
      return;
    }
    if (payload.type !== "task_complete" && payload.type !== "turn_aborted") return;
    if (!cursor.workspace || !cursor.sessionId || typeof payload.turn_id !== "string") return;
    const error = recordValue(payload.error);
    const status: CodexSessionTaskStatus = payload.type === "turn_aborted"
      ? "interrupted"
      : error
        ? "failed"
        : "completed";
    cursor.activeTurnId = payload.turn_id;
    if (!shouldEmitEvent(cursor, timestamp)) {
      cursor.activeTurnId = undefined;
      cursor.activeStartedAt = undefined;
      return;
    }
    await this.emitTask(cursor, status, timestamp);
    const success = status === "completed";
    const text = success && typeof payload.last_agent_message === "string"
      ? payload.last_agent_message
      : status === "failed"
        ? `Codex 任务执行失败${typeof error?.message === "string" ? `：${error.message}` : ""}`
        : `Codex 任务已中断${typeof payload.reason === "string" ? `：${payload.reason}` : ""}`;
    await this.options.onCompletion({
      sessionId: cursor.sessionId,
      turnId: payload.turn_id,
      workspace: cursor.workspace,
      taskTitle: cursor.taskTitle || "Codex 客户端会话",
      text,
      success,
      completedAt: timestamp
    });
    cursor.activeTurnId = undefined;
    cursor.activeStartedAt = undefined;
  }

  private async emitTask(
    cursor: SessionCursor,
    status: CodexSessionTaskStatus,
    updatedAt: string
  ): Promise<void> {
    const task = taskFromCursor(cursor, status, updatedAt);
    if (task) await this.options.onTaskChanged?.(task);
  }
}

function taskFromCursor(
  cursor: SessionCursor,
  status: CodexSessionTaskStatus,
  updatedAt = new Date().toISOString()
): CodexSessionTask | undefined {
  if (
    cursor.threadSource === "subagent"
    || !cursor.workspace
    || !cursor.sessionId
    || !cursor.activeTurnId
  ) return undefined;
  return {
    sessionId: cursor.sessionId,
    turnId: cursor.activeTurnId,
    workspace: cursor.workspace,
    title: cursor.taskTitle || "Codex 客户端会话",
    status,
    startedAt: cursor.activeStartedAt || updatedAt,
    updatedAt
  };
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(entryPath);
    }
  }
  return result;
}

async function readFileRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  const descriptor = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await descriptor.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await descriptor.close();
  }
}

async function readInitialSessionContext(
  filePath: string,
  nowMs: number,
  file: { size: number; mtimeMs: number }
): Promise<Omit<SessionCursor, "offset">> {
  try {
    const fileSize = file.size;
    const firstLine = (await readFileRange(filePath, 0, Math.min(fileSize, 128 * 1024)))
      .toString("utf8")
      .split("\n", 1)[0];
    const event = parseRecord(firstLine);
    const payload = event?.type === "session_meta" ? recordValue(event.payload) : undefined;
    if (!payload || typeof payload.cwd !== "string") return {};
    const sessionId = typeof payload.session_id === "string"
      ? payload.session_id
      : typeof payload.id === "string"
        ? payload.id
        : undefined;
    const context: Omit<SessionCursor, "offset"> = {
      workspace: path.resolve(payload.cwd),
      ...(sessionId ? { sessionId } : {}),
      ...(typeof payload.thread_source === "string" ? { threadSource: payload.thread_source } : {})
    };
    if (context.threadSource === "subagent" || nowMs - file.mtimeMs > 24 * 60 * 60 * 1000) {
      return context;
    }
    const tailOffset = Math.max(0, fileSize - SESSION_CONTEXT_TAIL_BYTES);
    for (const line of (await readFileRange(filePath, tailOffset, fileSize - tailOffset)).toString("utf8").split("\n")) {
      const tailEvent = parseRecord(line);
      const tailPayload = tailEvent?.type === "event_msg" ? recordValue(tailEvent.payload) : undefined;
      if (!tailPayload) continue;
      if (tailPayload.type === "task_started" && typeof tailPayload.turn_id === "string") {
        context.activeTurnId = tailPayload.turn_id;
        context.activeStartedAt = eventTimestamp(tailEvent!);
        context.taskTitle = undefined;
      } else if (
        tailPayload.type === "user_message"
        && context.activeTurnId
        && typeof tailPayload.message === "string"
      ) {
        context.taskTitle = oneLine(tailPayload.message).slice(0, 100);
      } else if (
        (tailPayload.type === "task_complete" || tailPayload.type === "turn_aborted")
        && tailPayload.turn_id === context.activeTurnId
      ) {
        context.activeTurnId = undefined;
        context.activeStartedAt = undefined;
      }
    }
    const startedAtMs = context.activeStartedAt ? Date.parse(context.activeStartedAt) : Number.NaN;
    if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs > RESTORED_TASK_MAX_AGE_MS) {
      context.activeTurnId = undefined;
      context.activeStartedAt = undefined;
      context.taskTitle = undefined;
    }
    return context;
  } catch {
    return {};
  }
}

async function safeFileStat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
  try {
    const stat = await fs.promises.stat(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

async function safeFileSize(filePath: string): Promise<number> {
  return (await safeFileStat(filePath)).size;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function shouldEmitEvent(cursor: SessionCursor, timestamp: string): boolean {
  if (cursor.emitAfter === undefined) return true;
  const eventTime = Date.parse(timestamp);
  return Number.isFinite(eventTime) && eventTime >= cursor.emitAfter;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    return recordValue(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function eventTimestamp(event: Record<string, unknown>): string {
  return typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
