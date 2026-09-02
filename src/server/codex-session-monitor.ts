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

export type CodexSessionActivity = {
  sessionId: string;
  turnId: string;
  text: string;
  updatedAt: string;
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
  onActivity?: (activity: CodexSessionActivity) => void | Promise<void>;
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
  toolNames?: Map<string, string>;
  lastActivityByTurn?: Map<string, string>;
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
      console.error(`[codex-im-gateway] unable to initialize Codex session monitor: ${String(error)}`);
    });
    this.timer = setInterval(() => {
      this.scanNow().catch((error) => {
        console.error(`[codex-im-gateway] unable to scan Codex sessions: ${String(error)}`);
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
    return [path.join(this.codexHome, "sessions")];
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
      console.warn(`[codex-im-gateway] unable to watch Codex sessions under ${root}: ${String(error)}`);
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
      console.error(`[codex-im-gateway] unable to read Codex session completion: ${String(error)}`);
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
    if (!payload || cursor.threadSource === "subagent") return;
    const timestamp = eventTimestamp(event);
    if (event.type === "response_item") {
      await this.processResponseItem(cursor, payload, timestamp);
      return;
    }
    if (event.type !== "event_msg") return;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      cursor.activeTurnId = payload.turn_id;
      cursor.activeStartedAt = timestamp;
      cursor.taskTitle = "";
      cursor.toolNames = new Map();
      cursor.lastActivityByTurn ??= new Map();
      cursor.lastActivityByTurn.delete(payload.turn_id);
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
    if (payload.type === "agent_reasoning" && typeof payload.text === "string") {
      await this.emitActivity(cursor, `🤔 ${boundedText(payload.text, 600)}`, timestamp);
      return;
    }
    if (
      payload.type === "agent_message"
      && payload.phase === "commentary"
      && typeof payload.message === "string"
    ) {
      await this.emitActivity(cursor, boundedText(payload.message, 600), timestamp);
      return;
    }
    if (payload.type === "item_completed") {
      const item = recordValue(payload.item);
      if (item) {
        await this.processCompletedItem(
          cursor,
          item,
          timestamp,
          typeof payload.turn_id === "string" ? payload.turn_id : undefined
        );
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
    cursor.toolNames = undefined;
    cursor.lastActivityByTurn?.delete(payload.turn_id);
  }

  private async processResponseItem(
    cursor: SessionCursor,
    payload: Record<string, unknown>,
    timestamp: string
  ): Promise<void> {
    if (!cursor.activeTurnId || !shouldEmitEvent(cursor, timestamp)) return;
    const metadata = recordValue(payload.internal_chat_message_metadata_passthrough);
    const itemTurnId = typeof metadata?.turn_id === "string" ? metadata.turn_id : undefined;
    if (payload.type === "reasoning") {
      const summary = reasoningSummaryText(payload.summary);
      if (summary) await this.emitActivity(cursor, `🤔 ${boundedText(summary, 600)}`, timestamp, itemTurnId);
      return;
    }
    if (payload.type === "message" && payload.phase === "commentary") {
      const commentary = messageContentText(payload.content);
      if (commentary) await this.emitActivity(cursor, boundedText(commentary, 600), timestamp, itemTurnId);
      return;
    }
    if (payload.type === "custom_tool_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const name = typeof payload.name === "string" ? payload.name : "tool";
      if (callId) {
        cursor.toolNames ??= new Map();
        cursor.toolNames.set(callId, name);
      }
      await this.emitActivity(cursor, `🔎 ${desktopToolDescription(name, false)}`, timestamp);
      return;
    }
    if (payload.type === "custom_tool_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const name = callId ? cursor.toolNames?.get(callId) : undefined;
      await this.emitActivity(cursor, `✅ ${desktopToolDescription(name ?? "tool", true)}`, timestamp);
    }
  }

  private async processCompletedItem(
    cursor: SessionCursor,
    item: Record<string, unknown>,
    timestamp: string,
    turnId?: string
  ): Promise<void> {
    const type = typeof item.type === "string"
      ? item.type.replace(/[_-]/g, "").toLowerCase()
      : "";
    if (type === "reasoning") {
      const summary = reasoningSummaryText(item.summary_text ?? item.summary);
      if (summary) await this.emitActivity(cursor, `🤔 ${boundedText(summary, 600)}`, timestamp, turnId);
      return;
    }
    if (type === "agentmessage" && String(item.phase).toLowerCase() === "commentary") {
      const commentary = typeof item.text === "string" ? item.text : messageContentText(item.content);
      if (commentary) await this.emitActivity(cursor, boundedText(commentary, 600), timestamp, turnId);
      return;
    }
    const completed = completedDesktopItemDescription(type, item);
    if (completed) await this.emitActivity(cursor, completed, timestamp, turnId);
  }

  private async emitTask(
    cursor: SessionCursor,
    status: CodexSessionTaskStatus,
    updatedAt: string
  ): Promise<void> {
    const task = taskFromCursor(cursor, status, updatedAt);
    if (task) await this.options.onTaskChanged?.(task);
  }

  private async emitActivity(
    cursor: SessionCursor,
    text: string,
    updatedAt: string,
    turnId?: string
  ): Promise<void> {
    const content = text.trim();
    const targetTurnId = turnId ?? cursor.activeTurnId;
    if (
      !this.options.onActivity
      || !cursor.sessionId
      || !targetTurnId
      || !content
      || cursor.lastActivityByTurn?.get(targetTurnId) === content
      || !shouldEmitEvent(cursor, updatedAt)
    ) return;
    cursor.lastActivityByTurn ??= new Map();
    cursor.lastActivityByTurn.set(targetTurnId, content);
    if (cursor.lastActivityByTurn.size > 20) {
      cursor.lastActivityByTurn.delete(cursor.lastActivityByTurn.keys().next().value as string);
    }
    await this.options.onActivity({
      sessionId: cursor.sessionId,
      turnId: targetTurnId,
      text: content,
      updatedAt
    });
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
  return new Promise((resolve) => setTimeout(resolve, 1));
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

function reasoningSummaryText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    const record = recordValue(part);
    return typeof record?.text === "string" ? [record.text] : [];
  }).join("\n").trim();
}

function messageContentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    const record = recordValue(part);
    return typeof record?.text === "string" ? [record.text] : [];
  }).join("\n").trim();
}

function completedDesktopItemDescription(type: string, item: Record<string, unknown>): string | undefined {
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "completed";
  const failed = status === "failed" || status === "error" || status === "cancelled";
  const icon = failed ? "❌" : "✅";
  const result = failed ? "失败" : "完成";
  switch (type) {
    case "commandexecution":
      return `${icon} 执行本地操作${result}`;
    case "filechange":
      return `${icon} 修改文件${result}`;
    case "imageview":
      return `${icon} 检查图片${result}`;
    case "mcptoolcall":
      return `${icon} 调用 MCP 工具${result}`;
    case "dynamictoolcall":
      return `${icon} 调用动态工具${result}`;
    case "collabtoolcall":
      return `${icon} 执行协作步骤${result}`;
    case "websearch":
      return `${icon} 查询网页${result}`;
    case "contextcompaction":
      return `${icon} 整理长会话上下文${result}`;
    default:
      return undefined;
  }
}

function desktopToolDescription(name: string, completed: boolean): string {
  const normalized = name.toLowerCase();
  const action = normalized.includes("view_image")
    ? "检查图片"
    : normalized.includes("web")
      ? "查询网页"
      : normalized.includes("exec") || normalized.includes("command")
        ? "执行本地操作"
        : normalized.includes("patch") || normalized.includes("file")
          ? "修改文件"
          : normalized.includes("collaboration")
            ? "执行协作步骤"
            : `调用工具 ${boundedText(name, 80)}`;
  return completed ? `${action}完成` : `正在${action}`;
}

function boundedText(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
