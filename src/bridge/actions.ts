import path from "node:path";
import { fileURLToPath } from "node:url";
import { Lexer } from "marked";

import { KNOWLEDGE_KINDS, type KnowledgeInput } from "../state/knowledge.js";
import { presentAssistantText, compactSourceLocation, projectAssistantProse, markdownSource } from "../channels/assistant-presentation.js";

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

const ACTION_LANGUAGE = /^(?:codex-im-gateway|codex-channel-bridge|codex-weixin(?:-server)?)-actions$/i;
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

export function parseActionBlocks(text: string, options: { strict?: boolean } = {}): ParsedActionBlocks {
  const actions: BridgeActions = { send: [], control: [], remember: [] };
  const source = markdownSource(text);
  let visible = "", cursor = 0, invalid = false;
  // Only explicit, closed, top-level Markdown fences are executable. Quoted
  // source, lists and longer outer example fences remain ordinary content.
  for (const token of Lexer.lex(source.text, { gfm: true })) {
    const offset = source.text.indexOf(token.raw, cursor);
    if (offset < 0 || token.type !== "code" || !ACTION_LANGUAGE.test(token.lang ?? "")) continue;
    visible += source.original(cursor, offset);
    cursor = offset + token.raw.length;
    try {
    const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(token.raw)?.[1];
    const closing = /(?:^|\n) {0,3}(`+|~+)[ \t]*\n*$/.exec(token.raw)?.[1];
    if (!opening || !closing || opening[0] !== closing[0] || closing.length < opening.length) throw Error("Action fence is incomplete");
    const parsed = JSON.parse(token.text.trim()) as {
      send?: unknown;
      control?: unknown;
      remember?: unknown;
    };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Action payload must be an object");
    for (const field of ["send", "control", "remember"] as const)
      if (parsed[field] !== undefined && !Array.isArray(parsed[field])) throw Error(`Action ${field} must be an array`);

    const sends = Array.isArray(parsed.send) ? parsed.send.map(normalizeSendAction) : [];
    const controls = Array.isArray(parsed.control) ? parsed.control.map(normalizeControlAction) : [];
    const seen = new Set(actions.send.map((action) => action.path));
    for (const action of sends) appendSendAction(actions, seen, action);
    actions.control.push(...controls);
    if (Array.isArray(parsed.remember)) {
      for (const raw of parsed.remember.slice(0, Math.max(0, 3 - actions.remember.length))) {
        const action = tryNormalizeKnowledgeAction(raw);
        if (action) actions.remember.push(action);
      }
    }
    } catch (error) {
      if (options.strict !== false) throw error;
      invalid = true;
    }
  }
  visible += source.original(cursor);
  if (invalid) {
    actions.send = []; actions.control = []; actions.remember = [];
    visible += "\n\n回复中的附加动作格式无效，未执行附件发送、会话变更或记忆保存。";
  }
  const visibleTextWithoutBlocks = visible.trim();
  return { visibleText: renderLocalMarkdownReferences(presentAssistantText(visibleTextWithoutBlocks)), actions };
}
