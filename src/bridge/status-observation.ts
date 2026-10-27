/** Diagnostic reads have a short, independent budget. They must never gate on
 * execution ownership or authorize a write using a fallback/expired snapshot. */
export const STATUS_READ_BUDGET_MS = 1_000;
// SSH initialization may exceed the reply budget. Let a read-only connection
// finish warming up, bounded independently, so the next query can read fresh
// state instead of perpetually cancelling every cold connection too early.
export const STATUS_RPC_BUDGET_MS = 3_000;
export type StatusObservation<T> = { available: true; value: T } | { available: false };
export async function observeStatus<T>(read: () => Promise<T>, timeoutMs = STATUS_READ_BUDGET_MS): Promise<StatusObservation<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).then(value => ({ available: true as const, value }), () => ({ available: false as const })),
      new Promise<{ available: false }>(resolve => { timer = setTimeout(() => resolve({ available: false }), timeoutMs); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
