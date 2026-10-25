export type ResultPage = { text: string; source: string };

/** UTF-8 transport budget, not a claim about a provider's undocumented UI limit. */
export const DEFAULT_RESULT_PAGE_BYTES = 6_000;

function fenceAt(text: string, end: number): string | undefined {
  let open: string | undefined;
  for (const match of text.slice(0, end).matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/gm)) {
    if (!open) open = `${match[1]}${match[2].slice(0, 80)}`;
    else if (match[1][0] === open[0] && match[1].length >= (open.match(/^(`+|~+)/)?.[0].length ?? 3)
      && !match[2].trim()) open = undefined;
  }
  return open;
}

function tableHeader(text: string, offset: number): string {
  if (!/^\s*\|/.test(text.slice(offset))) return "";
  const lines = text.slice(0, offset).trimEnd().split("\n");
  if (!/^\s*\|/.test(lines.at(-1) ?? "")) return "";
  for (let i = lines.length - 1; i > 0 && /^\s*\|/.test(lines[i]); i--) {
    if (/^\s*\|?[\s:|-]+\|\s*$/.test(lines[i]) && /-/.test(lines[i])) {
      const header = `${lines[i - 1]}\n${lines[i]}\n`;
      return Buffer.byteLength(header) <= 256 ? header : "";
    }
  }
  return "";
}

/** Source slices concatenate exactly to the input; Markdown wrappers are display-only. */
export function resultPages(text: string, maxBytes = DEFAULT_RESULT_PAGE_BYTES, reservedBytes = 0): ResultPage[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1_024) throw new Error("Result page budget must be at least 1024 bytes");
  if (!Number.isInteger(reservedBytes) || reservedBytes < 0 || reservedBytes >= maxBytes - 512) throw new Error("Invalid result presentation overhead");
  maxBytes -= reservedBytes;
  if (Buffer.byteLength(text) <= maxBytes) return [{ text, source: text }];
  const chunks: Array<{ source: string; start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    let bytes = 0, end = start;
    for (const point of text.slice(start)) {
      const size = Buffer.byteLength(point);
      if (bytes + size > maxBytes - 512) break;
      bytes += size; end += point.length;
    }
    if (end < text.length) {
      const segment = text.slice(start, end);
      const paragraph = segment.lastIndexOf("\n\n");
      const line = segment.lastIndexOf("\n");
      const boundary = paragraph >= segment.length / 2 ? paragraph + 2 : line >= segment.length / 2 ? line + 1 : 0;
      if (boundary) end = start + boundary;
    }
    chunks.push({ source: text.slice(start, end), start, end });
    start = end;
  }
  return chunks.map((chunk, index) => {
    const before = fenceAt(text, chunk.start), after = fenceAt(text, chunk.end);
    const prefix = before ? `${before}\n` : tableHeader(text, chunk.start);
    const suffix = after ? `\n${after.match(/^(`+|~+)/)![0]}` : "";
    const rendered = `**完整答复 · ${index + 1}/${chunks.length}**\n\n${prefix}${chunk.source}${suffix}`;
    if (Buffer.byteLength(rendered) > maxBytes) throw new Error("Result page exceeds transport budget");
    return { text: rendered, source: chunk.source };
  });
}
