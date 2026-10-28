import type {
  ChannelTaskAction,
  ChannelTaskCard,
  ChannelTaskCommandAction,
  ChannelTaskFormField
} from "./task-card.js";
import type {
  FeishuButton,
  FeishuElement,
  FeishuFormField,
  FeishuFormSubmitButton,
  FeishuTaskCardPayload
} from "./feishu-task-card-types.js";

export type { FeishuTaskCardPayload } from "./feishu-task-card-types.js";

export function feishuTaskCard(card: ChannelTaskCard): FeishuTaskCardPayload {
  const elements = elementsFor(card);
  return {
    config: { wide_screen_mode: true, enable_forward: true, update_multi: true },
    header: {
      template: card.template,
      title: { tag: "plain_text", content: card.title }
    },
    elements,
    ...(card.taskboardUrl && card.kind !== "form" ? { card_link: { url: card.taskboardUrl } } : {})
  };
}

function elementsFor(card: ChannelTaskCard): readonly FeishuElement[] {
  switch (card.kind) {
    case "overview":
      return overviewElements(card);
    case "detail":
      return detailElements(card);
    case "form":
      return formElements(card);
    default:
      return assertNever(card);
  }
}

function overviewElements(card: Extract<ChannelTaskCard, { readonly kind: "overview" }>): readonly FeishuElement[] {
  const elements: FeishuElement[] = [{
    tag: "div",
    text: { tag: "lark_md", content: `**${card.filterLabel}** · 第 ${card.page}/${card.pageCount} 页 · ${card.total} 项` },
    fields: [
      { is_short: true, text: { tag: "lark_md", content: `**待处理** ${card.counts.todo}` } },
      { is_short: true, text: { tag: "lark_md", content: `**处理中** ${card.counts.in_progress}` } },
      { is_short: true, text: { tag: "lark_md", content: `**待验收** ${card.counts.in_review}` } },
      { is_short: true, text: { tag: "lark_md", content: `**阻塞** ${card.counts.blocked}` } }
    ]
  }, actionElement(card.filterActions), { tag: "hr" }];
  if (!card.items.length) {
    elements.push({ tag: "div", text: { tag: "plain_text", content: "当前筛选下没有任务。" } });
  }
  for (const item of card.items) {
    elements.push({
      tag: "div",
      text: {
        tag: "plain_text",
        content: `${item.identifier} · ${item.title}\n${item.statusLabel} · 优先级 ${item.priorityLabel} · 更新 ${item.updatedLabel}`
      },
      extra: commandButton(item.action)
    });
  }
  if (card.pageActions.length) elements.push(actionElement(card.pageActions));
  elements.push(actionElement(card.actions));
  return elements;
}

function detailElements(card: Extract<ChannelTaskCard, { readonly kind: "detail" }>): readonly FeishuElement[] {
  const elements: FeishuElement[] = [{
    tag: "div",
    text: { tag: "plain_text", content: card.summary },
    fields: [
      { is_short: true, text: { tag: "plain_text", content: `项目\n${card.projectName}` } },
      { is_short: true, text: { tag: "plain_text", content: `状态\n${card.statusLabel}` } },
      { is_short: true, text: { tag: "plain_text", content: `优先级\n${card.priorityLabel}` } },
      { is_short: true, text: { tag: "plain_text", content: `更新时间\n${card.updatedLabel}` } }
    ]
  }];
  if (card.labels.length) elements.push({ tag: "note", elements: [{ tag: "plain_text", content: `标签：${card.labels.join("、")}` }] });
  if (card.description) elements.push({ tag: "div", text: { tag: "plain_text", content: `说明：${card.description}` } });
  if (card.latestComment) elements.push({ tag: "div", text: { tag: "plain_text", content: `最新记录：${card.latestComment}` } });
  if (card.note) elements.push({ tag: "note", elements: [{ tag: "plain_text", content: card.note }] });
  for (const actions of groupActions(card.actions)) elements.push(actionElement(actions));
  return elements;
}

function formElements(card: Extract<ChannelTaskCard, { readonly kind: "form" }>): readonly FeishuElement[] {
  const formElements: Array<FeishuFormField | FeishuFormSubmitButton> = card.fields.map(feishuFormField);
  formElements.push(...card.submitActions.map((action, index) => ({
    ...commandButton(action),
    action_type: "form_submit" as const,
    name: `submit_${index + 1}`,
    value: action.value
  })));
  const elements: FeishuElement[] = [
    { tag: "div", text: { tag: "plain_text", content: card.body } },
    { tag: "form", name: card.formName, elements: formElements }
  ];
  for (const actions of groupActions(card.actions)) elements.push(actionElement(actions));
  return elements;
}

function feishuFormField(field: ChannelTaskFormField): FeishuFormField {
  switch (field.kind) {
    case "text":
      return {
        tag: "input",
        name: field.name,
        required: field.required,
        placeholder: { tag: "plain_text", content: field.placeholder },
        label: { tag: "plain_text", content: field.label },
        label_position: "top",
        max_length: field.maximumLength,
        input_type: field.multiline ? "multiline_text" : "text",
        ...(field.multiline ? { rows: 3, auto_resize: true, max_rows: 6 } : {}),
        ...(field.defaultValue ? { default_value: field.defaultValue } : {})
      };
    case "select":
      return {
        tag: "select_static",
        name: field.name,
        required: field.required,
        placeholder: { tag: "plain_text", content: field.label },
        options: field.options.map((option) => ({
          text: { tag: "plain_text", content: option.label },
          value: option.value
        })),
        ...(field.initialOption ? { initial_option: field.initialOption } : {})
      };
    default:
      return assertNever(field);
  }
}

function actionElement(actions: readonly ChannelTaskAction[]): FeishuElement {
  return {
    tag: "action",
    layout: actions.length === 2 ? "bisected" : actions.length === 3 ? "trisection" : "flow",
    actions: actions.map(feishuButton)
  };
}

function feishuButton(action: ChannelTaskAction): FeishuButton {
  switch (action.kind) {
    case "command":
      return commandButton(action);
    case "link":
      return { tag: "button", text: { tag: "plain_text", content: action.label }, type: action.style, url: action.url };
    default:
      return assertNever(action);
  }
}

function commandButton(action: ChannelTaskCommandAction): FeishuButton {
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

function groupActions(actions: readonly ChannelTaskAction[]): readonly (readonly ChannelTaskAction[])[] {
  const groups: ChannelTaskAction[][] = [];
  for (const action of actions) {
    let current = groups.at(-1);
    if (!current || current.length === 3) {
      current = [];
      groups.push(current);
    }
    current.push(action);
  }
  return groups;
}

function assertNever(value: never): never {
  throw new UnexpectedTaskCardValueError(value);
}

class UnexpectedTaskCardValueError extends Error {
  readonly name = "UnexpectedTaskCardValueError";
  constructor(readonly value: never) {
    super("Task card value was not handled exhaustively");
  }
}
