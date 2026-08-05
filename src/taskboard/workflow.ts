import type { TaskboardStatus } from "./client.js";

export function isTaskboardTransitionAllowed(from: TaskboardStatus, to: TaskboardStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function taskboardTransitionRequiresComment(status: TaskboardStatus): boolean {
  return status === "blocked" || status === "in_review";
}

const ALLOWED_TRANSITIONS: Readonly<Record<TaskboardStatus, readonly TaskboardStatus[]>> = {
  backlog: [],
  todo: ["in_progress"],
  in_progress: ["blocked", "in_review"],
  in_review: ["in_progress", "done"],
  blocked: ["in_progress"],
  done: [],
  canceled: []
};
