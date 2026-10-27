import { RuntimeStateStore, type ManagedSession } from "../state/runtime-state.js";

/** A source binding lease, independent of native acceptance and delivery.
 * Only our acknowledged new-thread callback may advance its expected thread.
 * Cosmetic settings are deliberately excluded; authority and topology are not. */
export function sessionExecutionScope(store: RuntimeStateStore, session: ManagedSession, conversationId = session.senderId) {
  const topology = (current: ManagedSession) => {
    const project = current.projectId ? store.getProject(current.projectId) : undefined;
    return JSON.stringify([current.id, current.senderId, current.workspace, current.projectId, current.projectBinding,
      current.hostId ?? project?.hostId ?? "local", [...project?.rootPaths ?? []].sort(),
      current.executionGeneration]);
  };
  let expected = topology(session);
  let threadId = session.threadId;
  const current = () => {
    store.refresh();
    const latest = store.getSession(session.id);
    return Boolean(latest && store.getBoundSession(conversationId)?.id === session.id
      && latest.threadId === threadId && topology(latest) === expected);
  };
  return { current, acceptThread(id: string): boolean {
    if (!current()) return false;
    const updated = store.setSessionThread(session.id, id); threadId = id; session.threadId = id;
    session.executionGeneration = updated.executionGeneration; expected = topology(updated);
    return true;
  } };
}
