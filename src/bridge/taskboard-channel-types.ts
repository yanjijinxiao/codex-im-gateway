import type { ChannelTaskCard, TaskboardOverviewFilter } from "../channels/task-card.js";
import type { RuntimeStateStore } from "../state/runtime-state.js";
import type { TaskboardClient, TaskboardIssue } from "../taskboard/client.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { TaskboardChannelContext } from "./taskboard-channel-context.js";

export type TaskboardChannelControllerOptions = {
  readonly client?: TaskboardClient;
  readonly stateStore: RuntimeStateStore;
  readonly replyText: (senderId: string, text: string) => Promise<void>;
  readonly sendCard: (message: NormalizedWeixinMessage, card: ChannelTaskCard) => Promise<void>;
  readonly runWorkflow: (message: NormalizedWeixinMessage, instruction: string) => Promise<void>;
  readonly attachmentPaths: (message: NormalizedWeixinMessage) => Promise<readonly string[] | undefined>;
};

export type TaskboardOverviewInput = {
  readonly message: NormalizedWeixinMessage;
  readonly context: TaskboardChannelContext;
  readonly filter: TaskboardOverviewFilter;
  readonly page: number;
};

export type TaskboardShowIssueInput = {
  readonly message: NormalizedWeixinMessage;
  readonly context: TaskboardChannelContext;
  readonly issue: TaskboardIssue;
  readonly note?: string;
  readonly knownLatestComment?: string;
};
