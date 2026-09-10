/** Channel-neutral data, not preformatted Markdown or a platform card schema. */
export type ChannelTable = {
  readonly columns: readonly { readonly label: string }[];
  readonly rows: readonly (readonly string[])[];
};

export type ChannelTableLayout = "native" | "markdown" | "list";

export function compactTableCell(value: string, limit = 28): string {
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].map(x => x.segment);
  return chars.length <= limit ? line : chars.slice(0, Math.max(0, limit - 1)).join("") + "…";
}

/** Table cells are plain data: titles must not add rows, links, images or mentions. */
export function escapeTableMarkdown(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "｜").replace(/([\\`*_\[\]{}~])/g, "\\$1")
    .replace(/[\r\n\u2028\u2029]+/g, " ");
}

export function renderMarkdownTable(table: ChannelTable): string {
  const row = (cells: readonly string[]) => `| ${table.columns.map((_, i) => escapeTableMarkdown(cells[i] ?? "")).join(" | ")} |`;
  return [row(table.columns.map(c => c.label)), `| ${table.columns.map(() => "---").join(" | ")} |`, ...table.rows.map(row)].join("\n");
}

/** One logical line per record; clients wrap naturally without padding or repeated field labels. */
export function renderTextTable(table: ChannelTable): string {
  return table.rows.map(row => {
    const cells = row.map(cell => cell.replace(/\s+/g, " ").trim());
    return [
    `[${cells[0] ?? ""}] ${cells[1] ?? ""}`,
    ...table.columns.slice(2).map((_, i) => cells[i + 2] ?? "")
    ].filter(Boolean).join(" · ");
  }).join("\n");
}
