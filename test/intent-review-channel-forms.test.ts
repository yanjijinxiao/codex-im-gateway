import assert from "node:assert/strict";
import test from "node:test";
import { formatChannelActionCommand } from "../src/channels/action-card.js";
import { createGoalFormCard } from "../src/channels/goal-form-card.js";
import { createTaskFormCard } from "../src/channels/task-form-card.js";
import { copyableTaskCard } from "../src/channels/task-card-copy.js";
import { feishuTaskCard } from "../src/channels/feishu-task-card.js";
import { parseCommand } from "../src/bridge/channel-commands.js";

for (const objective of ["pause", "clear", "resume", "complete", "form", "set", "真正的多行\n目标"])
  test(`goal form explicitly sets an objective even when its text is a control word: ${objective}`, () => {
    const value = createGoalFormCard("Project").submitActions[0].value;
    assert.equal(formatChannelActionCommand(value, { objective }), `/goal set ${objective}`);
    assert.equal(parseCommand(`/goal set ${objective}`)?.arg, `set ${objective}`);
  });

test("native Taskboard form retains controls without duplicating them as transfer commands", () => {
  const card = copyableTaskCard(createTaskFormCard({ form: "new", projectName: "Project", projectId: "p", taskboardBaseUrl: "http://127.0.0.1:47823" }));
  assert.match(card.fallbackText, /\/task new/);
  const payload = feishuTaskCard(card);
  assert.ok(payload.elements.some(element => element.tag === "form"));
  assert.doesNotMatch(JSON.stringify(payload), /发送命令操作|```text/);
});
