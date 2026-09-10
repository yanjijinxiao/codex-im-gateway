import type { AttachmentKind, ChannelAttachment, ChannelMessage } from "./message.js";
import type { ChannelActionCard } from "./action-card.js";
import type { ChannelTaskCard } from "./task-card.js";
import type { ChannelTableLayout } from "./table.js";

export type ChannelDeliveryPart = { messageId: string; text: string };
export type ChannelReceipt = { messageId: string; parts?: ChannelDeliveryPart[] };

export type ChannelTextClient = {
  /** Legacy transport boundary. Production consumers receive a ChannelClient. */
  capabilities?: ChannelCapabilities;
  /** Can update an existing stream using only its persisted message ID. */
  resumableTextStream?: boolean;
  sendText(input: { toUserId: string; text: string; contextToken?: string }): Promise<{ messageId: string }>;
  startTextStream?(input: { toUserId: string; text: string; contextToken?: string }): Promise<{ messageId: string }>;
  updateTextStream?(input: {
    toUserId: string;
    messageId: string;
    text: string;
    finalize?: boolean;
    error?: boolean;
  }): Promise<void>;
  sendImage?(input: { toUserId: string; path: string }): Promise<{ messageId: string }>;
  sendActionCard?(input: { toUserId: string; card: ChannelActionCard; contextToken?: string }): Promise<ChannelReceipt>;
  updateActionCard?(input: { messageId: string; card: ChannelActionCard }): Promise<void>;
  sendTaskCard?(input: { toUserId: string; card: ChannelTaskCard; contextToken?: string }): Promise<ChannelReceipt>;
  updateTaskCard?(input: { messageId: string; card: ChannelTaskCard }): Promise<void>;
  sendTyping?(input: { toUserId: string; contextToken?: string; typing?: boolean }): Promise<void>;
  sendMedia?(input: ChannelMediaInput): Promise<{ messageId: string }>;
  resolveAttachments?(message: ChannelMessage): Promise<ChannelAttachment[]>;
};

export type Capability = "available" | "not-configured" | "not-implemented" | "unsupported";
export type ChannelCapabilities = {
  /** Presentation supported by this adapter, independent of actionable buttons. */
  readonly tableLayout: ChannelTableLayout;
  readonly inbound: Readonly<Record<AttachmentKind, Capability>>;
  readonly outbound: Readonly<Record<AttachmentKind, Capability>>;
  readonly progress: Capability;
  readonly resumableProgress: boolean;
  readonly actions: Capability;
  readonly tasks: Capability;
  readonly cardUpdates: Capability;
  readonly typing: Capability;
};
export type ChannelMediaInput = { toUserId: string; path: string; kind: AttachmentKind; contextToken?: string };

/** The complete gateway-facing interface; unavailable operations fail explicitly. */
export type ChannelClient = Required<Omit<ChannelTextClient, "sendImage">> & {
  readonly channel: "weixin" | "dingtalk" | "feishu" | "wecom" | "generic";
};

export type ChannelConnectionStatus = {
  readonly state: "connecting" | "connected" | "reconnecting" | "stopped" | "error";
  /** Safe status, not raw SDK errors which can include credentials. */
  readonly detail?: string;
};

export type ChannelMonitorOptions = {
  signal?: AbortSignal;
  checkpoint?: string;
  onCheckpoint?: (checkpoint: string) => Promise<void> | void;
  onStatus?: (status: ChannelConnectionStatus) => void;
  claimMessage?: (message: ChannelMessage) => boolean;
  onMessage: (message: ChannelMessage) => Promise<void>;
  onMessageError?: (error: unknown, message: ChannelMessage) => Promise<void> | void;
};

export type ChannelAdapter = {
  client: ChannelClient;
  monitor(options: ChannelMonitorOptions): Promise<void>;
};
