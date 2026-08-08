import { z } from "zod";

import type {
  ChannelCapabilityResolution,
  ChannelCommandCapability
} from "./channel-capability.js";

export const SKILL_EXTENSION_MANIFEST_NAME = "channel-capability.json";
export const MAX_SKILL_EXTENSION_MANIFEST_BYTES = 64 * 1024;

const IdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

const CommandAliasSchema = z.string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[^\s/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u);

const SingleLineTextSchema = z.string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u);

const InstructionSchema = z.string()
  .trim()
  .min(1)
  .max(2_000)
  .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u);

const AiActionSchema = z.object({
  intent: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
  guidance: SingleLineTextSchema,
  argument: z.enum(["none", "target", "detail"])
}).strict();

const OperationSchema = z.object({
  name: IdentifierSchema,
  aliases: z.array(CommandAliasSchema).max(16).default([]),
  instruction: InstructionSchema,
  confirmation: z.enum(["none", "explicit"]).default("none"),
  ai: AiActionSchema.optional()
}).strict();

const ChannelContributionSchema = z.object({
  capabilityId: IdentifierSchema,
  command: z.object({
    name: IdentifierSchema,
    aliases: z.array(CommandAliasSchema).max(16).default([]),
    helpLine: SingleLineTextSchema,
    usage: SingleLineTextSchema,
    defaultOperation: IdentifierSchema
  }).strict(),
  operations: z.array(OperationSchema).min(1).max(32)
}).strict().superRefine((channel, context) => {
  const commandTokens = [channel.command.name, ...channel.command.aliases]
    .map((value) => value.toLowerCase());
  if (new Set(commandTokens).size !== commandTokens.length) {
    context.addIssue({
      code: "custom",
      path: ["command", "aliases"],
      message: "command name and aliases must be unique"
    });
  }
  const operationTokens = new Set<string>();
  const aiIntents = new Set<string>();
  for (const [index, operation] of channel.operations.entries()) {
    for (const token of [operation.name, ...operation.aliases].map((value) => value.toLowerCase())) {
      if (operationTokens.has(token)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index],
          message: `duplicate operation token: ${token}`
        });
      }
      operationTokens.add(token);
    }
    if (operation.ai) {
      if (aiIntents.has(operation.ai.intent)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "ai", "intent"],
          message: `duplicate AI intent: ${operation.ai.intent}`
        });
      }
      aiIntents.add(operation.ai.intent);
    }
  }
  if (!channel.operations.some((operation) => operation.name === channel.command.defaultOperation)) {
    context.addIssue({
      code: "custom",
      path: ["command", "defaultOperation"],
      message: "defaultOperation must name a declared operation"
    });
  }
});

const SidebarContributionSchema = z.object({
  id: IdentifierSchema,
  label: SingleLineTextSchema.max(32),
  ariaLabel: SingleLineTextSchema.max(80),
  url: z.url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && !url.username
      && !url.password;
  }, "sidebar URL must be an HTTP(S) loopback URL"),
  order: z.number().int().min(-1_000).max(1_000),
  icon: z.enum(["document", "database", "generic"]),
  allowClipboard: z.boolean().default(false)
}).strict();

export const SkillExtensionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  channel: ChannelContributionSchema,
  sidebar: SidebarContributionSchema.optional()
}).strict().superRefine((manifest, context) => {
  if (manifest.sidebar && manifest.sidebar.id !== manifest.channel.capabilityId) {
    context.addIssue({
      code: "custom",
      path: ["sidebar", "id"],
      message: "sidebar id must match channel capabilityId"
    });
  }
});

export type SkillExtensionManifest = z.infer<typeof SkillExtensionManifestSchema>;

export function createChannelCapabilityFromManifest(
  skillName: string,
  manifest: SkillExtensionManifest
): ChannelCommandCapability | undefined {
  const channel = manifest.channel;
  const commandAliases = Object.fromEntries(
    channel.command.aliases.map((alias) => [alias.toLowerCase(), channel.command.name])
  );
  const operations = new Map(channel.operations.map((operation) => [operation.name, operation]));
  const operationAliases = new Map(
    channel.operations.flatMap((operation) => [operation.name, ...operation.aliases]
      .map((alias) => [alias.toLowerCase(), operation.name]))
  );

  return Object.freeze({
    id: channel.capabilityId,
    commandName: channel.command.name,
    aliases: Object.freeze(commandAliases),
    helpLine: channel.command.helpLine,
    aiActions: Object.freeze(channel.operations.flatMap((operation) => operation.ai ? [Object.freeze({
      intent: operation.ai.intent,
      operation: operation.name,
      guidance: operation.ai.guidance,
      argument: operation.ai.argument
    })] : [])),
    ...(manifest.sidebar ? { navigation: Object.freeze(manifest.sidebar) } : {}),
    resolve: (arg: string): ChannelCapabilityResolution => {
      const trimmed = arg.trim();
      if (trimmed.length > 2_000) {
        return { kind: "reply", text: `用法：${channel.command.usage}` };
      }
      const [rawOperation, ...remaining] = trimmed
        ? trimmed.split(/\s+/)
        : [channel.command.defaultOperation];
      const operationName = operationAliases.get(rawOperation.toLowerCase());
      const operation = operationName ? operations.get(operationName) : undefined;
      if (!operation) return { kind: "reply", text: `用法：${channel.command.usage}` };
      const detail = remaining.join(" ").trim();
      return {
        kind: "run_skill",
        capabilityId: channel.capabilityId,
        skillName,
        operation: operation.name,
        instruction: [
          operation.instruction,
          detail ? `用户补充：${detail}` : "",
          operation.confirmation === "explicit"
            ? "这是需要显式确认的操作；必须由 Skill 按自身规则验证用户已明确确认，不能仅根据意图分类执行外部副作用。"
            : ""
        ].filter(Boolean).join("\n")
      };
    }
  });
}
