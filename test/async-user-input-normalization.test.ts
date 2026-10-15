import assert from "node:assert/strict";
import test from "node:test";
import { asyncUserInputReply, desktopAsyncUserInputs } from "../src/codex/async-user-input.js";

function state(questions: unknown[], canonical: boolean, tail: unknown[] = []) {
  const turn = { turnId: "turn", status: "inProgress", items: [
    { type: "agentMessage", id: "question-call", questions }, ...tail
  ] };
  return { threadRuntimeStatus: { type: "active" }, ...(canonical
    ? { turns: [], turnHistory: { history: { entitiesByKey: { turn } } } }
    : { turns: [turn] }) };
}

for (const canonical of [false, true]) for (const hostId of ["local", "remote-ssh-discovered:test"]) {
  for (const [label, shape] of [
    ["absent", {}], ["null", { options: null }], ["empty", { options: [] }]
  ] as const) test(`free input options=${label}, canonical=${canonical}, host=${hostId}`, () => {
    const wire = state([{ title: "测试使用哪个版本和环境？", ...shape }], canonical);
    const before = JSON.stringify(wire);
    const requests = desktopAsyncUserInputs("thread", wire, hostId);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.kind, "async"); assert.equal(request.hostId, hostId);
    assert.equal(request.turnId, "turn"); assert.equal(request.autoResolutionMs, null);
    assert.equal(request.questions[0].options, undefined);
    assert.equal(request.questions[0].id, '["request_user_input_async","question-call",0]');
    assert.equal(JSON.stringify(wire), before, "normalization must not mutate the native snapshot");
  });

  test(`accepted null-options question stays answered while a sibling remains pending, canonical=${canonical}, host=${hostId}`, () => {
    const questions = [{ title: "原问题", options: null }, { title: "第二题", options: null }];
    const [request] = desktopAsyncUserInputs("thread", state(questions, canonical), hostId);
    assert.ok(request);
    const reply = asyncUserInputReply(request, { [request.questions[0].id]: { answers: ["文字\n回答"] } });
    const wire = state(questions, canonical, [{ type: "steeringUserMessage", status: "accepted",
      input: [{ type: "text", text: reply }] }]);
    const pending = desktopAsyncUserInputs("thread", wire, hostId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].questions[0].id, '["request_user_input_async","question-call",1]');
  });
}

test("null normalization does not accept malformed option lists or drop a valid sibling", () => {
  for (const options of [false, 0, "choice", {}, [null], [1], [""], [" "], ["x".repeat(2001)], Array(33).fill("choice")]) {
    const requests = desktopAsyncUserInputs("thread", state([
      { title: "非法选项", options }, { title: "有效的自由输入题", options: null }
    ], true));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].questions[0].id, '["request_user_input_async","question-call",1]');
  }
  const [request] = desktopAsyncUserInputs("thread", state([{ title: "有效选项题", options: ["第一项", "第二项"] }], true));
  assert.deepEqual(request.questions[0].options?.map(option => option.label), ["第一项", "第二项"]);
});
