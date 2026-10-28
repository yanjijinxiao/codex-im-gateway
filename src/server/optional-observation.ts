/** Optional read-only discovery cannot hold core management requests open.
 * A timed-out probe remains coalesced until its real transport settles; its
 * timeout never authorizes another native operation or a retry of a mutation. */
export class OptionalObservation {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly timeoutMs = 2_000) {}
  async read<T>(key: string, probe: () => Promise<T>, fallback: T): Promise<T> {
    let work = this.pending.get(key) as Promise<T> | undefined;
    if (!work) {
      if (this.pending.size >= 16) return fallback;
      work = Promise.resolve().then(probe);
      this.pending.set(key, work);
      const owned = work;
      void work.finally(() => { if (this.pending.get(key) === owned) this.pending.delete(key); }).catch(() => {});
    }
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([work, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), this.timeoutMs); })]); }
    catch { return fallback; }
    finally { if (timer) clearTimeout(timer); }
  }
}
