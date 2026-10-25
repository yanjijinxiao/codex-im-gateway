import { Lexer, type Token, type Tokens } from "marked";
import { closeMarkdownFence } from "./result-pages.js";

/** The client's native cursor must end in a normal paragraph, never inside a
 * code/list/table block. Display-only: the stored task/command is unchanged. */
export function dingTalkLoadingBody(source: string): string {
  const last = Lexer.lex(source, { gfm: true }).filter(token => token.type !== "space").at(-1);
  return last && !["paragraph", "text"].includes(last.type) ? `${closeMarkdownFence(source).trimEnd()}\n\n正在处理…` : source;
}

/** Plain webhook transport has no Markdown renderer. Remove only code-block
 * wrappers, never rewrite the literal reply/command inside them. */
export function dingTalkPlainText(source: string): string {
  let result = "", cursor = 0;
  for (const token of Lexer.lex(source, { gfm: true })) {
    const offset = source.indexOf(token.raw, cursor);
    if (offset < 0 || !token.raw) continue;
    let replacement = token.raw;
    if (token.type === "code" && /^ {0,3}(?:`{3,}|~{3,})/.test(token.raw))
      replacement = (token as Tokens.Code).text + trailingNewlines(token.raw);
    else if (token.type === "blockquote")
      replacement = dingTalkPlainText((token as Tokens.Blockquote).text).split("\n").map(line => `> ${line}`).join("\n") + trailingNewlines(token.raw);
    result += source.slice(cursor, offset) + replacement;
    cursor = offset + token.raw.length;
  }
  return result + source.slice(cursor);
}

/**
 * The AI Card template can render list bodies without their native ordered-list
 * markers. Put ordinals in the body instead. This is presentation-only: never
 * rewrite the stored Codex answer or the shared pagination/delivery receipts.
 */
export function dingTalkVisibleOrdinals(source: string, nested = false): string {
  const tokens = Lexer.lex(source, { gfm: true });
  let result = "", cursor = 0;
  for (const token of tokens) {
    // Splice into the original source rather than joining token.raw: Markdown
    // reference definitions are not emitted as block tokens by the lexer.
    const offset = source.indexOf(token.raw, cursor);
    if (offset < 0 || !token.raw) continue;
    let replacement = token.raw;
    if (token.type === "list" && containsOrderedList(token)) {
      replacement = visibleList(token as Tokens.List, nested);
    } else if (token.type === "blockquote" && containsOrderedList(token)) {
      const quote = token as Tokens.Blockquote;
      replacement = dingTalkVisibleOrdinals(quote.text, nested).split("\n").map(line => `> ${line}`).join("\n")
        + trailingNewlines(token.raw);
    }
    result += source.slice(cursor, offset) + replacement;
    cursor = offset + token.raw.length;
  }
  return result + source.slice(cursor);
}

function containsOrderedList(token: Token): boolean {
  if (token.type === "list") {
    const list = token as Tokens.List;
    return list.ordered || list.items.some(item => item.tokens.some(containsOrderedList));
  }
  return token.type === "blockquote" && (token as Tokens.Blockquote).tokens.some(containsOrderedList);
}

function visibleList(list: Tokens.List, nested: boolean): string {
  const items = list.items.map((item, index) => {
    // item.text is the lexer's de-indented source, not rendered HTML. It keeps
    // code fences, links, tables and reference definitions in their own blocks.
    const body = dingTalkVisibleOrdinals(item.text, true).replace(/\n+$/, "");
    const ordinal = list.ordered ? `**${Number(list.start) + index}.** ` : "";
    // Nested ordinals live inside a bullet so child indentation remains real
    // Markdown structure; their number is still ordinary visible body text.
    const bullet = !list.ordered || nested ? "- " : "";
    const checkbox = item.task ? `[${item.checked ? "x" : " "}] ` : "";
    const indent = bullet ? "  " : "";
    const firstBlock = item.tokens.find(token => token.type !== "space" && token.type !== "checkbox");
    const blockBody = firstBlock && firstBlock.type !== "text" && firstBlock.type !== "paragraph";
    const marker = bullet + ordinal + checkbox;
    // A code fence/table/heading must start its own block, never after a label.
    const prefix = blockBody ? `${marker.trimEnd()}\n\n${indent}` : marker;
    return prefix + body.replace(/\n/g, `\n${indent}`);
  });
  return items.join(list.loose || (list.ordered && !nested) ? "\n\n" : "\n") + trailingNewlines(list.raw);
}

function trailingNewlines(raw: string): string {
  return raw.match(/\n*$/)![0];
}
