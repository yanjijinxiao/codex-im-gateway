import type { ChannelTaskCard, TaskboardOverviewFilter } from "../channels/task-card.js";
import type { RuntimeStateStore } from "../state/runtime-state.js";
import type { TaskboardClient, TaskboardIssue } from "../taskboard/client.js";
import type { ChannelMessage } from "../channels/message.js";
import type { TaskboardChannelContext } from "./taskboard-channel-context.js";

export type TaskboardChannelControllerOptions = {
  readonly client?: TaskboardClient;
  readonly stateStore: RuntimeStateStore;
  readonly replyText: (senderId: string, text: string) => Promise<void>;
  readonly sendCard: (message: ChannelMessage, card: ChannelTaskCard) => Promise<void>;
  readonly runWorkflow: (message: ChannelMessage, instruction: string) => Promise<void>;
  readonly attachmentPaths: (message: ChannelMessage) => Promise<readonly string[] | undefined>;
};

export type TaskboardOverviewInput = {
  readonly message: ChannelMessage;
  readonly context: TaskboardChannelContext;
  readonly filter: TaskboardOverviewFilter;
  readonly page: number;
};

export type TaskboardShowIssueInput = {
  readonly message: ChannelMessage;
  readonly context: TaskboardChannelContext;
  readonly issue: TaskboardIssue;
  readonly note?: string;
  readonly knownLatestComment?: string;
};
