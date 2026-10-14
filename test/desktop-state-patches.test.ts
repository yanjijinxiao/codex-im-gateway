import assert from "node:assert/strict";
import test from "node:test";
import { applyDesktopStatePatches } from "../src/codex/desktop-state-patches.js";

test("Desktop patches copy only the changed path and preserve pending request and history identities", () => {
  const history = { manyItems: Array.from({ length: 10_000 }, (_, index) => ({ index, output: "large history" })) };
  const request = { command: { args: ["read-only", "original"] } };
  const state = { turnHistory: history, requests: [request], threadRuntimeStatus: { type: "active" } };
  const next = applyDesktopStatePatches(state, [{ op: "replace", path: ["requests", 0, "command", "args", 1], value: "updated" }])!;
  assert.equal(next.turnHistory, history);
  assert.notEqual(next.requests, state.requests); assert.notEqual(next.requests[0], request);
  assert.equal(request.command.args[1], "original"); assert.equal(next.requests[0].command.args[1], "updated");
  assert.equal(next.threadRuntimeStatus, state.threadRuntimeStatus);
});

test("a Desktop patch batch is atomic, including when a later operation is invalid", () => {
  const state = { requests: [{ text: "original" }], count: 1 };
  const next = applyDesktopStatePatches(state, [
    { op: "replace", path: ["requests", 0, "text"], value: "changed" },
    { op: "remove", path: ["requests", 2] }
  ]);
  assert.equal(next, undefined); assert.equal(state.requests[0].text, "original");
});

test("Desktop patches preserve native array insertion/removal/length semantics and reject unsafe paths", () => {
  const state = { requests: ["one", "two"] };
  const next = applyDesktopStatePatches(state, [
    { op: "add", path: ["requests", 1], value: "inserted" },
    { op: "remove", path: ["requests", 0] },
    { op: "replace", path: ["requests", "length"], value: 1 }
  ]);
  assert.deepEqual(next?.requests, ["inserted"]); assert.deepEqual(state.requests, ["one", "two"]);
  for (const path of [["__proto__", "polluted"], ["constructor", "prototype"], ["requests", -1], ["missing", "key"]]) {
    assert.equal(applyDesktopStatePatches(state, [{ op: "add", path, value: true }]), undefined);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
