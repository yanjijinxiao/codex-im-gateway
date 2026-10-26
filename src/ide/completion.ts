import { closeMarkdownFence } from "../channels/result-pages.js";

/** A presentation label, not a URL shortener or an authorization credential. */
export function ideEntryLink(url: string): string {
  const target = new URL(url);
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) throw new Error("无效的 Web IDE 链接");
  // Keep Markdown control characters out of the destination without changing
  // its origin, path or browser authorization scope.
  const destination = target.href.replace(/[()<>]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[打开项目 Web IDE](${destination})`;
}

/** Presentation-only enrichment. Never alters the model history or submission. */
export function withIDEEntry(text: string, url?: string, options: { atEnd?: boolean } = {}): string {
  // This standalone label is Gateway-owned, including legacy model-authored
  // footers. Reconcile it semantically, not by comparing two session URLs.
  let fence: string | undefined;
  text = text.split("\n").filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; return true; }
    if (fence) return true;
    const match = /^\s*\[打开项目 Web IDE\]\((https?:\/\/\S+)\)\s*$/.exec(line);
    if (!match) return true;
    try { return !/^\/workspace\/[^/]+\/?$/.test(new URL(match[1]).pathname); } catch { return true; }
  }).join("\n").trimEnd();
  if (!url) return text;
  const link = ideEntryLink(url);
  if (!options.atEnd && (text.includes(url) || text.includes(link))) return text;
  if (options.atEnd) text = closeMarkdownFence(text);
  return `${text.trim()}\n\n${link}`;
}
