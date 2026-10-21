import type { CodexThreadSnapshot } from "../codex/backend.js";

type Turn = CodexThreadSnapshot["turns"][number];
export type FollowHistoryBoundary = { version: 1; turnId?: string; startedAt?: string };

/** Absence from a bounded ID set is not evidence of a newly completed turn. */
export function afterFollowBoundary(turn: Turn, turns: readonly Turn[], boundary: FollowHistoryBoundary): boolean {
  if (turn.id === boundary.turnId) return false;
  const time = Date.parse(turn.startedAt ?? ""), boundaryTime = Date.parse(boundary.startedAt ?? "");
  if (Number.isFinite(time) && Number.isFinite(boundaryTime) && time !== boundaryTime) return time > boundaryTime;
  const anchor = turns.findIndex(item => item.id === boundary.turnId);
  // If neither a native timestamp nor the anchor is available, fail closed.
  // The exact tracked turn and explicit lifecycle receipts still recover normally.
  return anchor >= 0 && turns.findIndex(item => item.id === turn.id) > anchor;
}

export function followBoundary(turn?: Pick<Turn, "id" | "startedAt">): FollowHistoryBoundary {
  return { version: 1, ...(turn ? { turnId: turn.id, ...(Number.isFinite(Date.parse(turn.startedAt ?? "")) ? { startedAt: turn.startedAt } : {}) } : {}) };
}
