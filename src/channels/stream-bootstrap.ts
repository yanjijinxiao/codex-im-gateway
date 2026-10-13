/** Delivery identity is not a visible-message receipt. No credentials belong here. */
export type ChannelStreamBootstrap = {
  version: 1;
  instanceId: string;
  recipientId: string;
  /** Delivered update handle; not all providers use instanceId as messageId. */
  messageId?: string;
  stage: "create-pending" | "create-rejected" | "create-unconfirmed" | "created" | "delivery-pending" | "delivery-rejected" | "delivery-unconfirmed" | "delivered";
  /** Allowlisted, non-secret routing fields interpreted only by the adapter. */
  adapterData?: Readonly<Record<string, string>>;
  failure?: ChannelStreamFailure;
};

export type ChannelStreamFailure = {
  operation: "create" | "deliver" | "update";
  code: string;
  httpStatus?: number;
  requestId?: string;
  uncertain: boolean;
};

export type ChannelStreamStartInput = {
  toUserId: string; text: string; contextToken?: string; streamId?: string;
  /** Must persist each transition before the next provider mutation. */
  onBootstrap?: (state: ChannelStreamBootstrap) => void;
};
export type ChannelStreamResumeInput = ChannelStreamStartInput & {
  streamId: string; bootstrap: ChannelStreamBootstrap;
  /** Explicit human-authorized redelivery, never enabled by background polling. */
  confirmUncertainDelivery?: boolean;
};

export function restoredBootstrap(value: ChannelStreamBootstrap): ChannelStreamBootstrap {
  const copy = structuredClone(value);
  if (copy.stage === "create-pending") copy.stage = "create-unconfirmed";
  if (copy.stage === "delivery-pending") copy.stage = "delivery-unconfirmed";
  return copy;
}
