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
  "approve",
  "reject",
  "answer"
]);

export function commandProjectRequirement(command: ChannelCommand): "optional" | "required" {
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
