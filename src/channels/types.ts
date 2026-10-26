import type { AttachmentKind, ChannelAttachment, ChannelMessage } from "./message.js";
import type { ChannelActionCard } from "./action-card.js";
import type { ChannelTaskCard } from "./task-card.js";
import type { ChannelTableLayout } from "./table.js";
import type { ChannelStreamStartInput, ChannelStreamResumeInput } from "./stream-bootstrap.js";
import type { TurnActivity } from "./turn-status.js";

export type ChannelDeliveryPart = { messageId: string; text: string };
export type ChannelReceipt = { messageId: string; parts?: ChannelDeliveryPart[] };
export type ChannelTextInput = { toUserId: string; text: string; contextToken?: string };
export type ChannelMention = { userId: string; name?: string };
/** Trusted view regions, never recovered by parsing model-authored Markdown.
 * A native stream cursor belongs to body; interactive/static widgets to footer. */
export type ChannelProgressLayout = { body: string; footer: string };
/** Provider-confirmed public conversation metadata, never inferred from IDs or session titles. */
export type ChannelConversationIdentity = { kind: "direct" | "group"; name?: string };
/** Trusted application intent, not part of model-authored card content. */
export type ChannelActionCardInput = { toUserId: string; card: ChannelActionCard; contextToken?: string;
  mentions?: readonly ChannelMention[] };
/** Trusted delivery context, never parsed from model text. The source card is
 * already fully acknowledged; retain it if the combined result is uncertain. */
export type ChannelCompletedCard = { messageId: string; text: string; summary: string };
export type ChannelMentionInput = ChannelTextInput & {
  mentions: readonly ChannelMention[];
  completedCard?: ChannelCompletedCard;
};

export type ChannelTextClient = {
  conversationIdentity?(recipientId: string): ChannelConversationIdentity | undefined;
  /** Pure routing preflight; no provider calls and no guessed recipient type. */
  deliveryRouteStatus?(recipientId: string): "available" | "unconfirmed";
  /** Legacy transport boundary. Production consumers receive a ChannelClient. */
  capabilities?: ChannelCapabilities;
  /** Can update an existing stream using only its persisted message ID. */
  resumableTextStream?: boolean;
  sendText(input: ChannelTextInput): Promise<{ messageId: string }>;
  /** Native directed notification. Never parsed from model text. */
  sendMentionNotification?(input: ChannelMentionInput): Promise<ChannelReceipt>;
  /** Pure preflight, before freezing a delivery plan. Includes provider markup
   * overhead; false preserves the acknowledged result and uses a short notice. */
  canCombineCompletionMentionCard?(input: { completedCard: ChannelCompletedCard; mentions: readonly ChannelMention[] }): boolean;
  /** Plain delivery for native text progress or a terminal error notice; never create an AI Card. */
  sendProgressText?(input: ChannelTextInput): Promise<{ messageId: string }>;
  /** Repeated starts with the same streamId must target the same logical card. */
  startTextStream?(input: ChannelStreamStartInput): Promise<{ messageId: string }>;
  /** Resume a known instance without issuing another create request. */
  resumeTextStream?(input: ChannelStreamResumeInput): Promise<{ messageId: string }>;
  updateTextStream?(input: {
    toUserId: string;
    messageId: string;
    text: string;
    finalize?: boolean;
    error?: boolean;
    /** Trusted task activity; adapters must not infer loading from body text. */
    activity?: TurnActivity;
    progressLayout?: ChannelProgressLayout;
  }): Promise<void>;
  sendImage?(input: { toUserId: string; path: string }): Promise<{ messageId: string }>;
  sendActionCard?(input: ChannelActionCardInput): Promise<ChannelReceipt>;
  updateActionCard?(input: { messageId: string; card: ChannelActionCard }): Promise<void>;
  sendTaskCard?(input: { toUserId: string; card: ChannelTaskCard; contextToken?: string }): Promise<ChannelReceipt>;
  updateTaskCard?(input: { messageId: string; card: ChannelTaskCard }): Promise<void>;
  sendTyping?(input: { toUserId: string; contextToken?: string; typing?: boolean }): Promise<void>;
  sendMedia?(input: ChannelMediaInput): Promise<{ messageId: string }>;
  resolveAttachments?(message: ChannelMessage): Promise<ChannelAttachment[]>;
  /** Fetch quoted-message resources only after the Bridge access check. */
  resolveReferences?(message: ChannelMessage): Promise<ChannelMessage>;
};

export type Capability = "available" | "not-configured" | "not-implemented" | "unsupported";
export type ChannelCapabilities = {
  readonly mentions?: Capability;
  readonly mentionBatchSize?: number;
  /** Initial card/question delivery can include native @ in the same message. */
  readonly actionCardMentions?: Capability;
  /** Can deliver the result and native mentions together, then summarize the source card. */
  readonly completionMentionCard?: Capability;
  /** Conservative UTF-8 budget for each complete-result page. */
  readonly resultPageBytes?: number;
  /** Presentation supported by this adapter, independent of actionable buttons. */
  readonly tableLayout: ChannelTableLayout;
  readonly inbound: Readonly<Record<AttachmentKind, Capability>>;
  readonly outbound: Readonly<Record<AttachmentKind, Capability>>;
  readonly progress: Capability;
  /** Trusted, persistent task-state heading above progress and result bodies. */
  readonly turnStatusHeader?: Capability;
  readonly progressFooter?: Capability;
  readonly resumableProgress: boolean;
  readonly streamBootstrapRecovery?: Capability;
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
