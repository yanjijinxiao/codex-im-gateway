/** Bounded, per-turn text fallback shared by managed execution and session following. */
export class TextProgressBatcher {
  private pending: string[] = [];
  private readonly seen = new Set<string>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private lastSentAt = -Infinity;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly send: (text: string) => Promise<void>, private readonly intervalMs = 5_000) {}

  async push(text: string): Promise<boolean> {
    if (this.closed || this.seen.has(text)) return true;
    const clean = text.trim().slice(0, 450);
    if (!clean) return true;
    this.seen.add(text);
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value!);
    this.pending.push(clean);
    this.pending = this.pending.slice(-3);
    const delay = this.intervalMs - (Date.now() - this.lastSentAt);
    if (delay <= 0) { await this.flush(); return true; }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => console.warn("[codex-im-gateway] text progress delivery failed"));
      }, delay);
      this.timer.unref();
    }
    return true;
  }

  private async flush(): Promise<void> {
    this.chain = this.chain.catch(() => undefined).then(async () => {
      if (this.closed || !this.pending.length) return;
      const entries = this.pending;
      this.pending = [];
      this.lastSentAt = Date.now();
      await this.send(`【进展】\n\n${entries.map((text) => `• ${text}`).join("\n\n")}`);
    });
    await this.chain;
  }

  /** Final answer supersedes pending progress. In-flight delivery finishes before the final. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    await this.chain.catch(() => undefined);
  }
}
