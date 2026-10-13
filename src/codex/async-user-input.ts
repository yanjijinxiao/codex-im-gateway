import type { CodexUserInputAnswer, CodexUserInputRequest } from "./backend.js";

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";

/** Desktop represents request_user_input_async questions on agentMessage items. */
export function desktopAsyncUserInputs(threadId: string, state: Record<string, unknown>): CodexUserInputRequest[] {
  if (object(state.threadRuntimeStatus)?.type !== "active") return [];
  const history = object(object(state.turnHistory)?.history);
  const entities = object(history?.entitiesByKey);
  const rawTurns = entities ? Object.values(entities) : Array.isArray(state.turns) ? state.turns : [];
  const active = rawTurns.map(object).filter(turn => turn?.status === "inProgress" && typeof turn.turnId === "string")
    .sort((a, b) => Number(a?.turnStartedAtMs ?? 0) - Number(b?.turnStartedAtMs ?? 0)).at(-1);
  if (!active || !Array.isArray(active.items)) return [];
  const answered = new Set<string>();
  for (const rawItem of active.items) {
    const item = object(rawItem);
    if (!item || !["userMessage", "steeringUserMessage"].includes(String(item.type))) continue;
    if (item.type === "steeringUserMessage" && item.status !== "accepted") continue;
    const input = item.type === "userMessage" ? item.content : item.input;
    if (!Array.isArray(input) || input.length !== 1) continue;
    const text = object(input[0]);
    if (text?.type !== "text" || typeof text.text !== "string") continue;
    for (const id of answeredQuestionIds(text.text)) answered.add(id);
  }
  const requests: CodexUserInputRequest[] = [];
  for (const rawItem of active.items) {
    const item = object(rawItem);
    if (item?.type !== "agentMessage" || typeof item.id !== "string" || !Array.isArray(item.questions) || item.questions.length > 3) continue;
    const questions = item.questions.flatMap((value, index) => {
      const question = object(value);
      const id = JSON.stringify(["request_user_input_async", item.id, index]);
      if (answered.has(id) || typeof question?.title !== "string" || !question.title.trim() || question.title.length > 12_000) return [];
      if (question.options !== undefined && (!Array.isArray(question.options) || question.options.length > 32
        || question.options.some(label => typeof label !== "string" || !label.trim() || label.length > 2_000))) return [];
      const options = (question.options ?? []) as string[];
      return [{ header: "问题", id, question: question.title,
        ...(options.length ? { options: options.map(label => ({ label, description: "" })) } : {}),
        ...(question.isSecret === true ? { isSecret: true } : {}) }];
    });
    // Each asynchronous widget is independently answerable in Desktop. A
    // sibling answered in the App must not invalidate/recreate another widget.
    if (questions.length <= 3) for (const question of questions) requests.push({ kind: "async", hostId: "local",
      itemId: item.id, requestId: `async:${question.id}`, threadId, turnId: active.turnId as string,
      questions: [question], autoResolutionMs: null });
  }
  return requests;
}

/** Native reply envelope: never pass a bare answer to regular message routing. */
export function asyncUserInputReply(request: CodexUserInputRequest, answers: CodexUserInputAnswer): string {
  if (request.kind !== "async") throw new Error("Expected an asynchronous question request");
  const allowed = new Set(request.questions.map(question => question.id));
  if (Object.keys(answers).some(id => !allowed.has(id))) throw new Error("Answer belongs to another question");
  return `${OPEN}\n${JSON.stringify(request.questions.map(question => ({
    questionItemId: question.id, question: question.question, answer: answers[question.id]?.answers[0] ?? ""
  })))}\n${CLOSE}`;
}

function answeredQuestionIds(text: string): string[] {
  const value = text.trim();
  if (!value.startsWith(OPEN) || !value.endsWith(CLOSE)) return [];
  try {
    const parsed = JSON.parse(value.slice(OPEN.length, -CLOSE.length));
    const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap(row => {
      const item = object(row);
      return typeof item?.questionItemId === "string" && typeof item.question === "string" && typeof item.answer === "string"
        ? [item.questionItemId] : [];
    });
  } catch { return []; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
