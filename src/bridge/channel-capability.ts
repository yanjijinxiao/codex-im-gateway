import type { ChannelCommand } from "./channel-intent.js";

export type ChannelCapabilityResolution =
  | {
      readonly kind: "reply";
      readonly text: string;
    }
  | {
      readonly kind: "run_skill";
      readonly capabilityId: string;
      readonly skillName: string;
      readonly operation: string;
      readonly instruction: string;
    };

export type ChannelCommandCapability = {
  readonly id: string;
  readonly commandName: string;
  readonly aliases: Readonly<Record<string, string>>;
  readonly helpLine: string;
  readonly aiActions: readonly ChannelCapabilityAiAction[];
  readonly navigation?: ChannelCapabilityNavigation;
  readonly resolve: (arg: string) => ChannelCapabilityResolution;
};

export type ChannelCapabilityNavigation = {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly url: string;
  readonly order: number;
  readonly icon: "document" | "database" | "generic";
  readonly allowClipboard: boolean;
};

export type ChannelCapabilityAiAction = {
  readonly intent: string;
  readonly operation: string;
  readonly guidance: string;
  readonly argument: "none" | "target" | "detail";
};

export type ChannelCapabilityProvider = () =>
  | readonly ChannelCommandCapability[]
  | Promise<readonly ChannelCommandCapability[]>;

export function channelCapabilityAliases(
  capabilities: readonly ChannelCommandCapability[]
): Readonly<Record<string, string>> {
  const aliases: Record<string, string> = {};
  for (const capability of capabilities) {
    for (const [alias, commandName] of Object.entries(capability.aliases)) {
      if (!(alias in aliases)) aliases[alias] = commandName;
    }
  }
  return aliases;
}

export function channelCapabilityIds(
  capabilities: readonly ChannelCommandCapability[]
): readonly string[] {
  return capabilities.map((capability) => capability.id);
}

export function channelCapabilityHelpLines(
  capabilities: readonly ChannelCommandCapability[]
): readonly string[] {
  return capabilities.map((capability) => capability.helpLine);
}

export function resolveChannelCapabilityCommand(
  command: ChannelCommand,
  capabilities: readonly ChannelCommandCapability[]
): ChannelCapabilityResolution | undefined {
  return capabilities.find((capability) => capability.commandName === command.name)?.resolve(command.arg);
}

export function buildChannelCapabilityPrompt(
  resolution: Extract<ChannelCapabilityResolution, { readonly kind: "run_skill" }>
): string {
  return [
    `[codex-channel-capability id="${resolution.capabilityId}" operation="${resolution.operation}"]`,
    `使用 $${resolution.skillName} Skill 完成以下操作。`,
    resolution.instruction,
    "[/codex-channel-capability]"
  ].join("\n");
}

export function assertNeverChannelCapabilityResolution(value: never): never {
  throw new UnexpectedChannelCapabilityResolutionError(value);
}

class UnexpectedChannelCapabilityResolutionError extends Error {
  readonly name = "UnexpectedChannelCapabilityResolutionError";

  constructor(readonly value: never) {
    super("Channel capability resolution was not handled exhaustively");
  }
}
