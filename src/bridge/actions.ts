import path from "node:path";
import { fileURLToPath } from "node:url";

import { KNOWLEDGE_KINDS, type KnowledgeInput } from "../state/knowledge.js";
import { presentAssistantText, compactSourceLocation, projectAssistantProse } from "../channels/assistant-presentation.js";

export type SendAction = {
  type: "image" | "file" | "video";
  path: string;
};

export type ControlAction =
  | { type: "workspace.set"; path: string }
  | { type: "workspace.reset" }
  | { type: "thread.reset" };

export type BridgeActions = {
  send: SendAction[];
  control: ControlAction[];
  remember: KnowledgeInput[];
};

export type ParsedActionBlocks = {
  visibleText: string;
  actions: BridgeActions;
};

const ACTION_BLOCK_RE = /```(?:codex-im-gateway|codex-channel-bridge|codex-weixin(?:-server)?)-actions\s*([\s\S]*?)```/gi;
const MARKDOWN_LINK_RE = /(!)?\[([^\]]*)]\((<[^>\r\n]+>|[^)\r\n]+)\)/g;

function isAbsoluteLocalPath(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsoluteLocalPath(value)) {
    throw new Error(`${label} must be an absolute path: ${value}`);
  }
}

function normalizeSendAction(raw: unknown): SendAction {
  if (!raw || typeof raw !== "object") {
    throw new Error("send action must be an object");
  }
  const candidate = raw as Partial<SendAction>;
  if (candidate.type !== "image" && candidate.type !== "file" && candidate.type !== "video") {
    throw new Error("send action type must be image, file, or video");
  }
  if (typeof candidate.path !== "string" || !candidate.path.trim()) {
    throw new Error("send action path is required");
  }
  const resolved = candidate.path.trim();
  assertAbsolutePath(resolved, "send action path");
  return { type: candidate.type, path: resolved };
}

function normalizeLocalMarkdownTarget(raw: string): string | undefined {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  if (/^file:/i.test(target)) {
    try {
      const url = new URL(target);
      target = fileURLToPath(url) + url.search + url.hash;
    } catch {
      return undefined;
    }
  } else {
    try {
      target = decodeURI(target);
    } catch {
      // Keep the raw target if it contains characters decodeURI cannot parse.
    }
  }
  return isAbsoluteLocalPath(target) ? target : undefined;
}

function appendSendAction(actions: BridgeActions, seen: Set<string>, action: SendAction): void {
  const key = action.path;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  actions.send.push(action);
}

function renderLocalMarkdownReferences(text: string): string {
  // A source citation (including :line or #Lline) is not an attachment request.
  // Only explicit action blocks may enqueue sends. Keep the label, location and
  // surrounding prose instead of removing the whole line containing the link.
  return projectAssistantProse(text, prose => prose.replace(MARKDOWN_LINK_RE, (link, _image: string | undefined, label: string, raw: string) => {
    const target = normalizeLocalMarkdownTarget(raw);
    if (!target) return link;
    const location = compactSourceLocation(target);
    return label.trim() && !location.endsWith(label.trim()) ? `${label}（${location}）` : location;
  }));
}

function normalizeControlAction(raw: unknown): ControlAction {
  if (!raw || typeof raw !== "object") {
    throw new Error("control action must be an object");
  }
  const candidate = raw as { type?: unknown; path?: unknown };
  if (candidate.type === "workspace.set") {
    if (typeof candidate.path !== "string" || !candidate.path.trim()) {
      throw new Error("workspace.set path is required");
    }
    const resolved = candidate.path.trim();
    assertAbsolutePath(resolved, "workspace.set path");
    return { type: "workspace.set", path: resolved };
  }
  if (candidate.type === "workspace.reset") {
    return { type: "workspace.reset" };
  }
  if (candidate.type === "thread.reset") {
    return { type: "thread.reset" };
  }
  throw new Error(`unsupported control action type: ${String(candidate.type)}`);
}

function normalizeKnowledgeAction(raw: unknown): KnowledgeInput {
  if (!raw || typeof raw !== "object") {
    throw new Error("remember action must be an object");
  }
  const candidate = raw as { kind?: unknown; scope?: unknown; title?: unknown; content?: unknown };
  if (!KNOWLEDGE_KINDS.includes(candidate.kind as KnowledgeInput["kind"])) {
    throw new Error("remember action kind must be preference, skill, knowledge, or workflow");
  }
  if (candidate.scope !== "account" && candidate.scope !== "project") {
    throw new Error("remember action scope must be account or project");
  }
  if (typeof candidate.title !== "string" || typeof candidate.content !== "string") {
    throw new Error("remember action title and content are required");
  }
  return {
    kind: candidate.kind as KnowledgeInput["kind"],
    scope: candidate.scope,
    title: candidate.title,
    content: candidate.content
  };
}

function tryNormalizeKnowledgeAction(raw: unknown): KnowledgeInput | undefined {
  try {
    return normalizeKnowledgeAction(raw);
  } catch {
    return undefined;
  }
}

export function parseActionBlocks(text: string): ParsedActionBlocks {
  const actions: BridgeActions = { send: [], control: [], remember: [] };
  const visibleTextWithoutBlocks = text.replace(ACTION_BLOCK_RE, (_match, body: string) => {
    const parsed = JSON.parse(String(body).trim()) as {
      send?: unknown;
      control?: unknown;
      remember?: unknown;
    };

    if (Array.isArray(parsed.send)) {
      const seen = new Set(actions.send.map((action) => action.path));
      for (const action of parsed.send.map(normalizeSendAction)) {
        appendSendAction(actions, seen, action);
      }
    }
    if (Array.isArray(parsed.control)) {
      actions.control.push(...parsed.control.map(normalizeControlAction));
    }
    if (Array.isArray(parsed.remember)) {
      for (const raw of parsed.remember.slice(0, 3)) {
        const action = tryNormalizeKnowledgeAction(raw);
        if (action) actions.remember.push(action);
      }
    }

    return "";
  }).trim();

  return { visibleText: renderLocalMarkdownReferences(presentAssistantText(visibleTextWithoutBlocks)), actions };
}
