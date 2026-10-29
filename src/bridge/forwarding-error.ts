/** Known not submitted. A durable transport inbox may retry after acceptance
 * of the preceding input, without turning the message into a native queue item. */
export class ForwardingDeferredError extends Error {}
