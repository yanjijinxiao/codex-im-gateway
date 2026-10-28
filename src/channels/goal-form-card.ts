import type { ChannelTaskFormCard } from "./task-card.js";
import { copyBlock } from "./copyable.js";

export function createGoalFormCard(projectName: string): ChannelTaskFormCard {
  return {
    kind: "form",
    title: "设置 Codex 目标",
    template: "blue",
    projectName,
    identifier: "goal:set",
    body: "在卡片中填写目标并直接提交。目标会绑定到当前 Codex 会话。",
    formName: "codex_goal",
    fields: [{
      kind: "text",
      name: "objective",
      label: "目标",
      placeholder: "描述希望 Codex 持续完成的结果",
      required: true,
      maximumLength: 2_000,
      multiline: true
    }],
    submitActions: [{
      kind: "command",
      label: "设置目标",
      style: "primary",
      value: {
        version: 3,
        command: "goal",
        arg: "set",
        field: { name: "objective", required: true, maximumLength: 2_000 }
      }
    }],
    actions: [{
      kind: "command",
      label: "返回工作模式",
      style: "default",
      value: { version: 1, command: "mode", arg: "" }
    }],
    fallbackText: `文字模式：把“目标内容”替换为实际目标后发送以下模板。\n\n${copyBlock("/goal set 目标内容")}`
  };
}
