import assert from "node:assert/strict";
import test from "node:test";
import { rolloutIdentity } from "../src/codex/rollout-identity.js";

test("identifies guardian and subagent sources without confusing their parent with their own id", () => {
  for (const source of [
    { thread_source: "guardian_review" }, { thread_source: "subagent" },
    { source: { subagent: { other: "guardian" } } },
    { source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } } },
    { source: "guardian_review" }
  ]) assert.deepEqual(rolloutIdentity({ id: "child", session_id: "parent", ...source }), {
    threadId: "child", internal: true
  });
  assert.deepEqual(rolloutIdentity({ id: "user-fork", session_id: "parent", source: "cli" }), {
    threadId: "user-fork", internal: false
  });
  assert.deepEqual(rolloutIdentity({ session_id: "legacy" }), { threadId: "legacy", internal: false });
});
