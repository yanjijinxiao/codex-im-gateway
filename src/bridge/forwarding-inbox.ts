import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ChannelMessage } from "../channels/message.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { ForwardingDeferredError } from "./forwarding-error.js";
import type { InboundReceiptJournal, InboundReceipt } from "./inbound-receipts.js";

const attachment = z.object({ kind: z.enum(["image", "file", "video", "audio"]), label: z.string(),
  item: z.record(z.string(), z.unknown()), path: z.string().optional(), sourceMessageId: z.string().optional() });
const messageSchema = z.object({ id: z.string().min(1), senderId: z.string().min(1), replyTargetId: z.string().optional(),
  text: z.string(), attachments: z.array(attachment), raw: z.record(z.string(), z.unknown()),
  mention: z.object({ userId: z.string(), name: z.string().optional() }).optional(),
  conversationKind: z.enum(["direct", "group"]).optional(), source: z.literal("native-menu").optional(),
  contextToken: z.string().optional(), interaction: z.object({ kind: z.literal("card"), messageId: z.string() }).optional(),
  unsupportedMessageType: z.string().optional(), references: z.array(z.object({ messageId: z.string().optional(),
    senderId: z.string().optional(), type: z.string(), text: z.string().optional(), attachments: z.array(attachment),
    availability: z.enum(["available", "metadata-only", "unavailable"]), reason: z.string().optional() })).optional() });
const targetSchema = z.object({ sessionId: z.string(), threadId: z.string().optional(), hostId: z.string(),
  workspace: z.string(), projectId: z.string().optional(), projectBinding: z.string().optional(),
  mode: z.string(), generation: z.string().optional(), roots: z.array(z.string()) });
export type ForwardingTarget = z.infer<typeof targetSchema>;
export type ForwardingItem = { id: string; state: "pending" | "held" | "unconfirmed"; text: string; attachments: string[];
  target?: ForwardingTarget; currentTarget?: ForwardingTarget; targetVersion?: string; receivedAt: number; retryable: boolean; cancellable: boolean };
const rowSchema = z.object({ message: messageSchema, prepared: messageSchema.optional(), target: targetSchema.optional(), receivedAt: z.number().finite(),
  nextAt: z.number().finite(), attempts: z.number().int().nonnegative(), automatic: z.boolean(),
  state: z.enum(["pending", "held", "unconfirmed"]), noticed: z.array(z.enum(["pending", "held", "unconfirmed"])) });
type Row = z.infer<typeof rowSchema>;
const idOf = (id: string) => crypto.createHash("sha256").update(id.trim()).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
type Options = {
  filePath: string; receipts: InboundReceiptJournal;
  target: (message: ChannelMessage) => ForwardingTarget | undefined;
  automatic: (message: ChannelMessage) => boolean;
  canDispatch: () => boolean;
  dispatch: (message: ChannelMessage) => Promise<void>;
  notice: (message: ChannelMessage, text: string) => Promise<void>;
  now?: () => number; retryMs?: number;
};

/** Durable transport inbox, not a task execution queue. Only a native receipt
 * decides whether an input was submitted. Never replay accepted/ambiguous input.
 * Store normalized content and opaque attachment descriptors, never raw provider
 * callbacks (which contain webhook credentials). Files are written with 0600. */
export class ForwardingInbox {
  private readonly rows: Record<string, Row>;
  private readonly processing = new Set<string>();
  private timer?: NodeJS.Timeout;
  private stopped = true;
  constructor(private readonly options: Options) {
    const saved = z.object({ version: z.literal(1), rows: z.record(z.string().regex(/^[a-f0-9]{64}$/), rowSchema) })
      .parse(readJsonFile(options.filePath, { version: 1, rows: {} }));
    if (Object.entries(saved.rows).some(([key, row]) => key !== idOf(row.message.id))) throw Error("Invalid forwarding inbox identity; original file preserved");
    this.rows = saved.rows;
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private save(): void { writeJsonFile(this.options.filePath, { version: 1, rows: this.rows }, { durable: true }); }
  private normalize(input: ChannelMessage): ChannelMessage {
    // Weixin's contextToken and attachment descriptors are required to deliver
    // the saved message. The raw callback is neither necessary nor retained.
    const message = messageSchema.parse({ ...input, attachments: (input.attachments ?? []).map(a => ({ ...a, item: a.item ?? {} })), raw: {} });
    if (Buffer.byteLength(JSON.stringify(message)) > 4 * 1024 * 1024) throw Error("Inbound envelope exceeds durable forwarding limit; message not accepted");
    return message;
  }
  claim(message: ChannelMessage): boolean {
    if (!this.options.receipts.claim(message)) return false;
    try { this.stage(message); }
    catch (error) { this.options.receipts.releasePreparation(message.id); throw error; }
    return true;
  }
  private stage(input: ChannelMessage): Row {
    const message = this.normalize(input), key = idOf(message.id), previous = this.rows[key];
    if (previous) {
      if (!equal(previous.message, message)) throw Error("Inbound source identity changed; original message preserved");
      return previous;
    }
    const row: Row = { message, target: structuredClone(this.options.target(message)), receivedAt: this.now(), nextAt: this.now(),
      attempts: 0, automatic: this.options.automatic(message), state: "pending", noticed: [] };
    this.rows[key] = row;
    try { this.save(); } catch (error) { delete this.rows[key]; throw error; }
    return row;
  }
  async receive(message: ChannelMessage): Promise<void> {
    const receipt = this.options.receipts.receipt(message.id);
    if (receipt && ["accepted", "handled"].includes(receipt.phase)) { this.remove(idOf(message.id)); return; }
    if (!receipt && !this.claim(message)) return;
    const row = this.stage(message);
    await this.deliver(idOf(message.id), row, true);
  }
  start(): void {
    this.stopped = false;
    if (!this.timer) { this.timer = setInterval(() => this.tick(), 1000); this.timer.unref(); }
    this.tick();
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  prepared(messageId: string, attachments: ChannelMessage["attachments"], references?: ChannelMessage["references"]): void {
    const row = this.rows[idOf(messageId)]; if (!row) return;
    // Bridge may rewrite senderId to the conversation and temporarily remove
    // command text. Retain the original envelope/command, update files only.
    try {
      for (const file of new Set(attachments.flatMap(a => a.path ? [a.path] : []))) {
        if (!path.isAbsolute(file)) throw Error("Prepared attachment path must be absolute");
        const fd = fs.openSync(file, "r");
        try { if (!fs.fstatSync(fd).isFile()) throw Error("Prepared attachment is not a file"); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        if (process.platform !== "win32") {
          const directory = fs.openSync(path.dirname(file), "r");
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
      }
      const prepared = this.normalize({ ...row.message, attachments: attachments.filter(a => !a.sourceMessageId),
        references: (references ?? row.message.references)?.map(ref => {
          const files = attachments.filter(a => a.sourceMessageId && a.sourceMessageId === ref.messageId);
          return files.length ? { ...ref, attachments: files } : ref;
        }) });
      const previous = row.prepared; row.prepared = prepared;
      try { this.save(); } catch (error) { row.prepared = previous; throw error; }
    } catch (error) { throw new ForwardingDeferredError("附件尚未完成持久化，消息暂缓转发。", { cause: error }); }
  }
  summary(conversationId: string): { waiting: number; held: number; unconfirmed: number } {
    const rows = Object.values(this.rows).filter(r => (r.message.replyTargetId ?? r.message.senderId) === conversationId
      && (r.automatic || r.attempts === 0 || r.state !== "pending")
      && !["accepted", "handled"].includes(this.options.receipts.receipt(r.message.id)?.phase ?? "received"));
    return { waiting: rows.filter(r => r.state === "pending").length, held: rows.filter(r => r.state === "held").length,
      unconfirmed: rows.filter(r => r.state === "unconfirmed").length };
  }
  private version(target: ForwardingTarget | undefined): string {
    return crypto.createHash("sha256").update(canonical(target) ?? "null").digest("hex").slice(0, 16);
  }
  items(conversationId: string): ForwardingItem[] {
    return Object.entries(this.rows).filter(([, r]) => (r.message.replyTargetId ?? r.message.senderId) === conversationId
      && (r.automatic || r.attempts === 0 || r.state !== "pending")
      && !["accepted", "handled"].includes(this.options.receipts.receipt(r.message.id)?.phase ?? "received"))
      .map(([key, row]) => {
        const phase = this.options.receipts.receipt(row.message.id)?.phase;
        const safe = phase === "received" && !this.processing.has(key);
        const current = this.options.target(row.message);
        return { id: `F${key.slice(0, 12)}`, state: row.state, text: row.message.text,
          attachments: row.message.attachments.map(a => a.label), target: structuredClone(row.target),
          currentTarget: structuredClone(current), targetVersion: this.version(current), receivedAt: row.receivedAt,
          retryable: safe && row.automatic && Boolean(current), cancellable: safe };
      });
  }
  private controlled(id: string, conversationId: string, actorId: string, controller: boolean): [string, Row] {
    if (!/^F[a-f0-9]{12}$/.test(id)) throw Error("转发记录编号无效，请重新查看列表。");
    const matches = Object.entries(this.rows).filter(([key, row]) => key.startsWith(id.slice(1))
      && (row.message.replyTargetId ?? row.message.senderId) === conversationId);
    if (matches.length !== 1) throw Error("记录已结束或不属于当前对话，请重新查看列表。");
    const [key, row] = matches[0];
    if (row.message.senderId !== actorId && !controller) throw Error("只能处理自己的转发消息，或由本群控制者操作。");
    if (this.processing.has(key) || this.options.receipts.receipt(row.message.id)?.phase !== "received")
      throw Error("该消息正在交接或提交结果未确认，不能重发或取消；原回执已保留。");
    return [key, row];
  }
  retry(id: string, conversationId: string, actorId: string, controller: boolean, expectedTarget: string): void {
    const [, row] = this.controlled(id, conversationId, actorId, controller);
    if (!row.automatic) throw Error("这条 Gateway 操作可能已部分执行，不能自动重放；请核对原操作结果。");
    const current = this.options.target(row.message);
    if (!current || this.version(current) !== expectedTarget) throw Error("当前绑定已改变或不可用，请重新查看该记录后再操作。");
    const previous = structuredClone(row);
    row.target = structuredClone(current); row.state = "pending"; row.nextAt = this.now(); row.noticed = [];
    try { this.save(); } catch (error) { Object.assign(row, previous); throw error; }
    this.tick();
  }
  cancel(id: string, conversationId: string, actorId: string, controller: boolean): void {
    const [key, row] = this.controlled(id, conversationId, actorId, controller);
    if (!this.options.receipts.abandon(row.message.id)) throw Error("转发状态已变化，未取消。");
    this.remove(key);
  }
  private tick(): void {
    if (this.stopped || !this.options.canDispatch()) return;
    for (const [key, row] of Object.entries(this.rows).sort((a, b) => a[1].receivedAt - b[1].receivedAt)) {
      const preparing = [...this.processing].filter(id => this.rows[id]
        && !["accepted", "handled"].includes(this.options.receipts.receipt(this.rows[id].message.id)?.phase ?? "received")).length;
      if (preparing >= 4 && row.automatic) continue;
      if (this.processing.has(key)) continue;
      const receipt = this.options.receipts.receipt(row.message.id);
      if (receipt && ["accepted", "handled"].includes(receipt.phase)) { this.remove(key); continue; }
      if (row.state !== "pending" || row.nextAt > this.now()) continue;
      void this.deliver(key, row, false).catch(() => console.warn("[codex-im-gateway] saved message forwarding deferred; content and source receipt retained"));
    }
  }
  private remove(key: string): void {
    const row = this.rows[key]; if (!row) return;
    delete this.rows[key];
    try { this.save(); } catch (error) { this.rows[key] = row; throw error; }
  }
  private async inform(row: Row, text: string): Promise<void> {
    if (row.noticed.includes(row.state)) return;
    // A lost notice acknowledgement must not flood the conversation on every
    // retry. This receipt is presentation-only, never native acceptance.
    row.noticed.push(row.state); this.save();
    try { await this.options.notice(row.message, text); }
    catch { console.warn("[codex-im-gateway] saved message notice not confirmed; forwarding record retained"); }
  }
  private async deliver(key: string, row: Row, initial: boolean): Promise<void> {
    if (this.processing.has(key) || this.rows[key] !== row) return;
    this.processing.add(key);
    try {
      const receipt = this.options.receipts.receipt(row.message.id);
      if (receipt && ["accepted", "handled"].includes(receipt.phase)) { this.remove(key); return; }
      if (receipt && ["submitting", "unconfirmed"].includes(receipt.phase)) {
        row.state = "unconfirmed"; this.save();
        await this.inform(row, "消息内容已保存，但之前的提交结果尚未确认；已保留回执，不会重复提交。"); return;
      }
      if (row.state !== "pending") return;
      if (!initial && !row.automatic && row.attempts > 0) {
        row.state = "held"; this.save();
        await this.inform(row, "这条操作消息已保存，但重启前的处理阶段无法安全确认，未自动重复执行。"); return;
      }
      if (!equal(row.target, this.options.target(row.message))) {
        row.state = "held"; this.save();
        await this.inform(row, "消息内容已保存，但目标绑定已改变；未转发到新的会话，需要核对原消息目标。"); return;
      }
      // Preserve the source order through native acceptance, not through task
      // completion. Explicit Gateway controls (/status, /stop, approvals) bypass
      // this transport ordering so they remain available during a long task.
      const conversation = row.message.replyTargetId ?? row.message.senderId;
      const preceding = Object.entries(this.rows).slice(0, Object.keys(this.rows).indexOf(key)).some(([, prior]) => prior.automatic
        && (prior.message.replyTargetId ?? prior.message.senderId) === conversation && equal(prior.target, row.target)
        && !["accepted", "handled"].includes(this.options.receipts.receipt(prior.message.id)?.phase ?? "received"));
      if (row.automatic && preceding) {
        row.nextAt = this.now() + (this.options.retryMs ?? 2000); this.save();
        await this.inform(row, "消息已保存，等待前一条输入完成转发交接；无需重发。"); return;
      }
      if (!this.options.canDispatch()) {
        row.nextAt = this.now() + (this.options.retryMs ?? 2000); this.save();
        await this.inform(row, "消息已保存，等待 Gateway 恢复转发；无需重发。"); return;
      }
      row.attempts++; this.save();
      try { await this.options.dispatch({ ...(row.prepared ?? row.message), receivedAt: row.receivedAt }); this.remove(key); }
      catch (error) {
        const after = this.options.receipts.receipt(row.message.id);
        if (after && ["accepted", "handled"].includes(after.phase)) { this.remove(key); throw error; }
        if ((!after || after.phase === "received") && row.automatic
          && (error instanceof ForwardingDeferredError || error instanceof CodexCommunicationError && error.submission === "not-submitted")) {
          row.nextAt = this.now() + Math.min(60_000, (this.options.retryMs ?? 2000) * 2 ** Math.min(5, row.attempts - 1)); this.save();
          await this.inform(row, "消息已保存，正在等待原会话恢复转发；尚未提交给 Codex，无需重发。"); return;
        }
        row.state = after && ["submitting", "unconfirmed"].includes(after.phase) ? "unconfirmed" : "held";
        this.save(); throw error;
      }
    } finally { this.processing.delete(key); }
  }
  /** Only an exact durable acceptance may advance a previously uncreated
   * thread. Pending messages cannot follow a detach/rebind or reset by name. */
  accepted(receipt: Readonly<InboundReceipt>): void {
    const key = receipt.clientUserMessageId.slice("gateway-".length), source = this.rows[key];
    if (!source || !receipt.threadId || !receipt.turnId && !receipt.queuedSubmissionId) return;
    const current = this.options.target(source.message), previous = source.target;
    const base = (target: ForwardingTarget) => { const { threadId: _thread, generation: _generation, ...rest } = target; return rest; };
    if (previous && !previous.threadId && current?.threadId === receipt.threadId && current.sessionId === receipt.sessionId
      && current.hostId === (receipt.hostId ?? "local") && equal(base(previous), base(current))) {
      for (const row of Object.values(this.rows)) if (row.state === "pending" && equal(row.target, previous)) row.target = structuredClone(current);
      this.save();
    }
    this.remove(key);
  }
}
