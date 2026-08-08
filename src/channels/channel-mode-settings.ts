export const PROJECT_INTERACTION_MODES = ["session", "task", "qa"] as const;

export type ProjectInteractionMode = typeof PROJECT_INTERACTION_MODES[number];

export type ChannelModeSettings = {
  readonly defaultMode: ProjectInteractionMode;
  readonly enabledModes: readonly ProjectInteractionMode[];
  readonly qaKnowledgeBaseId?: string;
};

export type QaKnowledgeBaseSelection =
  | { readonly kind: "project"; readonly projectId?: string }
  | { readonly kind: "managed"; readonly knowledgeBaseId: string }
  | {
      readonly kind: "directory";
      readonly rootPath: string;
      readonly name?: string;
      readonly engineRoot?: string;
      readonly stateDir?: string;
    };

export type ChannelModeSettingsUpdate = {
  readonly defaultMode: ProjectInteractionMode;
  readonly enabledModes: readonly ProjectInteractionMode[];
  readonly qaKnowledgeBase: QaKnowledgeBaseSelection;
};

export function defaultChannelModeSettings(): ChannelModeSettings {
  return {
    defaultMode: "session",
    enabledModes: [...PROJECT_INTERACTION_MODES]
  };
}

export function normalizeChannelModeSettings(value: unknown): ChannelModeSettings {
  if (!isRecord(value)) return defaultChannelModeSettings();
  const requestedModes = Array.isArray(value.enabledModes)
    ? value.enabledModes.filter(isProjectInteractionMode)
    : [...PROJECT_INTERACTION_MODES];
  const enabledModes = PROJECT_INTERACTION_MODES.filter((mode) => requestedModes.includes(mode));
  const defaultMode = isProjectInteractionMode(value.defaultMode) && enabledModes.includes(value.defaultMode)
    ? value.defaultMode
    : enabledModes[0] ?? "session";
  const qaKnowledgeBaseId = typeof value.qaKnowledgeBaseId === "string"
    ? value.qaKnowledgeBaseId.trim()
    : "";
  return {
    defaultMode,
    enabledModes: enabledModes.length ? enabledModes : ["session"],
    ...(qaKnowledgeBaseId ? { qaKnowledgeBaseId } : {})
  };
}

export function isProjectInteractionMode(value: unknown): value is ProjectInteractionMode {
  return value === "session" || value === "task" || value === "qa";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
