import fs from "node:fs";
export const COPY_SCRIPT = fs.readFileSync(new URL("../web/copyable.js", import.meta.url), "utf8");
export const COPY_STYLE = fs.readFileSync(new URL("../web/copyable.css", import.meta.url), "utf8");
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
/** Same markup contract as the browser control; values stay inert and visible. */
export function copyField(label: string, value: string, options: { purpose: "reply" | "transfer"; rows?: 1 | 2 }): string {
  return `<div class="gateway-copy" data-copy-field data-copy-purpose="${options.purpose}"><label>${escape(label)}<textarea data-copy-value readonly rows="${options.rows ?? 1}" spellcheck="false" autocapitalize="off">${escape(value)}</textarea></label><button type="button" data-copy-button aria-label="${escape(`复制${label}`)}">复制</button><small data-copy-status role="status" aria-live="polite"></small></div>`;
}
