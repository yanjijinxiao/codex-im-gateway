/** Codex Desktop IPC: a uint32 LE byte length followed by one UTF-8 JSON frame. */
export class IpcFrameSizeError extends Error {
  constructor(readonly frameBytes: number) { super(`Rejected oversized IPC frame: ${frameBytes} bytes`); }
}

/**
 * Linear-time assembly. Repeated Buffer.concat of an unfinished snapshot costs
 * O(frameBytes² / chunkBytes) and can starve RPC receipts on the same event loop.
 * Validate the length before allocating, then copy each incoming byte once.
 */
export class IpcFrameDecoder {
  private readonly header = Buffer.allocUnsafe(4);
  private headerBytes = 0;
  private payload?: Buffer;
  private payloadBytes = 0;
  private copied = 0;
  constructor(private readonly maxFrameBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 0 || maxFrameBytes > 0xffffffff) throw new Error("Invalid IPC frame limit");
  }
  get bytesCopied(): number { return this.copied; }
  get bufferedBytes(): number { return this.headerBytes + this.payloadBytes; }
  reset(): void { this.headerBytes = 0; this.payload = undefined; this.payloadBytes = 0; }

  push(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.copied += count; this.headerBytes += count; offset += count;
        if (this.headerBytes < 4) return;
        const length = this.header.readUInt32LE(0);
        if (length > this.maxFrameBytes) { this.reset(); throw new IpcFrameSizeError(length); }
        if (!length) { this.reset(); onFrame(Buffer.alloc(0)); continue; }
        this.payload = Buffer.allocUnsafe(length);
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count);
      this.copied += count; this.payloadBytes += count; offset += count;
      if (this.payloadBytes === this.payload.length) {
        const frame = this.payload;
        this.reset();
        onFrame(frame);
      }
    }
  }
}
