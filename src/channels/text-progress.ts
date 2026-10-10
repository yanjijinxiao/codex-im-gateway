import { summarizeProgress } from "./progress-summary.js";

/** Native progress for text-only channels; never a fallback from an AI Card. */
export class TextProgressBatcher {
  private pending: string[] = [];
  private readonly seen = new Set<string>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private lastSentAt = -Infinity;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly send: (text: string) => Promise<void>, private readonly intervalMs = 30_000) {}

  async push(text: string): Promise<boolean> {
    if (this.closed) return true;
    const clean = summarizeProgress(text, 180);
    if (!clean || this.seen.has(clean)) return true;
    this.seen.add(clean);
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value!);
    this.pending.push(clean);
    this.pending = this.pending.slice(-3);
    const delay = this.intervalMs - (Date.now() - this.lastSentAt);
    if (delay <= 0) { await this.flush(); return true; }
    this.schedule(delay);
    return true;
  }

  private async flush(): Promise<void> {
    this.chain = this.chain.catch(() => undefined).then(async () => {
      if (this.closed || !this.pending.length) return;
      // Concurrent push calls may have queued more than one flush. Enforce the
      // window here as well, after the preceding delivery has finished.
      const delay = this.intervalMs - (Date.now() - this.lastSentAt);
      if (delay > 0) { this.schedule(delay); return; }
      const entries = this.pending;
      this.pending = [];
      this.lastSentAt = Date.now();
      await this.send(`【进展】\n\n${entries.map((text) => `• ${text}`).join("\n\n")}`);
    });
    await this.chain;
  }

  private schedule(delay: number): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => console.warn("[codex-im-gateway] text progress delivery failed"));
    }, delay);
    this.timer.unref();
  }

  private clearPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }

  /** Final answer supersedes pending progress. In-flight delivery finishes before the final. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearPending();
    await this.chain.catch(() => undefined);
  }
}
