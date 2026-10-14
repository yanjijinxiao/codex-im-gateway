import assert from "node:assert/strict";
import test from "node:test";
import { IpcFrameDecoder, IpcFrameSizeError } from "../src/codex/ipc-frames.js";

function wire(payload: Buffer): Buffer {
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

test("IPC decoder handles fragmented headers, payloads, empty frames and multiple frames without losing order", () => {
  const decoder = new IpcFrameDecoder(128);
  const values = [Buffer.from("中文"), Buffer.alloc(0), Buffer.from("next")];
  const input = Buffer.concat(values.map(wire));
  const actual: Buffer[] = [];
  for (let offset = 0; offset < input.length; offset++) decoder.push(input.subarray(offset, offset + 1), frame => actual.push(frame));
  assert.deepEqual(actual, values);
  assert.equal(decoder.bufferedBytes, 0); assert.equal(decoder.bytesCopied, input.length);
});

test("an 8 MiB fragmented snapshot is assembled with linear copying, not repeated prefix copies", () => {
  const decoder = new IpcFrameDecoder();
  const payload = Buffer.alloc(8 * 1024 * 1024, 123);
  const input = wire(payload); let actual: Buffer | undefined;
  for (let offset = 0; offset < input.length; offset += 1024) decoder.push(input.subarray(offset, offset + 1024), frame => { actual = frame; });
  assert.deepEqual(actual, payload);
  assert.equal(decoder.bytesCopied, input.length);
  assert.equal(decoder.bufferedBytes, 0);
});

test("IPC rejects an oversized length before retaining its payload, and reset isolates a replacement connection", () => {
  const decoder = new IpcFrameDecoder(16);
  const header = Buffer.alloc(4); header.writeUInt32LE(17);
  let delivered = 0;
  decoder.push(header.subarray(0, 2), () => { delivered++; });
  assert.throws(() => decoder.push(header.subarray(2), () => { delivered++; }), IpcFrameSizeError);
  assert.equal(delivered, 0); assert.equal(decoder.bufferedBytes, 0);
  decoder.push(wire(Buffer.from("first")).subarray(0, 6), () => { delivered++; });
  decoder.reset();
  decoder.push(wire(Buffer.from("second")), frame => { assert.equal(frame.toString(), "second"); delivered++; });
  assert.equal(delivered, 1);
});
