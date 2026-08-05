import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { ChannelActionCard } from "./action-card.js";
import type { ChannelTaskCard } from "./task-card.js";

export type ChannelTextClient = {
  sendText(input: { toUserId: string; text: string; contextToken?: string }): Promise<{ messageId: string }>;
  sendImage?(input: { toUserId: string; path: string }): Promise<{ messageId: string }>;
  sendActionCard?(input: { toUserId: string; card: ChannelActionCard }): Promise<{ messageId: string }>;
  sendTaskCard?(input: { toUserId: string; card: ChannelTaskCard }): Promise<{ messageId: string }>;
  updateTaskCard?(input: { messageId: string; card: ChannelTaskCard }): Promise<void>;
  sendTyping?(input: { toUserId: string; contextToken?: string; typing?: boolean }): Promise<void>;
};

export type ChannelMonitorOptions = {
  signal?: AbortSignal;
  claimMessage?: (message: NormalizedWeixinMessage) => boolean;
  onMessage: (message: NormalizedWeixinMessage) => Promise<void>;
  onMessageError?: (error: unknown, message: NormalizedWeixinMessage) => Promise<void> | void;
};

export type ChannelAdapter = {
  client: ChannelTextClient;
  monitor(options: ChannelMonitorOptions): Promise<void>;
};
