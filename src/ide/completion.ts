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
export function withIDEEntry(text: string, url?: string): string {
  if (!url) return text;
  const link = ideEntryLink(url);
  if (text.includes(url) || text.includes(link)) return text;
  return `${text.trim()}\n\n${link}`;
}
