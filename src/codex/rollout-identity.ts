/** Rollout `id` identifies this thread; `session_id` may identify its parent. */
export type RolloutMetadata = {
  readonly id?: unknown;
  readonly session_id?: unknown;
  readonly source?: unknown;
  readonly thread_source?: unknown;
};

export function rolloutIdentity(meta: RolloutMetadata): { threadId?: string; internal: boolean } {
  const threadId = nonempty(meta.id) ?? nonempty(meta.session_id);
  const source = meta.source;
  const internal = internalSource(meta.thread_source) || internalSource(source)
    || (typeof source === "object" && source !== null
      && Object.keys(source).some(internalSource));
  return { ...(threadId ? { threadId } : {}), internal };
}

function internalSource(value: unknown): boolean {
  return typeof value === "string" && /^(sub_?agent|guardian)(?:$|[_:/-])/i.test(value);
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
