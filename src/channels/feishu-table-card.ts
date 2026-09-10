import type * as Lark from "@larksuiteoapi/node-sdk";
import type { ChannelActionCard } from "./action-card.js";
import { escapeTableMarkdown } from "./table.js";

/** The SDK's legacy InteractiveCard type predates Card JSON 2.0. */
export type FeishuTableCardPayload = {
  schema: "2.0";
  config: { update_multi: boolean };
  header: NonNullable<Lark.InteractiveCard["header"]>;
  body: { elements: Record<string, unknown>[] };
};

export function feishuTableCard(card: ChannelActionCard): FeishuTableCardPayload {
  const table = card.table!;
  const elements: Record<string, unknown>[] = [];
  if (card.body) elements.push({ tag: "markdown", content: card.body });
  // Keep native components small within ONE message; Gateway paging still owns
  // the complete 30/50-row page and its stable R codes, with no rows discarded.
  for (let start = 0; start < table.rows.length; start += 10) elements.push({
    tag: "table",
    page_size: Math.min(10, table.rows.length - start),
    columns: table.columns.map((column, i) => ({ name: `col_${i}`, display_name: column.label, data_type: "text", horizontal_align: "left" })),
    rows: table.rows.slice(start, start + 10).map(cells => Object.fromEntries(table.columns.map((_, i) => [`col_${i}`, cells[i] ?? ""])))
  });
  if (card.note) elements.push({ tag: "markdown", content: escapeTableMarkdown(card.note) });
  for (const group of card.actionGroups) {
    elements.push({ tag: "column_set", flex_mode: "flow", columns: group.map(action => ({
      tag: "column", width: "weighted", weight: 1,
      elements: [{ tag: "button", text: { tag: "plain_text", content: action.label }, type: action.style,
        behaviors: [{ type: "callback", value: action.value }],
        ...(action.confirm ? { confirm: { title: { tag: "plain_text", content: "请确认" }, text: { tag: "plain_text", content: action.confirm } } } : {})
      }]
    })) });
  }
  return { schema: "2.0", config: { update_multi: true }, header: {
    template: card.template, title: { tag: "plain_text", content: card.title }
  }, body: { elements } };
}
