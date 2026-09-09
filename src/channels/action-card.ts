import { z } from "zod";

const channelCommandActionValueSchema = z.object({
  version: z.literal(1),
  command: z.enum([
    "help",
    "status",
    "balance",
    "memory",
    "project",
    "task",
    "mode",
    "qa",
    "plan",
    "goal",
    "answer",
    "new",
    "sessions",
    "session",
    "history",
    "steer",
    "queue",
    "follow",
    "leave",
    "policy",
    "role",
    "intervene",
    "model",
    "effort",
    "stream",
    "prompt",
    "approve",
    "reject",
    "stop"
  ]),
  arg: z.string().max(2_000)
}).strict();

const channelFormFieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  parameter: z.enum(["title", "description", "priority", "labels", "body"]),
  required: z.boolean(),
  maximumLength: z.number().int().min(1).max(2_000)
}).strict();

const channelFormActionValueSchema = z.object({
  version: z.literal(2),
  command: z.literal("task"),
  arg: z.literal("submit"),
  parameters: z.object({
    operation: z.enum([
      "create_todo", "create_start", "comment", "block", "review", "return", "start", "accept"
    ]),
    identifier: z.string().trim().min(1).max(100).regex(/^[^\r\n]+$/).optional(),
    version: z.string().regex(/^\d{1,10}$/).optional(),
    request_id: z.string().uuid()
  }).strict(),
  fields: z.array(channelFormFieldSchema).max(10)
}).strict();

const channelGoalFormActionValueSchema = z.object({
  version: z.literal(3),
  command: z.literal("goal"),
  arg: z.literal("set"),
  field: z.object({
    name: z.literal("objective"),
    required: z.literal(true),
    maximumLength: z.number().int().min(1).max(2_000)
  }).strict()
}).strict();

const channelActionValueSchema = z.discriminatedUnion("version", [
  channelCommandActionValueSchema,
  channelFormActionValueSchema,
  channelGoalFormActionValueSchema
]);

export type ChannelActionValue = z.infer<typeof channelActionValueSchema>;
export type ChannelFormParameter = z.infer<typeof channelFormFieldSchema>["parameter"];
export type ChannelActionCommand = ChannelActionValue["command"];
export type ChannelCardTemplate = "blue" | "green" | "orange" | "red" | "grey";

export type ChannelCardAction = {
  readonly label: string;
  readonly style: "default" | "primary" | "danger";
  readonly value: ChannelActionValue;
  readonly confirm?: string;
};

export type ChannelActionCard = {
  readonly title: string;
  readonly template: ChannelCardTemplate;
  readonly body: string;
  readonly note?: string;
  readonly actionGroups: readonly (readonly ChannelCardAction[])[];
  readonly fallbackText: string;
};

export type ChannelChoice = {
  readonly label: string;
  readonly command: ChannelActionCommand;
  readonly arg: string;
  readonly style?: ChannelCardAction["style"];
  readonly confirm?: string;
};

type CreateChoiceCardInput = {
  readonly title: string;
  readonly body: string;
  readonly choices: readonly ChannelChoice[];
  readonly fallbackText: string;
  readonly note?: string;
  readonly template?: ChannelCardTemplate;
};

export function createChoiceCard(input: CreateChoiceCardInput): ChannelActionCard {
  const actions = input.choices.map((choice): ChannelCardAction => ({
    label: choice.label,
    style: choice.style ?? "default",
    value: { version: 1, command: choice.command, arg: choice.arg },
    ...(choice.confirm ? { confirm: choice.confirm } : {})
  }));
  return {
    title: input.title,
    template: input.template ?? "blue",
    body: input.body,
    ...(input.note ? { note: input.note } : {}),
    actionGroups: groupActions(actions),
    fallbackText: input.fallbackText
  };
}

export function parseChannelActionValue(value: unknown): ChannelActionValue | undefined {
  const parsed = channelActionValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function formatChannelActionCommand(value: ChannelActionValue, formValue?: unknown): string | undefined {
  switch (value.version) {
    case 1:
      return `/${value.command}${value.arg ? ` ${value.arg}` : ""}`;
    case 2: {
      const parsedForm = z.record(z.string(), z.unknown()).safeParse(formValue ?? {});
      if (!parsedForm.success) return undefined;
      const parameters = new URLSearchParams(value.parameters);
      for (const field of value.fields) {
        const raw = parsedForm.data[field.name];
        if (raw === undefined || raw === null || raw === "") {
          if (field.required) return undefined;
          continue;
        }
        if (typeof raw !== "string") return undefined;
        const normalized = raw.trim();
        if (!normalized) {
          if (field.required) return undefined;
          continue;
        }
        if (normalized.length > field.maximumLength) return undefined;
        parameters.set(field.parameter, normalized);
      }
      return `/${value.command} ${value.arg} ${parameters}`;
    }
    case 3: {
      const parsedForm = z.record(z.string(), z.unknown()).safeParse(formValue ?? {});
      if (!parsedForm.success) return undefined;
      const raw = parsedForm.data[value.field.name];
      if (typeof raw !== "string") return undefined;
      const objective = raw.trim();
      if (!objective || objective.length > value.field.maximumLength) return undefined;
      return `/goal ${objective}`;
    }
    default:
      return assertNever(value);
  }
}

function groupActions(actions: readonly ChannelCardAction[]): readonly (readonly ChannelCardAction[])[] {
  const groups: ChannelCardAction[][] = [];
  for (const action of actions) {
    let current = groups.at(-1);
    if (!current || current.length === 3) {
      current = [];
      groups.push(current);
    }
    current.push(action);
  }
  return groups;
}

function assertNever(value: never): never {
  throw new UnexpectedChannelActionValueError(value);
}

class UnexpectedChannelActionValueError extends Error {
  readonly name = "UnexpectedChannelActionValueError";

  constructor(readonly value: never) {
    super("Channel action value was not handled exhaustively");
  }
}
