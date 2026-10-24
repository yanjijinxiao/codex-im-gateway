import type { SessionBindingTarget } from "../state/runtime-state.js";

export type ExpiringBinding = {
  accountId: string;
  sessionId: string;
  expected: SessionBindingTarget & { generation: string };
  related: Array<{ sessionId: string; hostId: string; threadId: string | null }>;
};
type Options = {
  candidates: () => ExpiringBinding[];
  current: (binding: ExpiringBinding) => boolean;
  idle: (binding: ExpiringBinding) => Promise<boolean>;
  expire: (binding: ExpiringBinding) => Promise<void>;
  intervalMs?: number;
  probeTimeoutMs?: number;
};

/** A binding policy scheduler, not a native execution/retry queue. Every
 * deletion is conditional on current provenance plus a fresh read-only probe. */
export class BindingExpiryCoordinator {
  private timer?: NodeJS.Timeout;
  private ongoing?: Promise<void>;
  private stopped = false;
  private revision = 0;
  private offset = 0;
  constructor(private readonly options: Options) {}
  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => {
      console.warn("[codex-im-gateway] binding expiry check deferred; bindings preserved");
    }); }, this.options.intervalMs ?? 60_000);
    this.timer.unref();
  }
  stop(): void {
    this.stopped = true; this.revision++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ongoing) return this.ongoing;
    const run = this.check(); this.ongoing = run;
    void run.finally(() => { if (this.ongoing === run) this.ongoing = undefined; }).catch(() => {});
    return run;
  }
  private async check(): Promise<void> {
    const revision = this.revision, candidates = this.options.candidates();
    if (!candidates.length) return;
    // Rotate bounded probes, so one unresponsive host cannot starve later chats.
    const selected = Array.from({ length: Math.min(8, candidates.length) }, (_, i) => candidates[(this.offset + i) % candidates.length]);
    this.offset = (this.offset + selected.length) % candidates.length;
    for (const binding of selected) {
      if (this.stopped || revision !== this.revision) return;
      if (!this.options.current(binding)) continue;
      let timer: NodeJS.Timeout | undefined;
      try {
        const idle = await Promise.race([this.options.idle(binding), new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), this.options.probeTimeoutMs ?? 8_000); timer.unref();
        })]);
        if (idle && !this.stopped && revision === this.revision && this.options.current(binding)) await this.options.expire(binding);
      } catch { /* Unknown is not idle. Never retry a native write or alter bindings. */ }
      finally { if (timer) clearTimeout(timer); }
    }
  }
}
