export const KNOWLEDGE_KINDS = ["preference", "skill", "knowledge", "workflow"] as const;

export type KnowledgeKind = typeof KNOWLEDGE_KINDS[number];
export type KnowledgeScope = "account" | "project";

export type KnowledgeEntry = {
  id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  title: string;
  content: string;
  projectId?: string;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeInput = {
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  title: string;
  content: string;
};

const SECRET_PATTERN = /(?:\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret)\b|密码|口令|私钥).{0,20}(?:[:=：]|\bis\b|是|为)|\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,})\b|-----BEGIN [^-]*PRIVATE KEY-----/i;

export function cleanKnowledgeInput(input: KnowledgeInput): KnowledgeInput | undefined {
  const title = cleanText(input.title, 80);
  const content = cleanText(input.content, 500);
  if (!title || !content || SECRET_PATTERN.test(`${title}\n${content}`)) return undefined;
  return { ...input, title, content };
}

export function knowledgeIdentity(input: Pick<KnowledgeInput, "kind" | "scope" | "title">, projectId?: string): string {
  return [input.kind, input.scope, projectId ?? "", normalizeIdentity(input.title)].join("|");
}

export function selectRelevantKnowledge(
  entries: readonly KnowledgeEntry[],
  query: string,
  projectId?: string,
  limit = 20
): KnowledgeEntry[] {
  const queryTerms = terms(query);
  return entries
    .filter((entry) => entry.scope === "account" || entry.projectId === projectId)
    .map((entry) => {
      const entryTerms = terms(`${entry.title} ${entry.content}`);
      const overlap = [...queryTerms].filter((term) => entryTerms.has(term)).length;
      const base = entry.kind === "preference" ? 4 : 0;
      const projectBoost = entry.scope === "project" ? 3 : 0;
      return { entry, score: base + projectBoost + overlap };
    })
    .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
    .slice(0, limit)
    .map(({ entry }) => structuredClone(entry));
}

function cleanText(value: string, limit: number): string {
  return value.trim().replace(/\s+/g, " ").slice(0, limit);
}

function normalizeIdentity(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function terms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.match(/[a-z0-9]{2,}|[\p{Script=Han}]/gu) ?? [];
  const han = [...normalized].filter((character) => /\p{Script=Han}/u.test(character));
  const bigrams = han.slice(0, -1).map((character, index) => `${character}${han[index + 1]}`);
  return new Set([...words, ...bigrams]);
}
