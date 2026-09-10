export class ChannelCapabilityError extends Error {
  readonly name = "ChannelCapabilityError";
  constructor(readonly channel: string, readonly capability: string, readonly reason: string) {
    super(`${channel}: ${capability} ${reason}`);
  }
}

/** No acknowledgement must be invented when delivery failed or is uncertain. */
export class ChannelDeliveryError extends Error {
  readonly name = "ChannelDeliveryError";
  constructor(readonly channel: string, readonly operation: string, readonly code?: string | number) {
    super(`${channel} ${operation} failed${code !== undefined ? ` (code ${code})` : " (missing acknowledgement)"}`);
  }
}

export class ChannelContextExpiredError extends Error {
  readonly name = "ChannelContextExpiredError";
  constructor() { super("Channel reply context expired; a new inbound message is required"); }
}

export class ChannelPartialDeliveryError extends Error {
  readonly name = "ChannelPartialDeliveryError";
  constructor(readonly delivered: import("./types.js").ChannelDeliveryPart[], cause: unknown) {
    super("Channel text fallback failed; already acknowledged parts must not be resent", { cause });
  }
}

export class InboundMediaTooLargeError extends Error {
  readonly name = "InboundMediaTooLargeError";
  constructor(readonly maxBytes: number, readonly actualBytes?: number) {
    super(`Inbound media exceeds max size ${maxBytes} bytes`);
  }
}
