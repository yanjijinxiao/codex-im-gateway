import { formatChannelActionCommand } from "./action-card.js";
import { copyableChoices } from "./copyable.js";
import type { ChannelTaskCard } from "./task-card.js";

/** Same copy-only projection for native task cards and text-only adapters. */
export function copyableTaskCard(card: ChannelTaskCard): ChannelTaskCard {
  const actions = [...card.actions, ...(card.kind === "overview"
    ? [...card.filterActions, ...card.pageActions, ...card.items.map(item => item.action)]
    : card.kind === "form" ? card.submitActions : [])];
  const values = actions.flatMap(action => {
    if (action.kind !== "command") return [];
    const value = formatChannelActionCommand(action.value);
    return value ? [{ label: action.label, value }] : [];
  });
  if (card.kind === "form") for (const field of card.fields) if (field.kind === "select")
    values.push(...field.options.map(option => ({ label: `${field.label} · ${option.label}`, value: option.value })));
  return { ...card, copyText: copyableChoices("", values).trim(), fallbackText: copyableChoices(card.fallbackText, values) };
}
