import assert from "node:assert/strict";
import test from "node:test";

import {
  commandProjectRequirement,
  requiredModeForCommand
} from "../src/bridge/channel-command-policy.js";

test("preserves the exact project-free command policy", () => {
  const projectFree = [
    "help", "h", "balance", "memory", "knowledge", "project", "projects", "approve", "reject", "answer"
  ];
  for (const name of projectFree) {
    assert.equal(commandProjectRequirement({ name, arg: "" }), "optional");
  }
  for (const name of ["status", "task", "qa", "mode", "sessions", "goal"]) {
    assert.equal(commandProjectRequirement({ name, arg: "" }), "required");
  }
});

test("preserves the exact command mode policy", () => {
  const cases = [
    ["task", "task"], ["tb", "task"],
    ["qa", "qa"], ["q", "qa"],
    ["new", "session"], ["n", "session"], ["session", "session"],
    ["sessions", "session"], ["s", "session"], ["ss", "session"],
    ["status", undefined], ["project", undefined], ["goal", undefined]
  ] as const;
  for (const [name, expected] of cases) {
    assert.equal(requiredModeForCommand({ name, arg: "" }), expected);
  }
  assert.equal(requiredModeForCommand({ name: "mode", arg: "session" }), "session");
  assert.equal(requiredModeForCommand({ name: "mode", arg: "task" }), "task");
  assert.equal(requiredModeForCommand({ name: "mode", arg: "qa" }), "qa");
});
