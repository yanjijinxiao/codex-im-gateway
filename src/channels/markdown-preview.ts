import { Lexer, type Token, type Tokens } from "marked";
import { compactSourceLocation, presentAssistantText } from "./assistant-presentation.js";

const escape = (text: string) => text.replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);)/gi, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}\[\]()#+.!|~\-]/g, "\\$&");
const inlineCode = (text: string) => {
  const max = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  if (max >= 2) return escape(text); // Never manufacture a block fence at line start.
  const fence = "`".repeat(max + 1), pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
};

/** Balanced inline Markdown with explicit visible hierarchy. No native table,
 * list or code-block widgets: these can disappear when a streaming card rewrites.
 * The final document remains unchanged. Only visible payload consumes the budget.
 */
export function markdownPreview(source: string, limit = 600, options: { emphasis?: boolean } = {}): string {
  let remaining = Math.max(0, limit), clipped = false;
  const take = (text: string) => {
    const chars = Array.from(text);
    if (chars.length > remaining) clipped = true;
    const result = chars.slice(0, remaining).join(""); remaining -= Math.min(chars.length, remaining); return result;
  };
  const children = (tokens: Token[] | undefined) => (tokens ?? []).map(token => render(token)).join("");
  const wrapped = (mark: string, text: string) => text ? `${mark}${text}${mark}` : "";
  const render = (token: Token): string => {
    if (!remaining && token.type !== "space" && token.type !== "br") { clipped = true; return ""; }
    switch (token.type) {
      case "space": case "hr": return "\n\n";
      case "br": return "\n";
      case "strong": return options.emphasis === false ? children(token.tokens) : wrapped("**", children(token.tokens));
      case "em": return options.emphasis === false ? children(token.tokens) : wrapped("_", children(token.tokens));
      case "del": return wrapped("~~", children(token.tokens));
      case "codespan": return inlineCode(take(token.text));
      case "heading": return (options.emphasis === false ? children(token.tokens) : wrapped("**", children(token.tokens))) + "\n\n";
      case "paragraph": return children(token.tokens) + "\n\n";
      case "blockquote": return (token.tokens ?? []).map((part: Token) => render(part)).join("").trim().split("\n").map(line => "│ " + line).join("\n") + "\n\n";
      case "list": return (token as Tokens.List).items.map((item, index) => {
        const marker = (token as Tokens.List).ordered ? `**${Number((token as Tokens.List).start) + index}.** ` : "• ";
        const body = children(item.tokens).trim();
        return body ? marker + (item.task ? item.checked ? "☑ " : "☐ " : "") + body.replace(/\n/g, "\n　") : "";
      }).filter(Boolean).join("\n") + "\n\n";
      case "table": return (token as Tokens.Table).rows.map(row => {
        if (!remaining) { clipped = true; return ""; }
        return "• " + row.map((cell, index) => {
          if (!remaining) return "";
          const label = (token as Tokens.Table).header[index]?.text || `列 ${index + 1}`;
          return wrapped("**", escape(take(label)) + "：") + children(cell.tokens);
        }).filter(Boolean).join("； ");
      }).filter(Boolean).join("\n") + "\n\n";
      case "code": {
        if (/^(?:codex-im-gateway|codex-channel-bridge|codex-weixin(?:-server)?)-actions$/i.test(token.lang ?? "")) return "";
        const lines = (token as Tokens.Code).text.split("\n");
        if (lines.length > 12) clipped = true;
        return "**代码预览**\n" + lines.slice(0, 12).map(line => { if (!remaining) { clipped = true; return ""; } return inlineCode(take(line)); }).filter(Boolean).join("\n") + "\n\n";
      }
      case "link": {
        const label = children(token.tokens);
        if (!/^(?:https?:|mailto:)/i.test(token.href)) return label + (label && /^(?:\/|[A-Za-z]:[\\/])/.test(token.href) ? `（${escape(take(compactSourceLocation(token.href)))}）` : "");
        const href = (token as Tokens.Link).href.replace(/[<>"()\s]/g, char => encodeURIComponent(char));
        return label ? `[${label}](${href})` : "";
      }
      case "image": return escape(take(token.text || "图片"));
      case "checkbox": return "";
      case "text": return "tokens" in token && token.tokens ? children(token.tokens) : escape(take(token.text));
      default: return escape(take("text" in token && typeof token.text === "string" ? token.text : token.raw));
    }
  };
  const result = children(Lexer.lex(presentAssistantText(source.trim()), { gfm: true }))
    .replace(/\n{3,}/g, "\n\n").trim();
  return result + (clipped ? "…" : "");
}
