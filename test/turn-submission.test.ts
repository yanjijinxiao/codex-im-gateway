import assert from "node:assert/strict";
import test from "node:test";
import { prepareTurnSubmission, TurnSubmission, TurnDeliveryError } from "../src/bridge/turn-submission.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { defaultConfig } from "../src/state/config.js";
import type { CodexBridgeBackend, CodexRunnerInput } from "../src/codex/backend.js";
import type { ManagedSession } from "../src/state/runtime-state.js";

const session: ManagedSession = { id: "session", senderId: "chat", title: "Explicit title", workspace: "/remote/work",
  projectBinding: "none", hostId: "remote", collaborationMode: "plan", model: "chosen", effort: "high", createdAt: "", updatedAt: "" };
for (const source of ["Web", "DingTalk", "WeChat", "Feishu", "WeCom"] as const) {
  test(`${source} shares remote staging and explicit project/model/plan settings`, async () => {
    const calls: unknown[] = [];
    const runner = { async stageAttachments(files: any[], options: unknown) { calls.push(options); return files.map(f => ({ ...f, path: "/remote/file" })); } } as unknown as CodexBridgeBackend;
    const prepared = await prepareTurnSubmission({ runner, session, config: defaultConfig("/local"), accountId: "account", conversationId: "chat",
      text: "inspect", items: [{ kind: "image", path: "/local/upload", label: "image.png" }], source, knowledge: [],
      project: { id: "old", name: "stale project", sourceProjectId: "native-old", workspace: "/old", createdAt: "", updatedAt: "" } });
    assert.equal(calls.length, 1); assert.match(prepared.prompt, /saved to \/remote\/file/); assert.doesNotMatch(prepared.prompt, /\/local\/upload/);
    assert.equal(prepared.projectBinding, "none"); assert.equal(prepared.projectId, undefined); assert.equal(prepared.projectName, undefined);
    assert.equal(prepared.collaborationMode, "plan"); assert.equal(prepared.model, "chosen"); assert.equal(prepared.effort, "high");
  });
}

for (const result of [undefined, [], [{ path: "relative" }]]) test(`remote staging failure rejects before execution (${JSON.stringify(result)})`, async () => {
  const runner = (result === undefined ? {} : { stageAttachments: async () => result }) as unknown as CodexBridgeBackend;
  await assert.rejects(prepareTurnSubmission({ runner, session, config: defaultConfig(), conversationId: "chat", text: "file",
    items: [{ kind: "file", path: "/local/file", label: "file" }], source: "Web", knowledge: [] }));
});

test("local input preserves attachments without a remote staging dependency", async () => {
  const p = await prepareTurnSubmission({ runner: {} as CodexBridgeBackend, session: { ...session, hostId: "local" }, config: defaultConfig(),
    conversationId: "chat", text: "read", items: [{ kind: "file", path: "/local/file", label: "file" }], source: "Web", knowledge: [] });
  assert.match(p.prompt, /\/local\/file/);
});

for (const phase of ["preflight", "submission", "observation"] as const) test(`shared submission retains ${phase} semantics`, async () => {
  const submission = new TurnSubmission();
  const input: CodexRunnerInput = { cwd: "/work", prompt: "test", threadId: "thread" };
  let caught: unknown;
  try {
    if (phase === "preflight") throw submission.error(Error("connection closed"));
    await submission.run({ async run(run) {
      if (phase === "observation") await run.onTurnStarted?.({ threadId: "thread", turnId: "accepted" });
      throw Error("connection closed");
    } }, input);
  } catch (error) { caught = error; }
  assert.ok(caught instanceof CodexCommunicationError); assert.equal(caught.phase, phase);
  assert.equal(caught.submission, { preflight: "not-submitted", submission: "unconfirmed", observation: "accepted" }[phase]);
});

test("a binding change during preparation blocks native write", async () => {
  let calls = 0; const submission = new TurnSubmission();
  await assert.rejects(submission.run({ async run() { calls++; throw Error("unexpected"); } }, { cwd: "/work", prompt: "test" }, () => { throw Error("binding changed"); }), /binding changed/);
  assert.equal(calls, 0);
});

test("a post-completion delivery failure never becomes a native task failure", async () => {
  const submission = new TurnSubmission();
  await submission.run({ async run() { return { threadId: "thread", turnId: "turn", text: "done", raw: "" }; } }, { cwd: "/work", prompt: "test" });
  assert.equal(submission.completed, true); assert.ok(submission.error(Error("delivery failed")) instanceof TurnDeliveryError);
});

test("a Gateway callback failure after native acceptance cannot become a task failure", async () => {
  const { TurnApplicationError } = await import('../src/bridge/turn-submission.js');
  const submission = new TurnSubmission();
  await assert.rejects(submission.run({ async run(input) {
    await input.onTurnStarted?.({ threadId: 'thread', turnId: 'accepted' }); throw Error('state commit conflict');
  } }, { cwd: '/work', prompt: 'test' }), TurnApplicationError);
});
