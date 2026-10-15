import crypto from "node:crypto";
import { ChannelTurnTextStream, type ChannelStreamCheckpoint } from "./progress.js";
import type { ChannelTextClient } from "./types.js";

export type TurnReplyStream = Pick<ChannelTurnTextStream, "supported" | "checkpoint" | "deliveryState" | "suspend"
  | "flush" | "synchronize" | "progress" | "answer" | "finalize" | "fail" | "waitForBackend" | "reportTerminalFailure">;
type Persistence = NonNullable<ConstructorParameters<typeof ChannelTurnTextStream>[2]>;
type Segment = NonNullable<ChannelStreamCheckpoint["segments"]>["previous"][number];
type Boundary = { id: string; kind: "answer" | "steer" };

/** One logical turn presentation, possibly several cards. Never controls Codex.
 * The segment intent and both handles are durable BEFORE either HTTP mutation.
 * An old summary failure cannot redirect/overwrite the current task's result. */
export class ChannelTurnPresentation implements TurnReplyStream {
  private current: ChannelTurnTextStream;
  private readonly acceptedInputs: string[];
  private readonly previous: Segment[];
  private answerPrefix?: { length: number; digest: string };
  private lastAnswer = "";
  private tail: Promise<unknown> = Promise.resolve();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly oldStreams = new Map<string, ChannelTurnTextStream>();
  private suspended = false;
  private closed = false;

  constructor(private readonly client: ChannelTextClient, private readonly toUserId: string,
    private readonly persistence?: Persistence) {
    const segments = persistence?.restore?.segments;
    this.acceptedInputs = [...(segments?.acceptedInputs ?? [])];
    this.previous = structuredClone(segments?.previous ?? []);
    this.answerPrefix = segments?.answerPrefix;
    this.current = this.makeStream(persistence?.restore);
  }

  get supported(): boolean { return this.current.supported; }
  checkpoint(): ChannelStreamCheckpoint {
    const checkpoint = frame(this.current.checkpoint());
    return this.acceptedInputs.length || this.previous.length ? { ...checkpoint, segments: {
      acceptedInputs: [...this.acceptedInputs], previous: structuredClone(this.previous),
      ...(this.answerPrefix ? { answerPrefix: this.answerPrefix } : {})
    } } : checkpoint;
  }
  deliveryState(): ReturnType<ChannelTurnTextStream["deliveryState"]> { return this.current.deliveryState(); }
  private save(): void { if (!this.closed) this.persistence?.save(this.checkpoint()); }
  private makeStream(restore?: ChannelStreamCheckpoint): ChannelTurnTextStream {
    const stream = new ChannelTurnTextStream(this.client, this.toUserId, { ...this.persistence, restore: restore && frame(restore),
      save: checkpoint => {
        if (this.closed) return;
        if (this.current !== stream) {
          const retired = this.previous.find(item => item.checkpoint.streamId === checkpoint.streamId);
          if (retired) retired.checkpoint = frame(checkpoint);
        }
        this.save();
      }
    });
    return stream;
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(action);
    this.tail = next;
    return next;
  }

  async startSegment(boundary: Boundary): Promise<boolean> {
    return this.run(async () => {
      if (this.suspended || this.acceptedInputs.includes(boundary.id)
        || this.current.checkpoint().finished || this.current.checkpoint().terminal) return false;
      this.acceptedInputs.push(boundary.id);
      // Text-only transports retain their native presentation, not fake cards.
      if (!this.supported) { this.save(); return false; }
      const old = this.current;
      const checkpoint = frame(old.checkpoint());
      const hasCard = Boolean(checkpoint.messageId || checkpoint.creationAttempted || checkpoint.bootstrap);
      if (this.lastAnswer) this.answerPrefix = { length: this.lastAnswer.length, digest: digest(this.lastAnswer) };
      if (hasCard) {
        checkpoint.terminal = { text: stageSummary(checkpoint, boundary.kind), error: false };
        const retired = { inputId: boundary.id, checkpoint, attempts: 0 };
        this.previous.push(retired);
        this.current = this.makeStream();
        this.oldStreams.set(boundary.id, old);
        // Persist the new stable stream ID and retired summary before sending.
        this.save();
        if (checkpoint.messageId) this.closeSegment(retired, old);
        else {
          // An uncertain creation is not authority to retry/create an old card.
          const stopping = old.suspend().catch(() => undefined).finally(() => {
            this.oldStreams.delete(boundary.id); this.closing.delete(boundary.id);
          });
          this.closing.set(boundary.id, stopping);
        }
      } else this.save();
      if (this.suspended) return false;
      await this.current.progress(boundary.kind === "answer"
        ? "🤔 已接收问题回答，正在继续原任务…" : "🤔 已接收补充输入，正在继续原任务…");
      return true;
    });
  }

  /** A real native turn start (e.g. consumed queue item), not queue admission. */
  nextTurn(turnId: string): Promise<void> {
    return this.run(async () => {
      const id = `turn:${turnId}`;
      if (this.suspended || this.acceptedInputs.includes(id)) return;
      const old = this.current;
      const checkpoint = frame(old.checkpoint());
      this.acceptedInputs.splice(0, this.acceptedInputs.length, id);
      this.answerPrefix = undefined; this.lastAnswer = "";
      this.current = this.makeStream();
      if (!checkpoint.finished && !checkpoint.terminal && (checkpoint.messageId || checkpoint.creationAttempted || checkpoint.bootstrap)) {
        checkpoint.terminal = { text: stageSummary(checkpoint, "next-turn"), error: false };
        const retired = { inputId: id, checkpoint, attempts: 0 };
        this.previous.push(retired); this.oldStreams.set(id, old);
        this.save();
        if (checkpoint.messageId) this.closeSegment(retired, old);
        else {
          const stopping = old.suspend().catch(() => undefined).finally(() => {
            this.oldStreams.delete(id); this.closing.delete(id);
          });
          this.closing.set(id, stopping);
        }
      } else { this.save(); await old.suspend(); }
    });
  }

  private closeSegment(segment: Segment, stream?: ChannelTurnTextStream, force = false): void {
    if (this.suspended || segment.checkpoint.finished || this.closing.has(segment.inputId)
      || !segment.checkpoint.messageId || !stream && !this.client.resumableTextStream
      || !force && (segment.attempts >= 3 || Date.now() < (segment.retryAt ?? 0))) return;
    stream ??= this.makeStream(segment.checkpoint);
    const old = stream;
    this.oldStreams.set(segment.inputId, old);
    segment.attempts++;
    segment.retryAt = Date.now() + 60_000;
    this.save();
    const work = (async () => {
      try {
        await old.finalize(segment.checkpoint.terminal!.text, false, { existingOnly: true, recoverBootstrap: force });
      } catch { /* Keep only this summary pending; never fail the task/new card. */ }
      finally {
        await old.suspend().catch(() => undefined);
        this.oldStreams.delete(segment.inputId);
        if (segment.checkpoint.finished) {
          const index = this.previous.indexOf(segment);
          if (index >= 0) this.previous.splice(index, 1);
        }
        this.save();
      }
    })().finally(() => this.closing.delete(segment.inputId));
    this.closing.set(segment.inputId, work);
  }
  private retrySummaries(force = false): void {
    for (const segment of this.previous.filter(item => !item.checkpoint.finished).slice(0, 3)) this.closeSegment(segment, undefined, force);
  }
  progress(text: string): Promise<boolean> { return this.run(async () => {
    if (this.suspended) return true;
    this.retrySummaries(); return this.current.progress(text);
  }); }
  answer(text: string): Promise<boolean> { return this.run(async () => {
    if (this.suspended) return true;
    this.lastAnswer = text;
    const prefix = this.answerPrefix;
    const current = prefix && text.length >= prefix.length && digest(text.slice(0, prefix.length)) === prefix.digest
      ? text.slice(prefix.length) : text;
    return this.current.answer(current);
  }); }
  finalize(text: string, error = false, recovery: Parameters<ChannelTurnTextStream["finalize"]>[2] = {}): Promise<boolean> {
    return this.run(() => this.suspended ? Promise.resolve(false) : this.current.finalize(text, error, recovery));
  }
  fail(text: string): Promise<boolean> { return this.finalize(text, true); }
  waitForBackend(text: string): Promise<boolean> { return this.run(() => this.current.waitForBackend(text)); }
  reportTerminalFailure(): Promise<boolean> { return this.run(() => this.current.reportTerminalFailure()); }
  flush(): Promise<void> { return this.run(() => this.current.flush()); }
  synchronize(options: Parameters<ChannelTurnTextStream["synchronize"]>[0] = {}): ReturnType<ChannelTurnTextStream["synchronize"]> {
    return this.run(async () => { this.retrySummaries(true); return this.current.synchronize(options); });
  }
  async suspend(): Promise<void> {
    this.suspended = true;
    await this.tail.catch(() => undefined);
    await this.current.suspend();
    await Promise.allSettled(this.closing.values());
    await Promise.all([...this.oldStreams.values()].map(stream => stream.suspend()));
    this.closed = true;
  }
}

function frame(checkpoint: ChannelStreamCheckpoint): ChannelStreamCheckpoint {
  const { segments: _segments, ...value } = checkpoint; return value;
}
function digest(text: string): string { return crypto.createHash("sha256").update(text).digest("hex"); }
function stageSummary(checkpoint: ChannelStreamCheckpoint, kind: Boundary["kind"] | "next-turn"): string {
  const entries = checkpoint.progressEntries.slice(-5).map(text => `- ${bounded(text, 220)}`);
  if (!entries.length && checkpoint.thought.trim()) entries.push(`- ${bounded(checkpoint.thought, 220)}`);
  return ["**阶段小结**", entries.join("\n") || "本阶段暂无可核对的公开进展。",
    kind === "answer" ? "问题回答已获 Codex 接收确认，后续进展见下一张卡。"
      : kind === "steer" ? "补充输入已获 Codex 接收确认，后续进展见下一张卡。"
      : "Codex 已开始新的任务轮次，后续进展见下一张卡；上一轮完整结果可用 /history 查看。",
    kind === "next-turn" ? "_这是卡片阶段小结，不是对上一轮执行结果的成功判定。_"
      : "_这里只结束本张卡的展示阶段；卡片切换不会停止原任务，也不代表整个任务已完成。_"].join("\n\n");
}
function bounded(text: string, max: number): string { return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }

/** Carry only failed stage summaries across turns, never the old task result. */
export function nextTurnCheckpoint(saved?: ChannelStreamCheckpoint): ChannelStreamCheckpoint | undefined {
  const previous = saved?.segments?.previous.filter(item => !item.checkpoint.finished);
  return previous?.length ? { startedAt: Date.now(), progressEntries: [], thought: "正在等待新轮次进展…",
    answerPreview: "", finished: false, segments: { acceptedInputs: [], previous: structuredClone(previous) } } : undefined;
}
