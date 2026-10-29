import type { CodexHistoryMessage, CodexHistoryPage, CodexHistoryPageInput, CodexThreadSnapshot } from "./backend.js";
import { CodexReadConnections } from "./read-connections.js";

/** Deliberately excludes task controls, subscriptions and approval answers. */
export type HistoryConnection = {
  readThreadSnapshot(threadId: string): Promise<CodexThreadSnapshot>;
  getHistory(threadId: string): Promise<CodexHistoryMessage[]>;
  getHistoryPage(threadId: string, input?: CodexHistoryPageInput): Promise<CodexHistoryPage>;
  close(): void;
};

export class CodexHistoryReader extends CodexReadConnections<HistoryConnection> {
  constructor(create: (hostId: string) => HistoryConnection) { super(create, "history"); }

  snapshot(threadId: string, hostId: string, timeoutMs: number): Promise<CodexThreadSnapshot> {
    return this.observe(hostId, "thread/snapshot", threadId, timeoutMs, async backend => {
      const snapshot = await backend.readThreadSnapshot(threadId);
      if (snapshot.state.threadId !== threadId) throw new Error("History response belongs to a different thread");
      return snapshot;
    });
  }

  history(threadId: string, hostId: string, timeoutMs: number): Promise<CodexHistoryMessage[]> {
    return this.observe(hostId, "thread/history", threadId, timeoutMs, backend => backend.getHistory(threadId));
  }

  page(threadId: string, input: CodexHistoryPageInput | undefined, hostId: string, timeoutMs: number): Promise<CodexHistoryPage> {
    return this.observe(hostId, "thread/turns/list", threadId, timeoutMs, backend => backend.getHistoryPage(threadId, input),
      JSON.stringify([input?.cursor, input?.limit, input?.sortDirection]));
  }
}
