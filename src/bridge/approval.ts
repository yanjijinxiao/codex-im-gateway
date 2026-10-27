import crypto from "node:crypto";
import {
  approvalOptions,
  type CodexApprovalOption,
  type CodexApprovalDecision,
  type CodexApprovalRequest
} from "../codex/approval.js";
import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";
import { copyBlock } from "../channels/copyable.js";
import { ApprovalJournal } from "./approval-journal.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

type PendingApproval = {
  id: string;
  senderId: string;
  resolve: (decision: CodexApprovalDecision) => void;
  timer: NodeJS.Timeout;
  request: CodexApprovalRequest;
  promise: Promise<CodexApprovalDecision>;
  version: string;
  createdAt: number;
  expiresAt: number;
};

export type ApprovalDeliveryResult = "confirmed" | "failed" | "withdrawn";
export class ApprovalDecisionConflictError extends Error {}

export type ChannelApprovalNotice = {
  readonly text: string;
  readonly card?: ChannelActionCard;
};

export class ChannelApprovalController {
  private readonly pending = new Map<string, PendingApproval>();
  private nextId = 1;
  private readonly notices = new WeakMap<CodexApprovalRequest, { id: string; senderId: string }>();
  private readonly journal: ApprovalJournal;

  constructor(
    private readonly send: (senderId: string, notice: ChannelApprovalNotice) => Promise<void>,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    private readonly allocateId?: () => string,
    journalFile?: string
  ) { this.journal = new ApprovalJournal(journalFile); }

  request(senderId: string, request: CodexApprovalRequest): Promise<CodexApprovalDecision> {
    const snapshot = structuredClone(request);
    const version = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const existing = snapshot.nativeKey && [...this.pending.values()].find(p => p.senderId === senderId && p.request.nativeKey === snapshot.nativeKey);
    if (existing) {
      if (existing.version !== version) return Promise.reject(new Error("Native approval identity changed its scope"));
      this.notices.set(request, { id: existing.id, senderId });
      return existing.promise;
    }
    const id = this.allocateId?.() ?? `A${this.nextId++}`;
    this.notices.set(request, { id, senderId });
    let resolve!: (value: CodexApprovalDecision) => void;
    const promise = new Promise<CodexApprovalDecision>(done => { resolve = done; });
    const createdAt = Date.now(), expiresAt = createdAt + this.timeoutMs;
    this.journal.add({ id, recipientId: senderId, threadId: snapshot.threadId, hostId: snapshot.hostId ?? "local", version, createdAt });
    {
      const timer = setTimeout(() => {
        if (!this.settle(senderId, id, denial(snapshot))) return;
        this.sendNotice(senderId, { text: `审批 ${id} 已超时，已选择拒绝；是否生效以 Codex 回执为准。` }).catch((error: unknown) => {
          console.warn(`Unable to send approval timeout ${id}: ${errorDetail(error)}`);
        });
      }, this.timeoutMs);
      this.pending.set(this.key(senderId, id), { id, senderId, resolve, timer, request: snapshot,
        promise, version, createdAt, expiresAt });
      this.sendNotice(senderId, approvalNotice(id, snapshot, this.timeoutMs)).catch((error: unknown) => {
        console.warn(`Unable to send approval ${id}: ${errorDetail(error)}`);
        this.settle(senderId, id, denial(snapshot));
      });
    }
    return promise;
  }

  decide(senderId: string, rawId: string, decision: CodexApprovalDecision): string {
    const parts = rawId.trim().split(/\s+/);
    if (parts.length > 2 || decision !== "accept" && parts.length > 1) return "审批命令格式不正确，请使用该审批卡中的完整命令。";
    const id = this.resolveId(senderId, parts[0] ?? "");
    if (!id) return "当前没有待审批请求，或审批编号不属于这个账号。";
    const pending = this.pending.get(this.key(senderId, id))!;
    if (Date.now() >= pending.expiresAt) {
      this.settle(senderId, id, denial(pending.request));
      return "审批已过期，已选择拒绝，等待 Codex 确认；请等待新的原生请求。";
    }
    const selected = approvalOptions(pending.request).find(o => o.id === (parts[1] ?? decision));
    if (!selected) return "该请求不支持这个授权范围；请使用审批卡当前提供的选项。";
    this.settle(senderId, id, selected.id);
    return `已提交${selected.id === "decline" || selected.id === "cancel" ? "拒绝" : "批准"}审批 ${id}（${selected.label}）的决定；是否生效以 Codex 接收结果为准。`;
  }

  list() {
    return [...this.pending.values()].map(p => ({ id: p.id, recipientId: p.senderId, threadId: p.request.threadId,
      hostId: p.request.hostId ?? "local", version: p.version, createdAt: p.createdAt, expiresAt: p.expiresAt,
      kind: p.request.kind, body: approvalDetails(p.request).filter(Boolean).join("\n"),
      options: approvalOptions(p.request).map(({ id, label, description }) => ({ id, label, description })) }));
  }

  private sendNotice(senderId: string, notice: ChannelApprovalNotice): Promise<void> {
    try { return Promise.resolve(this.send(senderId, notice)); }
    catch (error) { return Promise.reject(error); }
  }
  decideCurrent(senderId: string, id: string, choice: string, version: string): string {
    const pending = this.pending.get(this.key(senderId, id));
    if (!pending || pending.version !== version || Date.now() >= pending.expiresAt) throw new ApprovalDecisionConflictError("审批已处理、已过期或范围发生变化，请刷新。");
    if (!approvalOptions(pending.request).some(o => o.id === choice)) throw new ApprovalDecisionConflictError("原生请求不支持此授权范围");
    return this.decide(senderId, `${id} ${choice}`, "accept");
  }

  async reportResult(senderId: string, request: CodexApprovalRequest, result: ApprovalDeliveryResult): Promise<void> {
    const notice = this.notices.get(request);
    if (!notice || notice.senderId !== senderId) return;
    this.notices.delete(request);
    // An approval handled in Desktop (or removed by a task switch) must no
    // longer be actionable from a stale IM notice.
    if (result === "withdrawn" || result === "failed") {
      const pending = this.pending.get(this.key(senderId, notice.id));
      if (pending) this.settle(senderId, notice.id, denial(pending.request));
    }
    this.journal.update(notice.id, { phase: result });
    const text = result === "confirmed"
      ? `Codex 已确认接收审批 ${notice.id} 的决定。`
      : result === "withdrawn"
        ? `审批 ${notice.id} 已失效或已在 Codex 中处理，请以 Codex 当前状态为准。`
        : `审批 ${notice.id} 的决定未获 Codex 确认，不能确认已生效。请在 Codex 中检查；不要重复批准其他请求。`;
    await this.send(senderId, { text });
  }

  declineAll(senderId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.senderId === senderId) this.settle(senderId, pending.id, denial(pending.request));
    }
  }

  hasPending(senderId: string): boolean {
    return [...this.pending.values()].some(item => item.senderId === senderId);
  }

  private resolveId(senderId: string, rawId: string): string | undefined {
    const normalized = rawId.trim().toUpperCase();
    if (normalized) return this.pending.has(this.key(senderId, normalized)) ? normalized : undefined;
    const matches = Array.from(this.pending.values()).filter((pending) => pending.senderId === senderId);
    return matches.length === 1 ? matches[0]?.id : undefined;
  }

  private settle(senderId: string, id: string, decision: CodexApprovalDecision): boolean {
    const key = this.key(senderId, id);
    const pending = this.pending.get(key);
    if (!pending) return false;
    const option = approvalOptions(pending.request).find(o => o.id === decision);
    try { this.journal.update(id, { phase: "unconfirmed", choice: decision, label: option?.label ?? decision }); }
    catch (error) {
      // Never authorize without the audit commit. Denial must still release a
      // native waiter on timeout/shutdown even if the disk has become unavailable.
      if (decision !== denial(pending.request)) throw error;
      console.warn(`[codex-im-gateway] approval ${id} denied; audit write unavailable`);
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }

  private key(senderId: string, id: string): string {
    return `${senderId}\u0000${id}`;
  }
}

function approvalDetails(request: CodexApprovalRequest) {
  const details = request.kind === "command"
    ? ["类型：运行命令", request.command ? `命令：\n${limit(request.command)}` : undefined]
    : request.kind === "file"
      ? ["类型：修改文件", request.grantRoot ? `写入范围：${request.grantRoot}` : undefined]
      : request.kind === "mcp"
        ? ["类型：工具操作确认", request.serverName ? `来源：${request.serverName}` : undefined]
        : ["类型：申请额外权限", request.permissions ? `权限：${limit(JSON.stringify(request.permissions))}` : undefined];
  return [`会话：${request.threadId}`, ...details,
    request.cwd ? `工作目录：${request.cwd}` : undefined,
    request.reason ? `原因：${limit(request.reason)}` : undefined,
    request.scopeDescription ? `授权对象：${limit(request.scopeDescription)}` : undefined];
}
function approvalNotice(id: string, request: CodexApprovalRequest, timeoutMs: number): ChannelApprovalNotice {
  const timeout = `${Math.max(1, Math.ceil(timeoutMs / 60_000))} 分钟内未处理将自动拒绝。`;
  const body = approvalDetails(request).filter(Boolean).join("\n");
  const options = approvalOptions(request);
  const command = (o: CodexApprovalOption) => o.id === "decline" ? `/reject ${id}` : `/approve ${id}${o.id === "accept" ? "" : ` ${o.id}`}`;
  const summary = [`【Codex 审批 ${id}】`, body,
    ...options.map(o => `${o.label}：${o.description}\n\n${copyBlock(command(o))}`), timeout].join("\n\n");
  return {
    text: summary,
    card: createChoiceCard({
      title: `Codex 审批 ${id}`,
      template: "orange",
      body,
      note: timeout,
      fallbackText: summary,
      choices: options.map(o => ({ label: o.label, command: o.id === "decline" ? "reject" : "approve",
        arg: o.id === "accept" || o.id === "decline" ? id : `${id} ${o.id}`,
        style: o.id === "decline" || o.id === "cancel" ? "danger" : o.id === "accept" ? "primary" : "default",
        ...(o.id !== "decline" && o.id !== "cancel" ? { confirm: o.description } : {}) }))
    })
  };
}
function denial(request: CodexApprovalRequest): CodexApprovalDecision {
  return approvalOptions(request).some(o => o.id === "decline") ? "decline" : "cancel";
}

function limit(value: string): string {
  return value.length > 1_200 ? `${value.slice(0, 1_200)}…` : value;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
