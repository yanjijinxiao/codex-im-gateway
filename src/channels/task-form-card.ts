import type { TaskboardIssue } from "../taskboard/client.js";
import type { ChannelFormParameter } from "./action-card.js";
import {
  taskboardDeepLink,
  taskCommandAction,
  taskFormAction,
  taskLinkAction
} from "./task-card-actions.js";
import type {
  ChannelTaskFormCard,
  ChannelTaskFormField
} from "./task-card.js";

type FormBase = {
  readonly projectName: string;
  readonly projectId: string;
  readonly taskboardBaseUrl: string;
  readonly prefill?: string;
};

export type CreateTaskFormCardInput = FormBase & (
  | { readonly form: "new" | "todo" }
  | { readonly form: "comment" | "block" | "review" | "return"; readonly issue: TaskboardIssue }
);

export function createTaskFormCard(input: CreateTaskFormCardInput): ChannelTaskFormCard {
  switch (input.form) {
    case "new":
    case "todo":
      return createIssueForm(input);
    case "comment":
    case "block":
    case "review":
    case "return":
      return createWorkflowForm(input);
    default:
      return assertNever(input);
  }
}

function createIssueForm(input: FormBase & { readonly form: "new" | "todo" }): ChannelTaskFormCard {
  const fields: readonly ChannelTaskFormField[] = [
    textField({ name: "title", label: "任务标题", placeholder: "输入要完成的事项", required: true, maximumLength: 200, defaultValue: input.prefill }),
    textField({ name: "description", label: "任务说明", placeholder: "补充目标、范围或验收条件", required: false, maximumLength: 1_000, multiline: true }),
    {
      kind: "select",
      name: "priority",
      label: "优先级",
      required: true,
      initialOption: "none",
      options: [
        { label: "未设置", value: "none" },
        { label: "低", value: "low" },
        { label: "中", value: "medium" },
        { label: "高", value: "high" },
        { label: "紧急", value: "urgent" }
      ]
    },
    textField({ name: "labels", label: "标签", placeholder: "多个标签用逗号分隔", required: false, maximumLength: 500 })
  ];
  const bindings = fields.map((field) => ({
    name: field.name,
    parameter: formParameter(field.name),
    required: field.required,
    maximumLength: field.kind === "text" ? field.maximumLength : 32
  }));
  const todo = taskFormAction({
    label: "仅记待办",
    style: input.form === "todo" ? "primary" : "default",
    parameters: { operation: "create_todo" },
    fields: bindings
  });
  const submitActions = input.form === "todo" ? [todo] : [
    todo,
    taskFormAction({
      label: "创建并开始",
      style: "primary",
      parameters: { operation: "create_start" },
      fields: bindings,
      confirm: "确认创建任务并立即交给 Codex 开始处理？"
    })
  ];
  const taskboardUrl = taskboardDeepLink(input.taskboardBaseUrl, input.projectId);
  return {
    kind: "form",
    title: input.form === "todo" ? "新建待办" : "新建任务",
    template: "blue",
    projectName: input.projectName,
    identifier: `form:${input.form}`,
    body: "填写后直接提交；无需再发送文字命令。",
    formName: `task_${input.form}`,
    fields,
    submitActions,
    actions: [
      taskCommandAction({ label: "取消", arg: "list" }),
      taskLinkAction("打开完整面板", taskboardUrl)
    ],
    fallbackText: `请发送 /task ${input.form === "todo" ? "todo" : "new"} 任务标题。`,
    taskboardUrl
  };
}

function createWorkflowForm(
  input: FormBase & { readonly form: "comment" | "block" | "review" | "return"; readonly issue: TaskboardIssue }
): ChannelTaskFormCard {
  const config = WORKFLOW_FORMS[input.form];
  const field = textField({
    name: "body",
    label: config.label,
    placeholder: config.placeholder,
    required: true,
    maximumLength: 1_000,
    multiline: true,
    defaultValue: input.prefill
  });
  const submit = taskFormAction({
    label: config.submitLabel,
    style: config.style,
    parameters: {
      operation: input.form,
      identifier: input.issue.identifier,
      version: String(input.issue.version)
    },
    fields: [{ name: field.name, parameter: "body", required: true, maximumLength: field.maximumLength }],
    ...("confirm" in config ? { confirm: config.confirm } : {})
  });
  const taskboardUrl = taskboardDeepLink(input.taskboardBaseUrl, input.projectId, input.issue.identifier);
  return {
    kind: "form",
    title: `${input.issue.identifier} · ${config.title}`,
    template: config.template,
    projectName: input.projectName,
    identifier: input.issue.identifier,
    body: input.issue.title,
    formName: `task_${input.form}_${input.issue.version}`,
    fields: [field],
    submitActions: [submit],
    actions: [
      taskCommandAction({ label: "取消", arg: `detail ${input.issue.identifier}` }),
      taskLinkAction("打开完整面板", taskboardUrl)
    ],
    fallbackText: `请发送 /task ${input.form} ${input.issue.identifier} ${config.placeholder}`,
    taskboardUrl
  };
}

type TextFieldInput = Omit<Extract<ChannelTaskFormField, { readonly kind: "text" }>, "kind" | "multiline"> & {
  readonly multiline?: boolean;
};

function textField(input: TextFieldInput): Extract<ChannelTaskFormField, { readonly kind: "text" }> {
  return { kind: "text", ...input, multiline: input.multiline ?? false };
}

function formParameter(name: string): ChannelFormParameter {
  switch (name) {
    case "title":
    case "description":
    case "priority":
    case "labels":
    case "body":
      return name;
    default:
      throw new UnexpectedTaskFormFieldError(name);
  }
}

function assertNever(value: never): never {
  throw new UnexpectedTaskFormError(value);
}

class UnexpectedTaskFormError extends Error {
  readonly name = "UnexpectedTaskFormError";
  constructor(readonly value: never) {
    super("Task form was not handled exhaustively");
  }
}

class UnexpectedTaskFormFieldError extends Error {
  readonly name = "UnexpectedTaskFormFieldError";
  constructor(readonly fieldName: string) {
    super(`Unexpected Taskboard form field: ${fieldName}`);
  }
}

const WORKFLOW_FORMS = {
  comment: {
    title: "添加进展", label: "进展内容", placeholder: "记录当前进展或验证结果", submitLabel: "添加进展",
    style: "primary", template: "blue"
  },
  block: {
    title: "标记阻塞", label: "阻塞原因", placeholder: "说明阻塞原因及解除条件", submitLabel: "确认阻塞",
    style: "danger", template: "red", confirm: "确认将该任务标记为阻塞？"
  },
  review: {
    title: "提交验收", label: "验收证据", placeholder: "填写测试、构建或运行验证结果", submitLabel: "提交验收",
    style: "primary", template: "orange", confirm: "确认已完成验证并提交验收？"
  },
  return: {
    title: "退回处理中", label: "退回原因", placeholder: "说明未通过项及需要补充的内容", submitLabel: "确认退回",
    style: "danger", template: "red", confirm: "确认将该任务退回处理中？"
  }
} as const;
