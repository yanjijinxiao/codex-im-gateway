import crypto from "node:crypto";

import type { ChannelActionValue, ChannelCardAction } from "./action-card.js";
import type {
  ChannelTaskCommandAction,
  ChannelTaskLinkAction
} from "./task-card.js";

type CommandActionInput = {
  readonly label: string;
  readonly arg: string;
  readonly style?: ChannelCardAction["style"];
  readonly confirm?: string;
};

type FormActionInput = Omit<CommandActionInput, "arg"> & {
  readonly parameters: Omit<Extract<ChannelActionValue, { readonly version: 2 }>["parameters"], "request_id">;
  readonly fields?: readonly {
    readonly name: string;
    readonly parameter: Extract<ChannelActionValue, { readonly version: 2 }>["fields"][number]["parameter"];
    readonly required: boolean;
    readonly maximumLength: number;
  }[];
};

export function taskCommandAction(input: CommandActionInput): ChannelTaskCommandAction {
  return {
    kind: "command",
    label: input.label,
    style: input.style ?? "default",
    value: { version: 1, command: "task", arg: input.arg },
    ...(input.confirm ? { confirm: input.confirm } : {})
  };
}

export function taskFormAction(input: FormActionInput): ChannelTaskCommandAction {
  return {
    kind: "command",
    label: input.label,
    style: input.style ?? "default",
    value: {
      version: 2,
      command: "task",
      arg: "submit",
      parameters: { ...input.parameters, request_id: crypto.randomUUID() },
      fields: [...(input.fields ?? [])]
    },
    ...(input.confirm ? { confirm: input.confirm } : {})
  };
}

export function taskLinkAction(label: string, url: string): ChannelTaskLinkAction {
  return { kind: "link", label, style: "default", url };
}

export function taskboardDeepLink(
  baseUrl: string,
  projectId: string,
  identifier?: string
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("project", projectId);
  if (identifier) url.searchParams.set("issue", identifier);
  return url.toString();
}

export function cleanTaskCardText(value: string | undefined, maximumLength: number): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}
