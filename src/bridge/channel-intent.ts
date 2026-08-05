export type ChannelCommand = {
  readonly name: string;
  readonly arg: string;
};

export type ChannelCommandSequence = readonly [ChannelCommand, ChannelCommand, ...ChannelCommand[]];

export type FriendlyChannelIntent =
  | { readonly kind: "command"; readonly command: ChannelCommand }
  | { readonly kind: "command_sequence"; readonly commands: ChannelCommandSequence }
  | { readonly kind: "clarification"; readonly text: string };

export function commandsFromFriendlyChannelIntent(
  intent: FriendlyChannelIntent | undefined
): readonly ChannelCommand[] | undefined {
  if (!intent) return undefined;
  switch (intent.kind) {
    case "command":
      return [intent.command];
    case "command_sequence":
      return intent.commands;
    case "clarification":
      return undefined;
    default:
      return assertNever(intent);
  }
}

function assertNever(value: never): never {
  throw new UnexpectedFriendlyChannelIntentError(value);
}

class UnexpectedFriendlyChannelIntentError extends Error {
  readonly name = "UnexpectedFriendlyChannelIntentError";

  constructor(readonly value: never) {
    super("Friendly channel intent was not handled exhaustively");
  }
}
