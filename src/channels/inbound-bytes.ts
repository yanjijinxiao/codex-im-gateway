import { InboundMediaTooLargeError } from "./errors.js";

/** Bound memory while receiving, not only after buffering a complete file. */
export async function inboundBytes(source: AsyncIterable<Uint8Array | string>, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > maxBytes) throw new InboundMediaTooLargeError(maxBytes, bytes);
    parts.push(part);
  }
  return Buffer.concat(parts, bytes);
}

export async function responseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new InboundMediaTooLargeError(maxBytes, contentLength);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  async function* chunks() {
    try { while (true) { const chunk = await reader.read(); if (chunk.done) return; yield chunk.value; } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  return inboundBytes(chunks(), maxBytes);
}
