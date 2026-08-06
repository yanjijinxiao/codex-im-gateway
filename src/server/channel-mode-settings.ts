import path from "node:path";

import type {
  ChannelModeSettings,
  ChannelModeSettingsUpdate,
  QaKnowledgeBaseSelection
} from "../channels/channel-mode-settings.js";
import type { LlmWikiInspection } from "../knowledge/llm-wiki-mcp-client.js";
import type { ManagedKnowledgeBase, RuntimeStateStore } from "../state/runtime-state.js";

type LlmWikiInspector = {
  inspect(knowledgeBase: ManagedKnowledgeBase): Promise<LlmWikiInspection>;
};

type ResolveChannelModeSettingsInput = {
  readonly store: RuntimeStateStore;
  readonly llmWiki: LlmWikiInspector;
  readonly settings: ChannelModeSettingsUpdate;
};

export async function resolveChannelModeSettings(
  input: ResolveChannelModeSettingsInput
): Promise<ChannelModeSettings> {
  const qaKnowledgeBaseId = input.settings.enabledModes.includes("qa")
    ? await resolveQaKnowledgeBase(input.store, input.llmWiki, input.settings.qaKnowledgeBase)
    : undefined;
  return {
    defaultMode: input.settings.defaultMode,
    enabledModes: [...input.settings.enabledModes],
    ...(qaKnowledgeBaseId ? { qaKnowledgeBaseId } : {})
  };
}

async function resolveQaKnowledgeBase(
  store: RuntimeStateStore,
  llmWiki: LlmWikiInspector,
  selection: QaKnowledgeBaseSelection
): Promise<string | undefined> {
  switch (selection.kind) {
    case "project":
      return undefined;
    case "managed": {
      const knowledgeBase = store.listKnowledgeBases()
        .find((candidate) => candidate.id === selection.knowledgeBaseId);
      if (!knowledgeBase) throw new Error(`Managed knowledge base not found: ${selection.knowledgeBaseId}`);
      await llmWiki.inspect(knowledgeBase);
      return knowledgeBase.id;
    }
    case "directory": {
      const rootPath = path.resolve(selection.rootPath);
      const existing = store.listKnowledgeBases().find((candidate) => candidate.rootPath === rootPath);
      if (existing) {
        const update = {
          ...(selection.name !== undefined ? { name: selection.name } : {}),
          ...(selection.engineRoot !== undefined ? { engineRoot: path.resolve(selection.engineRoot) } : {}),
          ...(selection.stateDir !== undefined ? { stateDir: path.resolve(selection.stateDir) } : {})
        };
        await llmWiki.inspect({ ...existing, ...update });
        if (Object.keys(update).length) store.updateKnowledgeBase(existing.id, update);
        return existing.id;
      }
      const now = new Date().toISOString();
      const candidate: ManagedKnowledgeBase = {
        id: "validation",
        name: selection.name?.trim() || path.basename(rootPath) || "llm-wiki",
        rootPath,
        ...(selection.engineRoot ? { engineRoot: path.resolve(selection.engineRoot) } : {}),
        ...(selection.stateDir ? { stateDir: path.resolve(selection.stateDir) } : {}),
        createdAt: now,
        updatedAt: now
      };
      await llmWiki.inspect(candidate);
      return store.createKnowledgeBase(candidate.name, candidate.rootPath, candidate).id;
    }
    default:
      return assertNever(selection);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Q&A knowledge-base selection: ${JSON.stringify(value)}`);
}
