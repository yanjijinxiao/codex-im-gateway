/** Cleanup is best-effort for every owned resource. A failure never skips the
 * remaining resources; the ownership release runs only after all attempts. */
export async function cleanupResources(actions: readonly (() => void | Promise<void>)[], message: string,
  release?: () => void | Promise<void>): Promise<void> {
  const results = await Promise.allSettled(actions.map(async action => action()));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (release) { try { await release(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, message);
}
