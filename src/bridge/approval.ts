import type {
  CodexApprovalDecision,
  CodexApprovalRequest
} from "../codex/approval.js";
import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

type PendingApproval = {
  id: string;
  senderId: string;
  resolve: (decision: CodexApprovalDecision) => void;
  timer: NodeJS.Timeout;
};

export type ChannelApprovalNotice = {
  readonly text: string;
  readonly card?: ChannelActionCard;
};

export class ChannelApprovalController {
  private readonly pending = new Map<string, PendingApproval>();
  private nextId = 1;

  constructor(
    private readonly send: (senderId: string, notice: ChannelApprovalNotice) => Promise<void>,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS
  ) {}

  request(senderId: string, request: CodexApprovalRequest): Promise<CodexApprovalDecision> {
    const id = `A${this.nextId++}`;
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
    return decision === "accept" ? `已批准审批 ${id}。` : `已拒绝审批 ${id}。`;
  }

  declineAll(senderId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.senderId === senderId) this.settle(senderId, pending.id, "decline");
    }
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
      : ["类型：申请额外权限", request.permissions ? `权限：${limit(JSON.stringify(request.permissions))}` : undefined];
  const timeout = `${Math.max(1, Math.ceil(timeoutMs / 60_000))} 分钟内未处理将自动拒绝。`;
  const summary = [
    `【Codex 审批 ${id}】`,
    ...details,
    request.cwd ? `工作目录：${request.cwd}` : undefined,
    request.reason ? `原因：${limit(request.reason)}` : undefined,
    `回复 /approve ${id}（/ok ${id}）批准一次`,
    `回复 /reject ${id}（/no ${id}）拒绝`,
    timeout
  ].filter(Boolean).join("\n");
  const body = [
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
