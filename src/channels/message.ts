/** Channel-neutral inbound envelope. senderId is always the human, never a group. */
export type ChannelMessage = {
  id: string;
  senderId: string;
  /** Conversation used for replies and session bindings; defaults to senderId in a DM. */
  replyTargetId?: string;
  source?: "native-menu";
  contextToken?: string;
  interaction?: { readonly kind: "card"; readonly messageId: string };
  text: string;
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
};
