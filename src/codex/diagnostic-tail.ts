/** Raw protocol diagnostics are supplemental, never the authoritative answer. */
export class DiagnosticTail {
  private tail = Buffer.alloc(0);
  private truncated = false;
  constructor(private readonly maximumBytes = 256 * 1024) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 64) throw new RangeError("Diagnostic budget must be at least 64 bytes");
  }
  append(value: string | Buffer): void {
    const chunk = typeof value === "string" ? Buffer.from(value) : value;
    if (this.tail.length + chunk.length > this.maximumBytes) this.truncated = true;
    if (chunk.length >= this.maximumBytes) this.tail = Buffer.from(chunk.subarray(chunk.length - this.maximumBytes));
    else this.tail = Buffer.concat([this.tail.subarray(Math.max(0, this.tail.length + chunk.length - this.maximumBytes)), chunk]);
  }
  text(): string {
    const rendered = Buffer.from(this.tail.toString("utf8"));
    const marker = this.truncated || rendered.length > this.maximumBytes ? "[Gateway diagnostic tail truncated]\n" : "";
    let start = Math.max(0, rendered.length - this.maximumBytes + Buffer.byteLength(marker));
    // The byte budget may begin within a UTF-8 code point.
    while (start < rendered.length && (rendered[start] & 0xc0) === 0x80) start++;
    return marker + rendered.subarray(start).toString("utf8");
  }
}
