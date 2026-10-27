import type { CodexMetadataObservation, CodexThreadState, CodexProjectCatalog, CodexRuntimeInfo } from "./backend.js";
import { CodexCommunicationError, isCodexCommunicationFailure } from "./communication-error.js";

/** No execution, resume, queue or approval port is available to this reader. */
export type MetadataConnection = {
  inspectThread(threadId: string, observation: CodexMetadataObservation): Promise<CodexThreadState>;
  listProjects(): Promise<CodexProjectCatalog>;
  getRuntimeInfo?(cwd: string, threadId?: string): Promise<CodexRuntimeInfo>;
  close(): void;
};
type Connection = { backend: MetadataConnection; retired: boolean; cancellation: AbortController };

/** Fresh observations over independently replaceable connections. A failed
 * read can retire its own transport, never the native execution owner. */
export class CodexMetadataReader {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(private readonly create: (hostId: string) => MetadataConnection) {}

  inspect(threadId: string, hostId: string, observation: CodexMetadataObservation): Promise<CodexThreadState> {
    return this.observe(hostId, "thread/read", threadId, observation.timeoutMs, async backend => {
      const state = await backend.inspectThread(threadId, observation);
      if (state.threadId !== threadId) throw new Error("Metadata response belongs to a different thread");
      return state;
    });
  }
  projects(hostId: string, timeoutMs: number): Promise<CodexProjectCatalog> {
    return this.observe(hostId, "project/list", undefined, timeoutMs, backend => backend.listProjects());
  }
  runtime(cwd: string, threadId: string | undefined, hostId: string, timeoutMs: number): Promise<CodexRuntimeInfo> {
    return this.observe(hostId, "config/read", threadId, timeoutMs, backend => {
      if (!backend.getRuntimeInfo) throw new Error("Read-only runtime metadata is unavailable");
      return backend.getRuntimeInfo(cwd, threadId);
    }, cwd);
  }
  private observe<T>(hostId: string, operation: string, threadId: string | undefined, timeoutMs: number,
    read: (backend: MetadataConnection) => Promise<T>, discriminator?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Metadata reader closed"));
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
    read: (backend: MetadataConnection) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.closed) throw new Error("Metadata reader closed");
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
              new Error("Metadata connection closed")));
            connection.cancellation.signal.addEventListener("abort", cancel, { once: true });
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new CodexCommunicationError("preflight", operation, threadId, undefined,
              new Error("Metadata read timed out"))), Math.max(1, timeoutMs));
          })
        ]);
        if (this.closed || connection.retired) throw new CodexCommunicationError("preflight", operation, threadId, undefined,
          new Error("Metadata connection closed during observation"));
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
    throw new Error("Metadata observation unavailable");
  }

  private retire(hostId: string, connection: Connection): void {
    if (connection.retired) return;
    connection.retired = true;
    if (this.connections.get(hostId) === connection) this.connections.delete(hostId);
    connection.cancellation.abort();
    connection.backend.close();
  }
  private diagnostic(hostId: string, threadId: string | undefined, operation: string, status: "reconnecting" | "recovered" | "failed", code?: string) {
    console.info(`[codex-im-gateway] metadata observation ${JSON.stringify({ timestamp: new Date().toISOString(), hostId, threadId,
      operation, status, ...(code ? { code } : {}) })}`);
  }
}
