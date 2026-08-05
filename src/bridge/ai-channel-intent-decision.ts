import { z } from "zod";

import type { ChannelCommand } from "./channel-intent.js";

export const MAX_AI_CHANNEL_ACTIONS = 4;

export const AI_CHANNEL_ACTION_NAMES = [
  "help",
  "status",
  "project_list",
  "project_switch",
  "mode_show",
  "mode_session",
  "mode_task",
  "mode_qa",
  "plan_on",
  "plan_off",
  "goal_show",
  "goal_set",
  "goal_pause",
  "goal_resume",
  "goal_complete",
  "goal_clear",
  "task_list",
  "task_new",
  "task_todo",
  "task_start",
  "task_detail",
  "task_block",
  "task_comment",
  "task_review",
  "task_accept",
  "task_return"
] as const;

const AiChannelActionSchema = z.object({
  intent: z.enum(AI_CHANNEL_ACTION_NAMES),
  confidence: z.number().min(0).max(1),
  target: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/).nullable(),
  detail: z.string().trim().min(1).max(2_000).nullable()
}).strict();

const AiChannelIntentDecisionSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.enum(["ordinary_chat", "actions"]),
  actions: z.array(AiChannelActionSchema).max(MAX_AI_CHANNEL_ACTIONS)
}).strict().superRefine((decision, context) => {
  if (decision.kind === "ordinary_chat" && decision.actions.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["actions"],
      message: "ordinary_chat must not contain actions"
    });
  }
  if (decision.kind === "actions" && decision.actions.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["actions"],
      message: "actions must contain at least one action"
    });
  }
});

export const AI_CHANNEL_INTENT_OUTPUT_SCHEMA = z.toJSONSchema(AiChannelIntentDecisionSchema);

type AiChannelAction = z.infer<typeof AiChannelActionSchema>;

export function commandsFromAiChannelIntentOutput(output: string): readonly ChannelCommand[] | undefined {
  const decision = parseAiChannelIntentDecision(output);
  if (!decision || decision.kind === "ordinary_chat") return undefined;
  if (decision.actions.some((action) => action.confidence < 0.8)) return undefined;
  return decision.actions.map(commandFromAction);
}

function parseAiChannelIntentDecision(output: string): z.infer<typeof AiChannelIntentDecisionSchema> | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const parsed = AiChannelIntentDecisionSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function commandFromAction(action: AiChannelAction): ChannelCommand {
  switch (action.intent) {
    case "help":
      return command("help");
    case "status":
      return command("status");
    case "project_list":
      return command("project", "list");
    case "project_switch":
      return action.target
        ? command("project", `switch ${action.target}`)
        : command("project", "list");
    case "mode_show":
      return command("mode");
    case "mode_session":
      return command("mode", "session");
    case "mode_task":
      return command("mode", "task");
    case "mode_qa":
      return command("mode", "qa");
    case "plan_on":
      return command("plan", "on");
    case "plan_off":
      return command("plan", "off");
    case "goal_show":
      return command("goal");
    case "goal_set":
      return action.detail || action.target
        ? command("goal", `set ${action.detail ?? action.target}`)
        : command("goal");
    case "goal_pause":
      return command("goal", "pause");
    case "goal_resume":
      return command("goal", "resume");
    case "goal_complete":
      return command("goal", "complete");
    case "goal_clear":
      return command("goal", "clear");
    case "task_list":
      return command("task", "list");
    case "task_new":
      return command("task", join("form new", action.detail));
    case "task_todo":
      return command("task", join("form todo", action.detail));
    case "task_start":
      return action.target
        ? command("task", `start ${action.target}`)
        : command("task", "list");
    case "task_detail":
      return action.target
        ? command("task", `detail ${action.target}`)
        : command("task", "list");
    case "task_block":
      return command("task", join(`form block ${action.target ?? "current"}`, action.detail));
    case "task_comment":
      return command("task", join(`form comment ${action.target ?? "current"}`, action.detail));
    case "task_review":
      return command("task", join(`form review ${action.target ?? "current"}`, action.detail));
    case "task_accept":
      return command("task", `detail ${action.target ?? "current"}`);
    case "task_return":
      return command("task", join(`form return ${action.target ?? "current"}`, action.detail));
    default:
      return assertNever(action.intent);
  }
}

function command(name: string, arg = ""): ChannelCommand {
  return { name, arg };
}

function join(prefix: string, detail: string | null): string {
  return detail ? `${prefix} ${detail}` : prefix;
}

function assertNever(value: never): never {
  throw new UnexpectedAiChannelActionError(value);
}

class UnexpectedAiChannelActionError extends Error {
  readonly name = "UnexpectedAiChannelActionError";

  constructor(readonly value: never) {
    super("AI channel action was not handled exhaustively");
  }
}
