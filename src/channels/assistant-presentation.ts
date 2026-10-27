import { Lexer, type Token } from "marked";

type Annotation = { title: string; body: string; file: string; start?: number; priority?: number };
const marker = "::code-comment{";
const comparable = (text: string) => text.replace(/[\s`*_]/g, "");
/** IM cannot mount Desktop widgets. Project them to inert prose at one shared
 * boundary; literal code and quoted source examples remain opaque. */
export function presentAssistantText(source: string): string {
  if (!source.includes(marker)) return source;
  let preceding = "";
  const prose = (text: string) => {
    let output = "", cursor = 0;
    while (true) {
      const start = text.indexOf(marker, cursor);
      if (start < 0) { const result = output + text.slice(cursor); preceding += result; return result; }
      output += text.slice(cursor, start);
      const parsed = annotation(text, start + marker.length);
      if (!parsed) {
        const end = text.indexOf("\n", start);
        output += "\n\n代码批注格式不完整，请查看原会话中的批注。\n\n";
        cursor = end < 0 ? text.length : end + 1;
        continue;
      }
      cursor = parsed.end;
      const value = parsed.value;
      if (!value) { output += "\n\n代码批注格式无效，请查看原会话中的批注。\n\n"; continue; }
      // Exact repetition can be omitted, never infer semantic equivalence from
      // a filename or discard additional findings/recommendations.
      if (value.body && comparable(preceding + output).includes(comparable(value.body))) continue;
      const location = compactSourceLocation(value.file + (value.start ? `:${value.start}` : ""));
      const title = value.title.replace(/[\r\n]+/g, " ").replace(/\*+/g, "");
      output += `\n\n**${title}**\n${location}\n\n${value.body}\n\n`;
    }
  };
  return projectAssistantProse(source, prose, true);
}

export function projectAssistantProse(source: string, transform: (text: string) => string, directivesOnly = false): string {
  const input = markdownSource(source);
  let output = "", cursor = 0;
  const protectedCode = (token: Token): boolean => token.type === "code" || token.type === "codespan"
    || "tokens" in token && Array.isArray(token.tokens) && token.tokens.some(protectedCode)
    || token.type === "list" && token.items.some((item: { tokens: Token[] }) => item.tokens.some(protectedCode));
  for (const token of Lexer.lex(input.text, { gfm: true })) {
    const offset = input.text.indexOf(token.raw, cursor);
    if (offset < 0) continue;
    output += transform(input.original(cursor, offset));
    // Inline code is protected individually in paragraphs; containing blocks
    // keep indentation/fences exactly, including literal directive examples.
    if (token.type === "code" || token.type === "blockquote" || token.type === "html" || token.type === "list" && protectedCode(token)) output += input.original(offset, offset + token.raw.length);
    else if ("tokens" in token && Array.isArray(token.tokens) && protectedCode(token)) {
      let inner = 0;
      for (const child of token.tokens) {
        if (!protectedCode(child) || directivesOnly && !child.raw.includes(marker)) continue;
        const at = token.raw.indexOf(child.raw, inner);
        if (at < 0) continue;
        output += transform(input.original(offset + inner, offset + at)) + input.original(offset + at, offset + at + child.raw.length);
        inner = at + child.raw.length;
      }
      output += transform(input.original(offset + inner, offset + token.raw.length));
    } else output += transform(input.original(offset, offset + token.raw.length));
    cursor = offset + token.raw.length;
  }
  return output + transform(input.original(cursor));
}

/** marked normalizes CRLF/CR before producing token.raw. Keep token positions
 * in that coordinate system while splicing literal bytes from the original. */
export function markdownSource(source: string): { text: string; original(start: number, end?: number): string } {
  if (!source.includes("\r")) return { text: source, original: (start, end) => source.slice(start, end) };
  const offsets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    offsets.push(index);
    if (source[index] === "\r" && source[index + 1] === "\n") index++;
  }
  offsets.push(source.length);
  return { text: source.replace(/\r\n?/g, "\n"),
    original: (start, end) => source.slice(offsets[start], end === undefined ? undefined : offsets[end]) };
}

function annotation(source: string, offset: number): { end: number; value?: Annotation } | undefined {
  const fields: Record<string, string | number> = {};
  let at = offset;
  while (at < source.length && at - offset < 64_000) {
    while (/\s/.test(source[at] ?? "") && at < source.length) at++;
    if (source[at] === "}") {
      const { title, body, file, start, priority } = fields;
      return { end: at + 1, ...(typeof title === "string" && typeof body === "string" && typeof file === "string"
        ? { value: { title, body, file, ...(typeof start === "number" && start > 0 ? { start } : {}), ...(typeof priority === "number" ? { priority } : {}) } } : {}) };
    }
    const key = /^([a-zA-Z]+)\s*=\s*/.exec(source.slice(at));
    if (!key) return;
    at += key[0].length;
    if (source[at] === '"') {
      const begin = at++;
      let escaped = false;
      for (; at < source.length; at++) {
        const char = source[at];
        if (!escaped && char === '"') break;
        if (!escaped && char === "\\") escaped = true; else escaped = false;
      }
      if (at >= source.length) return;
      try { fields[key[1]] = JSON.parse(source.slice(begin, ++at)); } catch { return; }
    } else {
      const number = /^-?\d+/.exec(source.slice(at));
      if (!number) return;
      fields[key[1]] = Number(number[0]); at += number[0].length;
    }
  }
}

/** A readable reference, not a transfer command or local attachment link. */
export function compactSourceLocation(target: string): string {
  const match = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L\d+)?)?$/.exec(target)!;
  const pieces = match[1].replace(/\\/g, "/").split("/").filter(Boolean);
  const file = pieces.slice(-2).join("/");
  const line = match[2] ?? match[3];
  return file + (line ? `:${line}` : "");
}
