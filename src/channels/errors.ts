import type { ChannelStreamFailure } from "./stream-bootstrap.js";

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

/** Transport-neutral recovery policy, optionally retaining an acknowledged card. */
export class ChannelProgressError extends Error {
  readonly name = "ChannelProgressError";
  constructor(readonly retryable: boolean, readonly messageId?: string, readonly retryAfterMs?: number, cause?: unknown,
    /** Adapter opt-in: a route-dependent rejection may be probed on an existing card only. */
    readonly recoveryProbe = false, readonly diagnostic?: ChannelStreamFailure) {
    super(retryable ? "Channel progress temporarily unavailable" : "Channel progress unavailable", { cause });
  }
}

export function channelProgressError(error: unknown, messageId?: string): ChannelProgressError {
  if (error instanceof ChannelProgressError) {
    return messageId && !error.messageId
      ? new ChannelProgressError(error.retryable, messageId, error.retryAfterMs, error, error.recoveryProbe, error.diagnostic)
      : error;
  }
  if (error instanceof ChannelCapabilityError || error instanceof ChannelContextExpiredError || error instanceof ChannelDeliveryError) {
    return new ChannelProgressError(false, messageId, undefined, error);
  }
  const details = error && typeof error === "object"
    ? error as { status?: number; statusCode?: number; response?: { status?: number } }
    : undefined;
  const text = error instanceof Error ? error.message : String(error);
  const status = details?.status ?? details?.statusCode ?? details?.response?.status
    ?? Number(text.match(/HTTP\s+(\d{3})/i)?.[1]);
  if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
    return new ChannelProgressError(false, messageId, undefined, error);
  }
  if (/Forbidden|AccessDenied|InvalidParameter|not.?configured|未配置|通道已过期/i.test(text)) {
    return new ChannelProgressError(false, messageId, undefined, error);
  }
  return new ChannelProgressError(true, messageId, undefined, error);
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
