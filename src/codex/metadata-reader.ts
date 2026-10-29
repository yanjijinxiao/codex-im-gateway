import type { CodexMetadataObservation, CodexThreadState, CodexProjectCatalog, CodexRuntimeInfo } from "./backend.js";
import { CodexReadConnections } from "./read-connections.js";

/** No execution, resume, queue or approval port is available to this reader. */
export type MetadataConnection = {
  inspectThread(threadId: string, observation: CodexMetadataObservation): Promise<CodexThreadState>;
  listProjects(): Promise<CodexProjectCatalog>;
  getRuntimeInfo?(cwd: string, threadId?: string): Promise<CodexRuntimeInfo>;
  close(): void;
};

/** Metadata never shares a transport with bulk history or execution. */
export class CodexMetadataReader extends CodexReadConnections<MetadataConnection> {
  constructor(create: (hostId: string) => MetadataConnection) { super(create, "metadata"); }

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
}
