import type * as Lark from "@larksuiteoapi/node-sdk";

import type { ChannelTaskCard } from "./task-card.js";

export function feishuTaskCard(card: ChannelTaskCard): Lark.InteractiveCard {
  const elements: Lark.InteractiveCardElement[] = [{
    tag: "div",
    text: { tag: "plain_text", content: card.summary },
    fields: [
      { is_short: true, text: { tag: "lark_md", content: `**项目**\n${card.projectName}` } },
      { is_short: true, text: { tag: "lark_md", content: `**状态**\n${card.statusLabel}` } }
    ]
  }];
  if (card.description) {
    elements.push({ tag: "div", text: { tag: "plain_text", content: `说明：${card.description}` } });
  }
  if (card.latestComment) {
    elements.push({ tag: "div", text: { tag: "plain_text", content: `最新记录：${card.latestComment}` } });
  }
  if (card.note) {
    elements.push({ tag: "note", elements: [{ tag: "plain_text", content: card.note }] });
  }
  if (card.actions.length) {
    elements.push({
      tag: "action",
      layout: card.actions.length === 2 ? "bisected" : card.actions.length === 3 ? "trisection" : "flow",
      actions: card.actions.map((action) => ({
        tag: "button",
        text: { tag: "plain_text", content: action.label },
        type: action.style,
        value: action.value,
        ...(action.confirm ? {
          confirm: {
            title: { tag: "plain_text", content: "请确认" },
            text: { tag: "plain_text", content: action.confirm }
          }
        } : {})
      }))
    });
  }
  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      template: card.template,
      title: { tag: "plain_text", content: card.title }
    },
    elements
  };
}
