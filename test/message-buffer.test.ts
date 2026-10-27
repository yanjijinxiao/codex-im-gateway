import assert from "node:assert/strict";
import test from "node:test";

import { PromptBuffer } from "../src/bridge/prompt-buffer.js";

test("buffers mixed WeChat messages until prompt done", () => {
  const buffers = new PromptBuffer({ maxItems: 5, ttlMs: 60_000 });

  assert.equal(buffers.start("alice").status, "started");
  buffers.append("alice", { kind: "text", text: "please inspect this" });
  buffers.append("alice", { kind: "file", path: "/tmp/a.png", label: "a.png" });

  const flushed = buffers.done("alice");

  assert.equal(flushed.status, "flushed");
  assert.equal(flushed.items.length, 2);
  assert.equal(buffers.done("alice").status, "empty");
});

test("limits buffered prompt size", () => {
  const buffers = new PromptBuffer({ maxItems: 1, ttlMs: 60_000 });

  buffers.start("alice");
  buffers.append("alice", { kind: "text", text: "one" });

  assert.throws(
    () => buffers.append("alice", { kind: "text", text: "two" }),
    /too many/i
  );
});

test("expired conversations are evicted when another conversation uses the buffer", () => {
  let now = 0; const buffers = new PromptBuffer({ maxItems: 5, ttlMs: 10, now: () => now });
  for (let i = 0; i < 100; i++) buffers.start(`inactive-${i}`);
  now = 11; buffers.start("new");
  assert.equal((buffers as any).buffers.size, 1);
  assert.equal(buffers.isActive("new"), true); assert.equal(buffers.done("inactive-1").status, "empty");
});
