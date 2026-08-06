import assert from "node:assert/strict";
import test from "node:test";

import {
  commandProjectRequirement,
  friendlyCommandsContinueConversation,
  isGoalSetCommand,
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

test("continues only conversational plan starts and goal creation", () => {
  const planOn = { name: "plan", arg: "on" };
  const goalSet = { name: "goal", arg: "set 完成渠道交互" };
  assert.equal(friendlyCommandsContinueConversation([planOn]), true);
  assert.equal(friendlyCommandsContinueConversation([goalSet]), true);
  assert.equal(friendlyCommandsContinueConversation([planOn, goalSet]), true);
  assert.equal(isGoalSetCommand(goalSet), true);

  for (const command of [
    { name: "plan", arg: "off" },
    { name: "goal", arg: "" },
    { name: "goal", arg: "clear" },
    { name: "status", arg: "" }
  ]) {
    assert.equal(friendlyCommandsContinueConversation([command]), false);
    assert.equal(isGoalSetCommand(command), false);
  }
});
