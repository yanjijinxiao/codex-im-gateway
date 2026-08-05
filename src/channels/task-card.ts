import type { TaskboardStatus } from "../taskboard/client.js";
import type { ChannelCardAction, ChannelCardTemplate } from "./action-card.js";

export { formatChannelActionCommand, parseChannelActionValue } from "./action-card.js";
export type { ChannelActionValue, ChannelCardAction } from "./action-card.js";
export { createTaskCard } from "./task-detail-card.js";
export { createTaskFormCard } from "./task-form-card.js";
export { createTaskOverviewCard } from "./task-overview-card.js";
export { formatTaskboardStatus } from "./task-card-status.js";

export type ChannelTaskLinkAction = {
  readonly kind: "link";
  readonly label: string;
  readonly style: "default" | "primary" | "danger";
  readonly url: string;
};

export type ChannelTaskCommandAction = ChannelCardAction & {
  readonly kind: "command";
};

export type ChannelTaskAction = ChannelTaskCommandAction | ChannelTaskLinkAction;

type ChannelTaskCardBase = {
  readonly title: string;
  readonly template: ChannelCardTemplate;
  readonly projectName: string;
  readonly identifier: string;
  readonly actions: readonly ChannelTaskAction[];
  readonly fallbackText: string;
  readonly taskboardUrl?: string;
};

export type ChannelTaskOverviewItem = {
  readonly identifier: string;
  readonly title: string;
  readonly statusLabel: string;
  readonly priorityLabel: string;
  readonly updatedLabel: string;
  readonly action: ChannelTaskCommandAction;
};

export type ChannelTaskOverviewCard = ChannelTaskCardBase & {
  readonly kind: "overview";
  readonly filter: TaskboardOverviewFilter;
  readonly filterLabel: string;
  readonly counts: Readonly<Record<"todo" | "in_progress" | "in_review" | "blocked", number>>;
  readonly items: readonly ChannelTaskOverviewItem[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly filterActions: readonly ChannelTaskCommandAction[];
  readonly pageActions: readonly ChannelTaskCommandAction[];
};

export type ChannelTaskDetailCard = ChannelTaskCardBase & {
  readonly kind: "detail";
  readonly statusLabel: string;
  readonly summary: string;
  readonly priorityLabel: string;
  readonly labels: readonly string[];
  readonly updatedLabel: string;
  readonly description?: string;
  readonly latestComment?: string;
  readonly note?: string;
};

export type ChannelTaskTextField = {
  readonly kind: "text";
  readonly name: string;
  readonly label: string;
  readonly placeholder: string;
  readonly required: boolean;
  readonly maximumLength: number;
  readonly multiline: boolean;
  readonly defaultValue?: string;
};

export type ChannelTaskSelectField = {
  readonly kind: "select";
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly initialOption?: string;
  readonly options: readonly { readonly label: string; readonly value: string }[];
};

export type ChannelTaskFormField = ChannelTaskTextField | ChannelTaskSelectField;

export type ChannelTaskFormCard = ChannelTaskCardBase & {
  readonly kind: "form";
  readonly body: string;
  readonly formName: string;
  readonly fields: readonly ChannelTaskFormField[];
  readonly submitActions: readonly ChannelTaskCommandAction[];
};

export type ChannelTaskCard = ChannelTaskOverviewCard | ChannelTaskDetailCard | ChannelTaskFormCard;

export type TaskboardOverviewFilter = "active" | TaskboardStatus;
