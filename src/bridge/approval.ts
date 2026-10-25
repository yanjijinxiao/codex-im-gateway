import type {
  CodexApprovalDecision,
  CodexApprovalRequest
} from "../codex/approval.js";
import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";
import { copyBlock } from "../channels/copyable.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

type PendingApproval = {
  id: string;
  senderId: string;
  resolve: (decision: CodexApprovalDecision) => void;
  timer: NodeJS.Timeout;
};

export type ApprovalDeliveryResult = "confirmed" | "failed" | "withdrawn";

export type ChannelApprovalNotice = {
  readonly text: string;
  readonly card?: ChannelActionCard;
};

export class ChannelApprovalController {
  private readonly pending = new Map<string, PendingApproval>();
  private nextId = 1;
  private readonly notices = new WeakMap<CodexApprovalRequest, { id: string; senderId: string }>();

  constructor(
    private readonly send: (senderId: string, notice: ChannelApprovalNotice) => Promise<void>,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    private readonly allocateId?: () => string
  ) {}

  request(senderId: string, request: CodexApprovalRequest): Promise<CodexApprovalDecision> {
    const id = this.allocateId?.() ?? `A${this.nextId++}`;
    this.notices.set(request, { id, senderId });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.settle(senderId, id, "decline")) return;
        this.send(senderId, { text: `审批 ${id} 已超时，已自动拒绝。` }).catch((error: unknown) => {
          console.warn(`Unable to send approval timeout ${id}: ${errorDetail(error)}`);
        });
      }, this.timeoutMs);
      this.pending.set(this.key(senderId, id), { id, senderId, resolve, timer });
      this.send(senderId, approvalNotice(id, request, this.timeoutMs)).catch((error: unknown) => {
        console.warn(`Unable to send approval ${id}: ${errorDetail(error)}`);
        this.settle(senderId, id, "decline");
      });
    });
  }

  decide(senderId: string, rawId: string, decision: CodexApprovalDecision): string {
    const id = this.resolveId(senderId, rawId);
    if (!id) return "当前没有待审批请求，或审批编号不属于这个账号。";
    this.settle(senderId, id, decision);
    return `已提交${decision === "accept" ? "批准" : "拒绝"}审批 ${id} 的决定；是否生效以 Codex 接收结果为准。`;
  }

  async reportResult(senderId: string, request: CodexApprovalRequest, result: ApprovalDeliveryResult): Promise<void> {
    const notice = this.notices.get(request);
    if (!notice || notice.senderId !== senderId) return;
    this.notices.delete(request);
    // An approval handled in Desktop (or removed by a task switch) must no
    // longer be actionable from a stale IM notice.
    if (result === "withdrawn") this.settle(senderId, notice.id, "decline");
    const text = result === "confirmed"
      ? `Codex 已确认接收审批 ${notice.id} 的决定。`
      : result === "withdrawn"
        ? `审批 ${notice.id} 已失效或已在 Codex 中处理，请以 Codex 当前状态为准。`
        : `审批 ${notice.id} 的决定未获 Codex 确认，不能确认已生效。请在 Codex 中检查；不要重复批准其他请求。`;
    await this.send(senderId, { text });
  }

  declineAll(senderId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.senderId === senderId) this.settle(senderId, pending.id, "decline");
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
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }

  private key(senderId: string, id: string): string {
    return `${senderId}\u0000${id}`;
  }
}

function approvalNotice(id: string, request: CodexApprovalRequest, timeoutMs: number): ChannelApprovalNotice {
  const details = request.kind === "command"
    ? ["类型：运行命令", request.command ? `命令：\n${limit(request.command)}` : undefined]
    : request.kind === "file"
      ? ["类型：修改文件", request.grantRoot ? `写入范围：${request.grantRoot}` : undefined]
      : request.kind === "mcp"
        ? ["类型：工具操作确认（仅本次）", request.serverName ? `来源：${request.serverName}` : undefined]
        : ["类型：申请额外权限", request.permissions ? `权限：${limit(JSON.stringify(request.permissions))}` : undefined];
  const timeout = `${Math.max(1, Math.ceil(timeoutMs / 60_000))} 分钟内未处理将自动拒绝。`;
  const summary = [
    `【Codex 审批 ${id}】`,
    `会话：${request.threadId}`,
    ...details,
    request.cwd ? `工作目录：${request.cwd}` : undefined,
    request.reason ? `原因：${limit(request.reason)}` : undefined,
    `批准一次：\n\n${copyBlock(`/approve ${id}`)}`,
    `拒绝：\n\n${copyBlock(`/reject ${id}`)}`,
    timeout
  ].filter(Boolean).join("\n");
  const body = [
    `会话：${request.threadId}`,
    ...details,
    request.cwd ? `工作目录：${request.cwd}` : undefined,
    request.reason ? `原因：${limit(request.reason)}` : undefined
  ].filter(Boolean).join("\n");
  return {
    text: summary,
    card: createChoiceCard({
      title: `Codex 审批 ${id}`,
      template: "orange",
      body,
      note: timeout,
      fallbackText: summary,
      choices: [
        { label: "批准", command: "approve", arg: id, style: "primary", confirm: "确认批准本次操作？" },
        { label: "拒绝", command: "reject", arg: id, style: "danger" }
      ]
    })
  };
}

function limit(value: string): string {
  return value.length > 1_200 ? `${value.slice(0, 1_200)}…` : value;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
