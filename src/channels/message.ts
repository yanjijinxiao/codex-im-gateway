/** Channel-neutral inbound envelope. senderId is always the human, never a group. */
export type ChannelMessage = {
  id: string;
  senderId: string;
  /** Only a provider-confirmed group-member identity; absent in DMs/unsupported transports. */
  mention?: import("./types.js").ChannelMention;
  /** Conversation used for replies and session bindings; defaults to senderId in a DM. */
  replyTargetId?: string;
  /** Provider-confirmed context only. Absence must not be inferred to be a DM. */
  conversationKind?: "direct" | "group";
  source?: "native-menu";
  contextToken?: string;
  interaction?: { readonly kind: "card"; readonly messageId: string };
  text: string;
  /** Quoted content is context/data, never an executable slash command. */
  references?: ChannelReference[];
  /** Known message received, but this adapter cannot decode that format yet. */
  unsupportedMessageType?: string;
  attachments: ChannelAttachment[];
  /** Opaque transport data. Only the originating adapter may interpret it. */
  raw: Record<string, unknown>;
};

export type AttachmentKind = "image" | "file" | "video" | "audio";
export type ChannelAttachment = {
  kind: AttachmentKind;
  label: string;
  item: Record<string, unknown>;
  path?: string;
  sourceMessageId?: string;
};

export type ChannelReference = {
  messageId?: string;
  senderId?: string;
  type: string;
  text?: string;
  attachments: ChannelAttachment[];
  availability: "available" | "metadata-only" | "unavailable";
  reason?: string;
};
