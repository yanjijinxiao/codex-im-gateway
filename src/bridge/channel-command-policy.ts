import type { ProjectInteractionMode } from "../channels/channel-mode-settings.js";
import type { ChannelCommand } from "./channel-intent.js";

const PROJECT_OPTIONAL_COMMANDS = new Set<string>([
  "help",
  "h",
  "balance",
  "memory",
  "knowledge",
  "project",
  "projects",
  "new", "n",
  "approve",
  "reject",
  "answer",
  "role", "session", "sessions", "s", "ss", "history", "hist",
  "follow", "leave", "policy", "steer", "iv", "intervene", "queue", "stop", "status", "where"
]);

export function commandProjectRequirement(command: ChannelCommand): "optional" | "required" | "session-or-project" {
  if (["goal", "plan", "model", "effort", "stream", "prompt"].includes(command.name)) return "session-or-project";
  return PROJECT_OPTIONAL_COMMANDS.has(command.name) ? "optional" : "required";
}

export function requiredModeForCommand(command: ChannelCommand): ProjectInteractionMode | undefined {
  switch (command.name) {
    case "task":
    case "tb":
      return "task";
    case "qa":
    case "q":
      return "qa";
    case "new":
    case "n":
    case "session":
    case "sessions":
    case "s":
    case "ss":
    case "history":
    case "hist":
    case "steer":
    case "iv":
    case "queue":
    case "follow":
    case "leave":
    case "policy":
    case "intervene":
      return "session";
    case "mode":
    case "view":
      switch (command.arg.trim().toLowerCase()) {
        case "session":
          return "session";
        case "task":
          return "task";
        case "qa":
          return "qa";
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

export function friendlyCommandsContinueConversation(commands: readonly ChannelCommand[]): boolean {
  return commands.some((command) => (
    isPlanStartCommand(command) || isGoalSetCommand(command)
  ));
}

export function isGoalSetCommand(command: ChannelCommand): boolean {
  return command.name === "goal" && /^set\s+\S/is.test(command.arg.trim());
}

function isPlanStartCommand(command: ChannelCommand): boolean {
  if (command.name !== "plan") return false;
  const arg = command.arg.trim().toLowerCase();
  return arg === "on" || arg === "plan";
}
