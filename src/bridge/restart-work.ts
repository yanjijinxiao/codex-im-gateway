import { AsyncLocalStorage } from "node:async_hooks";
import type { CodexExecutionScope } from "../codex/backend.js";

/** Business work stays critical until an exact native receipt is durable. A
 * scope alone grants nothing: the live backend must still prove observation. */
export class RestartWork {
  private readonly current = new AsyncLocalStorage<{ scope?: CodexExecutionScope }>();
  private readonly work = new Set<{ scope?: CodexExecutionScope }>();
  async run<T>(action: () => Promise<T>): Promise<T> {
    const lease: { scope?: CodexExecutionScope } = {};
    this.work.add(lease);
    try { return await this.current.run(lease, action); }
    finally { this.work.delete(lease); }
  }
  accepted(scope: CodexExecutionScope): void {
    const lease = this.current.getStore();
    if (lease) lease.scope = { ...scope };
  }
  capture(): (scope: CodexExecutionScope) => void {
    const lease = this.current.getStore();
    return scope => { if (lease && this.work.has(lease)) lease.scope = { ...scope }; };
  }
  hasBlockingWork(independent?: (scope: CodexExecutionScope) => boolean): boolean {
    return [...this.work].some(lease => !lease.scope || !independent?.(lease.scope));
  }
}
