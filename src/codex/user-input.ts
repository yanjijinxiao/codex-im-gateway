import type { CodexUserInputQuestion, CodexUserInputRequest } from "./backend.js";

/** Shared by app-server requests and Desktop pending-request snapshots. */
export function parseUserInputRequest(params: Record<string, unknown>): CodexUserInputRequest | undefined {
  if (typeof params.itemId !== "string" || !params.itemId || typeof params.threadId !== "string" || !params.threadId
    || typeof params.turnId !== "string" || !params.turnId || !Array.isArray(params.questions)
    || !params.questions.length || params.questions.length > 3) return undefined;
  const questions: CodexUserInputQuestion[] = [];
  for (const raw of params.questions) {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    if (typeof item.header !== "string" || item.header.length > 100 || typeof item.id !== "string" || !item.id || item.id.length > 4_000
      || typeof item.question !== "string" || !item.question.trim() || item.question.length > 12_000 || questions.some(q => q.id === item.id)) return undefined;
    if (item.options !== undefined && item.options !== null && !Array.isArray(item.options)) return undefined;
    const options: NonNullable<CodexUserInputQuestion["options"]> = [];
    if (Array.isArray(item.options) && item.options.length > 32) return undefined;
    for (const rawOption of (item.options ?? []) as unknown[]) {
      if (!rawOption || typeof rawOption !== "object") return undefined;
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label !== "string" || !option.label.trim() || option.label.length > 2_000
        || typeof option.description !== "string" || option.description.length > 12_000) return undefined;
      options.push({ label: option.label, description: option.description });
    }
    questions.push({ header: item.header, id: item.id, question: item.question,
      ...(options.length ? { options } : {}), ...(item.isSecret === true ? { isSecret: true } : {}),
      ...(item.isOther === true ? { isOther: true } : {}) });
  }
  if (params.autoResolutionMs !== undefined && params.autoResolutionMs !== null
    && (typeof params.autoResolutionMs !== "number" || !Number.isFinite(params.autoResolutionMs) || params.autoResolutionMs < 0)) return undefined;
  return { itemId: params.itemId, threadId: params.threadId, turnId: params.turnId, questions,
    ...(params.autoResolutionMs !== undefined ? { autoResolutionMs: params.autoResolutionMs as number | null } : {}) };
}
