import type * as Lark from "@larksuiteoapi/node-sdk";

import type { ChannelActionCard, ChannelCardAction } from "./action-card.js";

export function feishuActionCard(card: ChannelActionCard): Lark.InteractiveCard {
  const elements: Lark.InteractiveCardElement[] = [{
    tag: "div",
    text: { tag: "lark_md", content: card.body }
  }];
  if (card.note) {
    elements.push({ tag: "note", elements: [{ tag: "plain_text", content: card.note }] });
  }
  for (const actions of card.actionGroups) {
    elements.push({
      tag: "action",
      layout: actionLayout(actions.length),
      actions: actions.map(feishuButton)
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

function feishuButton(action: ChannelCardAction): Lark.InteractiveCardActionItem {
  return {
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
  };
}

function actionLayout(actionCount: number): "bisected" | "trisection" | "flow" {
  if (actionCount === 2) return "bisected";
  if (actionCount === 3) return "trisection";
  return "flow";
}
