import type { ChannelActionCard, ChannelCardAction } from "./action-card.js";
import { feishuTableCard, type FeishuTableCardPayload } from "./feishu-table-card.js";
import type { FeishuButton, FeishuElement, FeishuTaskCardPayload } from "./feishu-task-card-types.js";

export function feishuActionCard(card: ChannelActionCard): FeishuTaskCardPayload | FeishuTableCardPayload {
  if (card.table?.rows.length) return feishuTableCard(card);
  const elements: FeishuElement[] = [{
    tag: "div",
    text: { tag: "lark_md", content: card.body }
  }];
  if (card.note) {
    elements.push({ tag: "note", elements: [{ tag: "plain_text", content: card.note }] });
  }
  if (card.form) elements.push({ tag: "form", name: "codex_question", elements: [
    { tag: "input", name: card.form.name, required: true, placeholder: { tag: "plain_text", content: "请输入回答" },
      label: { tag: "plain_text", content: card.form.label }, label_position: "top", max_length: card.form.maximumLength,
      input_type: "multiline_text", rows: 3, auto_resize: true, max_rows: 6 },
    { ...feishuButton(card.form.submit), action_type: "form_submit", name: "submit_answer", value: card.form.submit.value }
  ] });
  for (const actions of card.actionGroups) {
    elements.push({
      tag: "action",
      layout: actionLayout(actions.length),
      actions: actions.map(feishuButton)
    });
  }
  return {
    config: { wide_screen_mode: true, enable_forward: true, update_multi: true },
    header: {
      template: card.template,
      title: { tag: "plain_text", content: card.title }
    },
    elements
  };
}

function feishuButton(action: ChannelCardAction): FeishuButton {
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
