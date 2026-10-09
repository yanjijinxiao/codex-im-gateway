/** Bounded, per-turn text fallback shared by managed execution and session following. */
export class TextProgressBatcher {
  private pending: string[] = [];
  private readonly seen = new Set<string>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private lastSentAt = -Infinity;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly send: (text: string) => Promise<void>, private readonly intervalMs = 30_000) {}

  async push(text: string, deferFirst = false): Promise<boolean> {
    if (this.closed || this.seen.has(text)) return true;
    const clean = text.trim().slice(0, 450);
    if (!clean) return true;
    this.seen.add(text);
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value!);
    this.pending.push(clean);
    this.pending = this.pending.slice(-3);
    const delay = deferFirst && this.lastSentAt === -Infinity
      ? this.intervalMs : this.intervalMs - (Date.now() - this.lastSentAt);
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

  /** A recovered card supersedes text accumulated while it was unavailable. */
  clearPending(): void {
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
