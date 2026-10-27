import fs from "node:fs/promises";
import { constants } from "node:fs";
import { rolloutIdentity } from "./rollout-identity.js";
import { codexFailureCode } from "./turn-failure.js";
import type { CodexTurnObservation, CodexThreadSnapshot } from "./backend.js";

const unknown = (): CodexTurnObservation => ({ status: "unknown", source: "unknown" });
const HEADER_BYTES = 128 * 1024, TAIL_BYTES = 8 * 1024 * 1024;

export function observeOwnerTurn(snapshot: CodexThreadSnapshot, threadId: string, turnId: string): CodexTurnObservation {
  if (snapshot.state.threadId !== threadId) throw new Error("Native turn observation identity mismatch");
  if (snapshot.state.persistence !== "active" || !["active", "idle"].includes(snapshot.state.runtimeStatus)) return unknown();
  if (snapshot.state.runtimeStatus === "active" && snapshot.state.activeTurnId === turnId) return { status: "inProgress", source: "owner" };
  if (snapshot.state.runtimeStatus === "active" && !snapshot.state.activeTurnId) return unknown();
  const turn = snapshot.turns.find(turn => turn.id === turnId);
  if (turn?.status === "inProgress") return unknown(); // Active identity must agree with the runtime owner.
  return turn ? { status: turn.status, source: "owner",
    text: turn.messages.filter(message => message.role === "assistant" && message.kind !== "progress").map(message => message.text).join("\n\n"),
    ...(snapshot.state.lastTurnFailure?.turnId === turnId ? { failureCode: snapshot.state.lastTurnFailure.code } : {}) } : unknown();
}

/** Only explicit lifecycle events in the exact native rollout certify a
 * stopped unloaded turn. Never infer completion from an RPC reconstruction. */
export async function readNativeTurnLifecycle(filePath: string, threadId: string, turnId: string): Promise<CodexTurnObservation> {
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return unknown();
    const header = Buffer.alloc(Math.min(stat.size, HEADER_BYTES));
    await file.read(header, 0, header.length, 0);
    let identity: ReturnType<typeof rolloutIdentity> | undefined;
    for (const line of header.toString("utf8").split("\n")) {
      try { const record = JSON.parse(line); if (record.type === "session_meta") { identity = rolloutIdentity(record.payload ?? {}); break; } }
      catch { /* Partial trailing record is not evidence. */ }
    }
    if (identity?.threadId !== threadId || identity.internal) return unknown();
    const start = Math.max(0, stat.size - TAIL_BYTES), tail = Buffer.alloc(stat.size - start);
    await file.read(tail, 0, tail.length, start);
    const text = tail.toString("utf8"), lines = (start ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
    let result = unknown();
    // A record must have a terminating newline: a torn append never proves a stop.
    for (const line of lines.slice(0, -1)) {
      try {
        const record = JSON.parse(line), event = record.payload;
        if (record.type !== "event_msg" || event?.turn_id !== turnId) continue;
        if (event.type === "task_started") result = unknown();
        if (event.type === "turn_aborted") result = { status: "interrupted", source: "native-event" };
        if (event.type === "task_complete") result = { status: event.error ? "failed" : "completed", source: "native-event",
          ...(typeof event.last_agent_message === "string" ? { text: event.last_agent_message } : {}),
          ...(event.error ? { failureCode: codexFailureCode(event.error) } : {}) };
      } catch { /* Malformed/partial records cannot authorize a terminal result. */ }
    }
    return result;
  } finally { await file.close(); }
}
