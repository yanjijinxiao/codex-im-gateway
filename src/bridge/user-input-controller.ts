import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodexUserInputAnswer, CodexUserInputQuestion, CodexUserInputRequest, CodexUserInputResult } from "../codex/backend.js";
import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";
import type { ChannelReceipt } from "../channels/types.js";
import { asyncAnswerDigest, type NativeAsyncAnswerReceipt } from "../codex/async-user-input.js";

type QuestionStatus = "pending" | "answered" | "submitting" | "confirmed" | "withdrawn" | "unconfirmed" | "expired";
type QuestionRecord = {
  id: string; key: string; requestKey: string; senderId: string; hostId: string; threadId: string; turnId: string;
  question: CodexUserInputQuestion; status: QuestionStatus; deadline?: number;
  answer?: string; skipped?: boolean; messageId?: string; deliveryAttempted?: boolean; noticeAttempted?: boolean;
  kind?: "sync" | "async"; answerDigest?: string; noticeOutcome?: CodexUserInputResult;
};
type Waiter = { resolve: (answer: string | undefined) => void; timer?: NodeJS.Timeout };
type Options = {
  filePath?: string;
  updateCard?: (messageId: string, card: ChannelActionCard) => Promise<void>;
  sendNotice?: (senderId: string, text: string) => Promise<void>;
  validate?: (senderId: string, request: Pick<QuestionRecord, "hostId" | "threadId" | "turnId">) => boolean;
};

/** Account-scoped application controller. No Codex RPC or provider payloads. */
export class ChannelUserInputController {
  private state: { sequence: number; records: QuestionRecord[] };
  private readonly waiters = new Map<string, Waiter>();
  private readonly liveRequests = new Map<string, Promise<CodexUserInputAnswer | undefined>>();

  constructor(private readonly sendCard: (senderId: string, card: ChannelActionCard) => Promise<ChannelReceipt | void>,
    private readonly defaultTimeoutMs?: number, private readonly options: Options = {}) {
    this.state = options.filePath && fs.existsSync(options.filePath)
      ? JSON.parse(fs.readFileSync(options.filePath, "utf8")) : { sequence: 0, records: [] };
    if (!Number.isSafeInteger(this.state.sequence) || !Array.isArray(this.state.records)) throw new Error("Invalid user input journal");
    for (const record of this.state.records) if (record.status === "submitting") record.status = "unconfirmed";
  }

  request(senderId: string, request: CodexUserInputRequest): Promise<CodexUserInputAnswer | undefined> {
    const key = requestKey(senderId, request);
    const existing = this.liveRequests.get(key);
    if (existing) return existing;
    const promise = this.runRequest(senderId, request, key);
    this.liveRequests.set(key, promise);
    void promise.finally(() => { if (this.liveRequests.get(key) === promise) this.liveRequests.delete(key); }).catch(() => {});
    return promise;
  }

  private async runRequest(senderId: string, request: CodexUserInputRequest, key: string): Promise<CodexUserInputAnswer | undefined> {
    const answers: CodexUserInputAnswer = {};
    for (const [index, question] of request.questions.entries()) {
      const recordKey = JSON.stringify([key, question.id, crypto.createHash("sha256").update(JSON.stringify(question)).digest("hex")]);
      let record = this.state.records.find(item => item.key === recordKey);
      if (!record) {
        this.prune();
        if (this.state.records.length >= 500) throw new Error("Too many pending Codex questions");
        const timeout = request.autoResolutionMs === null ? undefined : request.autoResolutionMs ?? this.defaultTimeoutMs;
        record = { id: `Q${++this.state.sequence}`, key: recordKey, requestKey: key, senderId,
          hostId: request.hostId ?? "local", threadId: request.threadId, turnId: request.turnId,
          question, kind: request.kind, status: "pending", ...(timeout !== undefined ? { deadline: Date.now() + timeout } : {}) };
        this.state.records.push(record); this.save();
      }
      record.kind ??= request.kind;
      if (!["pending", "answered"].includes(record.status)) return undefined;
      if (record.status === "pending") {
        const answer = await this.ask(record, index, request.questions.length);
        if (!["answered", "expired"].includes(record.status)) return undefined;
        if (answer !== undefined) answers[question.id] = { answers: [answer] };
      } else if (!record.skipped && record.answer !== undefined) answers[question.id] = { answers: [record.answer] };
    }
    for (const record of this.state.records) if (record.requestKey === key && ["answered", "expired"].includes(record.status)) record.status = "submitting";
    this.save();
    return answers;
  }

  answer(senderId: string, arg: string): string {
    if (!arg.trim() || arg.trim() === "list") {
      const records = this.state.records.filter(record => this.pending(senderId, record.id));
      return records.length ? records.map(record => questionCard(record, 0, 1).fallbackText).join("\n\n")
        : "当前绑定没有已恢复的待回答问题。未确认的提交请在 Codex App 核对。";
    }
    const parsed = /^\s*(Q\d+)\s+([\s\S]+)$/i.exec(arg);
    if (!parsed) return "用法：/answer Q编号 回答内容；选择选项用 /answer Q编号 --option 1；跳过用 /skip Q编号。";
    const record = this.pending(senderId, parsed[1]);
    if (!record) return "问题不存在、已处理、绑定已切换或尚未恢复；未提交回答。";
    if (record.question.isSecret) return "此问题包含敏感输入，请在 Codex App 中回答，不通过 IM 提交。";
    const raw = parsed[2].trim();
    const selected = /^--option\s+(\d+)$/i.exec(raw);
    const answer = selected ? record.question.options?.[Number(selected[1]) - 1]?.label : raw;
    if (!answer || answer.length > 2_000) return selected ? "选项不存在，请使用问题中的选项编号。" : "回答不能为空，且不能超过 2000 字符。";
    this.settle(record, answer);
    return `已记录问题 ${record.id} 的回答；是否生效以 Codex 接收回执为准。`;
  }

  skip(senderId: string, arg: string): string {
    const record = this.pending(senderId, arg.trim());
    if (!record) return "问题不存在、已处理、绑定已切换或尚未恢复；未提交跳过。";
    this.settle(record, undefined);
    return `已提交跳过问题 ${record.id}；这不等于批准任何操作。`;
  }

  private pending(senderId: string, id: string): QuestionRecord | undefined {
    const record = this.state.records.find(item => item.id === id.toUpperCase() && item.senderId === senderId && item.status === "pending");
    if (!record || !this.waiters.has(record.id)) return undefined;
    if (record.deadline !== undefined && Date.now() >= record.deadline) { this.expire(record); return undefined; }
    return this.options.validate && !this.options.validate(senderId, record) ? undefined : record;
  }

  private settle(record: QuestionRecord, answer: string | undefined): void {
    record.status = "answered"; record.skipped = answer === undefined; record.answer = answer;
    if (record.kind === "async" && !record.question.isSecret) record.answerDigest = asyncAnswerDigest(record.question.id, record.question.question, answer ?? "");
    this.save(); this.release(record.id, answer);
  }

  private async ask(record: QuestionRecord, index: number, total: number): Promise<string | undefined> {
    const answer = new Promise<string | undefined>(resolve => {
      const waiter: Waiter = { resolve };
      if (record.deadline !== undefined) {
        waiter.timer = setTimeout(() => this.expire(record), Math.max(0, record.deadline - Date.now()));
        waiter.timer.unref?.();
      }
      this.waiters.set(record.id, waiter);
    });
    if (!record.deliveryAttempted) {
      record.deliveryAttempted = true; this.save();
      try {
        const sent = await this.sendCard(record.senderId, questionCard(record, index, total));
        if (sent?.messageId) record.messageId = sent.messageId;
        this.save();
      } catch {
        console.warn("[codex-im-gateway] user-input notice unconfirmed; original native request retained");
      }
    }
    return answer;
  }

  async reportResult(senderId: string, request: CodexUserInputRequest, result: CodexUserInputResult): Promise<void> {
    const key = requestKey(senderId, request);
    for (const record of this.state.records.filter(record => record.requestKey === key)) {
      if (record.status === "confirmed") continue; // Native evidence is monotonic; late RPC failure cannot undo it.
      if (result === "suspended") { this.release(record.id); continue; }
      record.status = result === "failed" ? "unconfirmed" : result;
      delete record.answer; this.release(record.id); this.save();
      if ((record.noticeAttempted && !(result === "confirmed" && record.noticeOutcome !== "confirmed")) || !record.deliveryAttempted) continue;
      record.noticeAttempted = true; record.noticeOutcome = result; this.save();
      const text = result === "confirmed" ? `Codex 已确认接收问题 ${record.id} 的回答。`
        : result === "withdrawn" ? `问题 ${record.id} 已失效或已在 Codex 中处理。`
        : `问题 ${record.id} 的回答尚未获 Codex 确认，未自动重发；请在 Codex App 核对。`;
      if (record.messageId && this.options.updateCard) {
        await this.options.updateCard(record.messageId, createChoiceCard({ title: `Codex 问题 ${record.id} · 已处理`,
          body: text, fallbackText: text, choices: [], template: "grey" })).catch(() => {});
      } else await this.options.sendNotice?.(senderId, text).catch(() => {});
    }
  }

  /** Read-only receipt recovery also works after restart; never resends an answer. */
  async observeNativeAnswers(receipts: readonly NativeAsyncAnswerReceipt[]): Promise<void> {
    for (const receipt of receipts) for (const record of this.state.records) {
      if (record.kind !== "async" || record.status === "confirmed" || !record.answerDigest
        || record.hostId !== receipt.hostId || record.threadId !== receipt.threadId || record.turnId !== receipt.turnId
        || record.question.id !== receipt.questionId || record.answerDigest !== receipt.digest
        || this.options.validate && !this.options.validate(record.senderId, record)) continue;
      const [, , , , itemId, , requestId] = JSON.parse(record.requestKey) as unknown[];
      await this.reportResult(record.senderId, { kind: "async", hostId: record.hostId, threadId: record.threadId,
        turnId: record.turnId, itemId: String(itemId), requestId: requestId as string | number, questions: [record.question] }, "confirmed");
    }
  }

  cancelSender(senderId: string): void {
    for (const record of this.state.records) if (record.senderId === senderId && this.waiters.has(record.id)) {
      record.status = "withdrawn"; delete record.answer; this.release(record.id);
    }
    this.save();
  }
  hasRequest(senderId: string, request: CodexUserInputRequest): boolean {
    return this.state.records.some(record => record.requestKey === requestKey(senderId, request)
      && ["pending", "answered", "submitting", "unconfirmed"].includes(record.status));
  }
  suspendInvalidBindings(): void {
    if (!this.options.validate) return;
    for (const record of this.state.records) if (this.waiters.has(record.id)
      && !this.options.validate(record.senderId, record)) this.release(record.id);
  }
  close(): void { for (const id of this.waiters.keys()) this.release(id); this.liveRequests.clear(); this.save(); }
  private expire(record: QuestionRecord): void { record.status = "expired"; this.save(); this.release(record.id); }
  private release(id: string, answer?: string): void {
    const waiter = this.waiters.get(id); if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    this.waiters.delete(id); waiter.resolve(answer);
  }
  private prune(): void {
    const done = this.state.records.filter(record => ["confirmed", "withdrawn", "expired"].includes(record.status)).slice(-100);
    this.state.records = [...this.state.records.filter(record => !["confirmed", "withdrawn", "expired"].includes(record.status)), ...done];
  }
  private save(): void {
    if (!this.options.filePath) return;
    fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temporary, this.options.filePath);
  }
}

function requestKey(senderId: string, request: CodexUserInputRequest): string {
  return JSON.stringify([senderId, request.hostId ?? "local", request.threadId, request.turnId, request.itemId,
    typeof request.requestId, request.requestId]);
}

function questionCard(record: QuestionRecord, index: number, total: number): ChannelActionCard {
  const { question, id } = record;
  const title = `Codex 问题 ${id}${total > 1 ? ` · ${index + 1}/${total}` : ""}`;
  const body = question.isSecret ? "此问题需要敏感输入，请在 Codex App 中回答。"
    : [question.question, ...(question.options ?? []).map((option, index) => `${index + 1}. ${option.label}\n${option.description}`),
      `回答：/answer ${id} 回答内容`, ...(question.options?.length ? [`选择：/answer ${id} --option 1`] : []), `跳过：/skip ${id}`].join("\n\n");
  return { ...createChoiceCard({ title, body, fallbackText: `【${title}】\n\n${body}`, template: "orange",
    choices: question.isSecret ? [] : [...(question.options ?? []).map((option, index) => ({ label: option.label,
      command: "answer" as const, arg: `${id} --option ${index + 1}` })), { label: "跳过", command: "skip" as const, arg: id }] }),
    ...(!question.isSecret ? { form: { name: "answer", label: "你的回答", maximumLength: 2_000,
      submit: { label: "发送回答", style: "primary" as const,
        value: { version: 4 as const, command: "answer" as const, arg: "submit" as const, questionId: id } } } } : {}) };
}
