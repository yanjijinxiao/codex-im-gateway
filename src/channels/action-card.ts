import { z } from "zod";

const channelActionValueSchema = z.object({
  version: z.literal(1),
  command: z.enum([
    "help",
    "status",
    "balance",
    "memory",
    "project",
    "task",
    "new",
    "sessions",
    "session",
    "model",
    "effort",
    "stream",
    "prompt",
    "approve",
    "reject",
    "stop"
  ]),
  arg: z.string().max(2_000)
});

export type ChannelActionValue = z.infer<typeof channelActionValueSchema>;
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

export function formatChannelActionCommand(value: ChannelActionValue): string {
  return `/${value.command}${value.arg ? ` ${value.arg}` : ""}`;
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
