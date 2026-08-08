import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ChannelCommandCapability,
  ChannelCapabilityProvider
} from "./channel-capability.js";
import { isBuiltInAiChannelActionName } from "./ai-channel-intent-decision.js";
import { isReservedChannelCommandToken } from "./channel-commands.js";
import {
  createChannelCapabilityFromManifest,
  MAX_SKILL_EXTENSION_MANIFEST_BYTES,
  SKILL_EXTENSION_MANIFEST_NAME,
  SkillExtensionManifestSchema
} from "./skill-extension-manifest.js";

type InstalledSkillCapabilitiesProviderOptions = {
  readonly codexHome?: string;
  readonly warn?: (message: string) => void;
};

const MAX_SKILL_ENTRY_BYTES = 1024 * 1024;
const SKILL_INVOCATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function createInstalledSkillCapabilitiesProvider(
  options: InstalledSkillCapabilitiesProviderOptions = {}
): ChannelCapabilityProvider {
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
  const skillsRoot = path.join(codexHome, "skills");
  const warned = new Set<string>();
  const warn = (message: string): void => {
    if (warned.has(message)) return;
    warned.add(message);
    (options.warn ?? console.warn)(`[codex-channel-bridge] ${message}`);
  };

  return async () => {
    let skillNames: string[];
    try {
      skillNames = (await readdir(skillsRoot)).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isMissingPathError(error)) return [];
      throw error;
    }

    const eligibleSkillNames = skillNames.filter((skillName) => (
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillName)
    ));
    const candidates = await Promise.all(eligibleSkillNames.map(async (skillName) => {
      const skillRoot = path.join(skillsRoot, skillName);
      const skillEntry = path.join(skillRoot, "SKILL.md");
      const manifestPath = path.join(skillRoot, SKILL_EXTENSION_MANIFEST_NAME);
      try {
        const [skillStats, manifestStats] = await Promise.all([stat(skillEntry), lstat(manifestPath)]);
        if (!skillStats.isFile() || !manifestStats.isFile() || manifestStats.isSymbolicLink()) return undefined;
        if (skillStats.size > MAX_SKILL_ENTRY_BYTES) {
          warn(`Ignoring oversized Skill entrypoint: ${skillEntry}`);
          return undefined;
        }
        if (manifestStats.size > MAX_SKILL_EXTENSION_MANIFEST_BYTES) {
          warn(`Ignoring oversized Skill extension manifest: ${manifestPath}`);
          return undefined;
        }
        const handle = await open(
          manifestPath,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
        );
        let contents: string;
        try {
          const openedStats = await handle.stat();
          if (
            !openedStats.isFile()
            || openedStats.dev !== manifestStats.dev
            || openedStats.ino !== manifestStats.ino
            || openedStats.size > MAX_SKILL_EXTENSION_MANIFEST_BYTES
          ) {
            warn(`Ignoring changed or oversized Skill extension manifest: ${manifestPath}`);
            return undefined;
          }
          contents = await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
        const raw: unknown = JSON.parse(contents);
        const parsed = SkillExtensionManifestSchema.safeParse(raw);
        if (!parsed.success) {
          warn(`Ignoring invalid Skill extension manifest: ${manifestPath}`);
          return undefined;
        }
        const invocationName = parseSkillInvocationName(await readFile(skillEntry, "utf8"));
        if (!invocationName) {
          warn(`Ignoring Skill extension with an invalid frontmatter name: ${skillEntry}`);
          return undefined;
        }
        return createChannelCapabilityFromManifest(invocationName, parsed.data);
      } catch (error) {
        if (isMissingPathError(error) || error instanceof SyntaxError) {
          if (error instanceof SyntaxError) warn(`Ignoring invalid Skill extension manifest: ${manifestPath}`);
          return undefined;
        }
        warn(`Ignoring unreadable Skill extension: ${skillRoot}`);
        return undefined;
      }
    }));

    const validated = validateCapabilityConflicts(candidates.filter(isChannelCapability), warn);
    if (validated.length > 64) {
      warn("Ignoring installed Skill capabilities beyond the 64-capability limit");
    }
    return Object.freeze(validated.slice(0, 64));
  };
}

function parseSkillInvocationName(contents: string): string | undefined {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex < 0) return undefined;
  const names = lines.slice(1, closingIndex).flatMap((line) => {
    const match = line.match(/^name:\s*(.*?)\s*$/);
    if (!match) return [];
    const value = match[1];
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) return [value.slice(1, -1)];
    return [value];
  });
  if (names.length !== 1 || !SKILL_INVOCATION_NAME_PATTERN.test(names[0])) return undefined;
  return names[0];
}

function validateCapabilityConflicts(
  candidates: readonly ChannelCommandCapability[],
  warn: (message: string) => void
): readonly ChannelCommandCapability[] {
  const accepted: ChannelCommandCapability[] = [];
  const idCounts = countValues(candidates.map((capability) => capability.id));
  const commandTokenCounts = countValues(candidates.flatMap((capability) => [
    capability.commandName,
    ...Object.keys(capability.aliases)
  ]));
  const aiIntentCounts = countValues(candidates.flatMap((capability) => (
    capability.aiActions.map((action) => action.intent)
  )));

  for (const capability of candidates) {
    const tokens = [capability.commandName, ...Object.keys(capability.aliases)];
    const conflict = idCounts.get(capability.id) !== 1
      || tokens.some((token) => isReservedChannelCommandToken(token) || commandTokenCounts.get(token) !== 1)
      || capability.aiActions.some((action) => (
        isBuiltInAiChannelActionName(action.intent)
        || aiIntentCounts.get(action.intent) !== 1
      ));
    if (conflict) {
      warn(`Ignoring conflicting Skill channel capability: ${capability.id}`);
      continue;
    }
    accepted.push(capability);
  }

  return Object.freeze(accepted);
}

function countValues(values: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function isChannelCapability(
  capability: ChannelCommandCapability | undefined
): capability is ChannelCommandCapability {
  return capability !== undefined;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
