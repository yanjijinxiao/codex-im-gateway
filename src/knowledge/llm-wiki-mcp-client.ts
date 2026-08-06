import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

import type { ManagedKnowledgeBase } from "../state/runtime-state.js";

const execFileAsync = promisify(execFile);
const MCP_PROTOCOL_VERSION = "2025-06-18";

export type LlmWikiStatus = {
  documentCount: number;
  blockCount: number;
  rawArtifactCount: number;
  latestRunId?: string;
  latestRunStatus?: string;
};

export type LlmWikiInspection = {
  status: LlmWikiStatus;
  command: string;
};

type JsonRpcId = number;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type McpToolCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export class LlmWikiMcpClientPool {
  private readonly sessions = new Map<string, StdioMcpSession>();

  async inspect(knowledgeBase: ManagedKnowledgeBase): Promise<LlmWikiInspection> {
    return inspectLlmWikiKnowledgeBase(knowledgeBase);
  }

  async call(
    knowledgeBase: ManagedKnowledgeBase,
    tool: "search" | "get_document",
    args: Record<string, unknown>
  ): Promise<string> {
    const key = `${knowledgeBase.id}:${knowledgeBase.updatedAt}`;
    let session = this.sessions.get(key);
    if (!session) {
      for (const [candidateKey, candidate] of this.sessions) {
        if (candidateKey.startsWith(`${knowledgeBase.id}:`)) {
          candidate.close();
          this.sessions.delete(candidateKey);
        }
      }
      session = new StdioMcpSession(knowledgeBase);
      this.sessions.set(key, session);
    }
    return session.call(tool, args);
  }

  invalidate(knowledgeBaseId: string): void {
    for (const [key, session] of this.sessions) {
      if (!key.startsWith(`${knowledgeBaseId}:`)) continue;
      session.close();
      this.sessions.delete(key);
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

export async function inspectLlmWikiKnowledgeBase(
  knowledgeBase: ManagedKnowledgeBase
): Promise<LlmWikiInspection> {
  assertDirectory(knowledgeBase.rootPath, "知识库根目录");
  if (knowledgeBase.stateDir) assertDirectory(knowledgeBase.stateDir, "llm-wiki state 目录");
  const command = resolveLlmWikiCommand(knowledgeBase);
  const args = ["status", knowledgeBase.rootPath, "--json"];
  if (knowledgeBase.stateDir) args.push("--state-dir", knowledgeBase.stateDir);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }));
  } catch (error) {
    throw new Error(`llm-wiki 状态检查失败：${errorMessage(error)}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new Error("llm-wiki status 未返回有效 JSON", { cause: error });
  }
  if (!raw || typeof raw !== "object") throw new Error("llm-wiki status 返回格式无效");
  const value = raw as Record<string, unknown>;
  return {
    command,
    status: {
      documentCount: numberField(value.document_count),
      blockCount: numberField(value.block_count),
      rawArtifactCount: numberField(value.raw_artifact_count),
      ...(typeof value.latest_run_id === "string" ? { latestRunId: value.latest_run_id } : {}),
      ...(typeof value.latest_run_status === "string" ? { latestRunStatus: value.latest_run_status } : {})
    }
  };
}

export function llmWikiDynamicTools(): readonly Record<string, unknown>[] {
  return [{
    type: "namespace",
    name: "knowledge",
    description: "选中的 llm-wiki 只读知识库。需要事实依据时先搜索，再按需读取文档；回答中保留 anchor 引用。",
    tools: [{
      type: "function",
      name: "search",
      description: "搜索知识库并返回带 document_id、anchor、snippet、score、artifact_hash 的稳定证据引用。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "自然语言或关键词检索式" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 10 }
        },
        required: ["query"],
        additionalProperties: false
      }
    }, {
      type: "function",
      name: "get_document",
      description: "按 document_id 获取一份规范化 typed IR 文档 JSON，用于核对完整上下文。",
      inputSchema: {
        type: "object",
        properties: {
          document_id: { type: "string", minLength: 1 }
        },
        required: ["document_id"],
        additionalProperties: false
      }
    }]
  }];
}

class StdioMcpSession {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: readline.Interface;
  private nextId = 1;
  private stderr = "";
  private startPromise?: Promise<void>;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  constructor(private readonly knowledgeBase: ManagedKnowledgeBase) {}

  async call(tool: "search" | "get_document", args: Record<string, unknown>): Promise<string> {
    await this.start();
    const raw = await this.request("tools/call", { name: tool, arguments: args });
    const result = raw as McpToolCallResult;
    if (result.isError) {
      const detail = result.content?.map((item) => item.text).filter(Boolean).join("\n") || "未知错误";
      throw new Error(`llm-wiki ${tool} 调用失败：${detail}`);
    }
    const output = result.structuredContent ?? result.content ?? null;
    return JSON.stringify(output, null, 2);
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    if (child?.exitCode === null) child.kill();
    this.rejectPending(new Error("llm-wiki MCP client closed"));
  }

  private async start(): Promise<void> {
    if (this.child?.exitCode === null && !this.child.stdin.destroyed) return;
    if (!this.startPromise) {
      this.startPromise = this.startChild().finally(() => {
        this.startPromise = undefined;
      });
    }
    await this.startPromise;
  }

  private async startChild(): Promise<void> {
    const command = resolveLlmWikiCommand(this.knowledgeBase);
    const args = ["mcp", this.knowledgeBase.rootPath];
    if (this.knowledgeBase.stateDir) args.push("--state-dir", this.knowledgeBase.stateDir);
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    this.child = child;
    this.stderr = "";
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-20_000);
    });
    child.once("error", (error) => this.handleFailure(child, error));
    child.once("exit", (code, signal) => {
      const suffix = this.stderr.trim() ? `：${this.stderr.trim()}` : "";
      this.handleFailure(
        child,
        new Error(`llm-wiki MCP 已退出（${code ?? "unknown"}${signal ? `/${signal}` : ""}）${suffix}`)
      );
    });
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codex-channel-bridge", version: "0.4.0" }
    });
    this.notify("notifications/initialized", {});
    const tools = await this.request("tools/list", {}) as { tools?: Array<{ name?: string }> };
    const names = new Set((tools.tools ?? []).map((item) => item.name));
    if (!names.has("search") || !names.has("get_document")) {
      this.close();
      throw new Error("该 llm-wiki MCP 未提供 search/get_document 只读工具");
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`llm-wiki MCP ${method} 超时`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.stdin.destroyed) {
      throw new Error("llm-wiki MCP stdio 未连接");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`llm-wiki MCP 请求失败：${message.error.message ?? "unknown error"}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function resolveLlmWikiCommand(knowledgeBase: ManagedKnowledgeBase): string {
  const configured = process.env.LLM_WIKI_BIN?.trim();
  if (configured) return configured;
  const engineRoot = knowledgeBase.engineRoot ?? knowledgeBase.rootPath;
  const candidates = process.platform === "win32"
    ? [
        path.join(engineRoot, "skills", "knowledge-base", ".venv", "Scripts", "llm-wiki.exe"),
        path.join(engineRoot, ".venv", "Scripts", "llm-wiki.exe")
      ]
    : [
        path.join(engineRoot, "skills", "knowledge-base", ".venv", "bin", "llm-wiki"),
        path.join(engineRoot, ".venv", "bin", "llm-wiki")
      ];
  const command = candidates.find((candidate) => isExecutableFile(candidate));
  if (command) return command;
  throw new Error(
    `未找到 llm-wiki 可执行文件。请先在 ${engineRoot} 完成 llm-wiki 环境安装，或设置 LLM_WIKI_BIN。`
  );
}

function assertDirectory(target: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    throw new Error(`${label}不存在：${target}`, { cause: error });
  }
  if (!stat.isDirectory()) throw new Error(`${label}不是目录：${target}`);
}

function isExecutableFile(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
