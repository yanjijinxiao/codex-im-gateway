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

type KnowledgeBaseDirectoryInput = {
  readonly rootPath: string;
  readonly name?: string;
  readonly engineRoot?: string;
  readonly stateDir?: string;
  readonly fallbackName?: string;
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
    case "project": {
      if (!selection.projectId) return undefined;
      const project = store.listProjects().find((candidate) => candidate.id === selection.projectId);
      if (!project) throw new Error(`Managed Codex project not found: ${selection.projectId}`);
      return resolveDirectoryKnowledgeBase(store, llmWiki, {
        rootPath: project.workspace,
        fallbackName: project.name
      });
    }
    case "managed": {
      const knowledgeBase = store.listKnowledgeBases()
        .find((candidate) => candidate.id === selection.knowledgeBaseId);
      if (!knowledgeBase) throw new Error(`Managed knowledge base not found: ${selection.knowledgeBaseId}`);
      await llmWiki.inspect(knowledgeBase);
      return knowledgeBase.id;
    }
    case "directory":
      return resolveDirectoryKnowledgeBase(store, llmWiki, selection);
    default:
      return assertNever(selection);
  }
}

async function resolveDirectoryKnowledgeBase(
  store: RuntimeStateStore,
  llmWiki: LlmWikiInspector,
  selection: KnowledgeBaseDirectoryInput
): Promise<string> {
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
    name: selection.name?.trim() || selection.fallbackName || path.basename(rootPath) || "llm-wiki",
    rootPath,
    ...(selection.engineRoot ? { engineRoot: path.resolve(selection.engineRoot) } : {}),
    ...(selection.stateDir ? { stateDir: path.resolve(selection.stateDir) } : {}),
    createdAt: now,
    updatedAt: now
  };
  await llmWiki.inspect(candidate);
  return store.createKnowledgeBase(candidate.name, candidate.rootPath, candidate).id;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Q&A knowledge-base selection: ${JSON.stringify(value)}`);
}
