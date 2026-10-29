import { CodexCommunicationError, isCodexCommunicationFailure } from "./communication-error.js";

type Connection<B> = { backend: B; retired: boolean; cancellation: AbortController };

/** Fresh observations over independently replaceable connections. A failed
 * read can retire its own transport, never the native execution owner. */
export class CodexReadConnections<B extends { close(): void }> {
  private readonly connections = new Map<string, Connection<B>>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(private readonly create: (hostId: string) => B, private readonly label: string) {}

  protected observe<T>(hostId: string, operation: string, threadId: string | undefined, timeoutMs: number,
    read: (backend: B) => Promise<T>, discriminator?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${this.label} reader closed`));
    const key = JSON.stringify([hostId, operation, threadId, timeoutMs, discriminator]);
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const work = this.read(hostId, operation, threadId, timeoutMs, read).finally(() => {
      if (this.pending.get(key) === work) this.pending.delete(key);
    });
    this.pending.set(key, work);
    return work;
  }

  close(): void {
    this.closed = true;
    for (const [hostId, connection] of this.connections) this.retire(hostId, connection);
  }

  private async read<T>(hostId: string, operation: string, threadId: string | undefined, timeoutMs: number,
    read: (backend: B) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.closed) throw new Error(`${this.label} reader closed`);
      let connection = this.connections.get(hostId);
      if (!connection) {
        connection = { backend: this.create(hostId), retired: false, cancellation: new AbortController() };
        this.connections.set(hostId, connection);
      }
      let timer: NodeJS.Timeout | undefined;
      let cancel: (() => void) | undefined;
      try {
        // Includes initialization/SSH handshake, not just the JSON-RPC wait.
        const state = await Promise.race([
          Promise.resolve().then(() => read(connection.backend)),
          new Promise<never>((_resolve, reject) => {
            cancel = () => reject(new CodexCommunicationError("preflight", operation, threadId, undefined,
              new Error(`${this.label} connection closed`)));
            connection.cancellation.signal.addEventListener("abort", cancel, { once: true });
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new CodexCommunicationError("preflight", operation, threadId, undefined,
              new Error(`${this.label} read timed out`))), Math.max(1, timeoutMs));
          })
        ]);
        if (this.closed || connection.retired) throw new CodexCommunicationError("preflight", operation, threadId, undefined,
          new Error(`${this.label} connection closed during observation`));
        if (attempt) this.diagnostic(hostId, threadId, operation, "recovered");
        return state;
      } catch (error) {
        if (!isCodexCommunicationFailure(error)) throw error;
        this.retire(hostId, connection);
        if (this.closed) throw error;
        this.diagnostic(hostId, threadId, operation, attempt ? "failed" : "reconnecting",
          error instanceof CodexCommunicationError ? error.code : /timeout|timed out/i.test(String(error)) ? "timeout" : "disconnected");
        if (attempt) throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (cancel) connection.cancellation.signal.removeEventListener("abort", cancel);
      }
    }
    throw new Error(`${this.label} observation unavailable`);
  }

  private retire(hostId: string, connection: Connection<B>): void {
    if (connection.retired) return;
    connection.retired = true;
    if (this.connections.get(hostId) === connection) this.connections.delete(hostId);
    connection.cancellation.abort();
    connection.backend.close();
  }
  private diagnostic(hostId: string, threadId: string | undefined, operation: string, status: "reconnecting" | "recovered" | "failed", code?: string) {
    console.info(`[codex-im-gateway] ${this.label} observation ${JSON.stringify({ timestamp: new Date().toISOString(), hostId, threadId,
      operation, status, ...(code ? { code } : {}) })}`);
  }
}
