import assert from "node:assert/strict";
import test from "node:test";
import { marked, type Token } from "marked";
import { ChannelApprovalController } from "../src/bridge/approval.js";
import { copyBlock, copyableChoices } from "../src/channels/copyable.js";
import { dingTalkLoadingBody } from "../src/channels/dingtalk-markdown.js";
import { DingTalkHttpsAICardClient, DingTalkSdkAICardClient, normalizeDingTalkCardContent } from "../src/channels/dingtalk.js";
import { resultPages } from "../src/channels/result-pages.js";

function codeValues(source: string): string[] {
  const values: string[] = [];
  marked.walkTokens(marked.lexer(source), (token: Token) => { if (token.type === "code") values.push(token.text); });
  return values;
}

test("the actual once-only approval notice retains two exact copy blocks and an outside timeout", async t => {
  let notice = "";
  const approvals = new ChannelApprovalController(async (_sender, value) => { notice = value.card?.fallbackText ?? value.text; }, 600_000, () => "A2");
  t.after(() => approvals.declineAll("test-room"));
  const decision = approvals.request("test-room", { kind: "mcp", threadId: "thread", turnId: "turn", itemId: "test",
    serverName: "cua_repl", reason: 'Allow Computer Use to use "Google Chrome"?' });
  const actual = normalizeDingTalkCardContent(notice);
  assert.deepEqual(codeValues(actual), ["/approve A2", "/reject A2"]);
  assert.match(actual, /```\n拒绝：/);
  assert.match(actual, /```\n10 分钟内未处理将自动拒绝。$/);
  assert.doesNotMatch(actual, /```<br>/);
  assert.equal(approvals.hasPending("test-room"), true, "formatting must not settle or approve the request");
  approvals.declineAll("test-room"); assert.equal(await decision, "decline");
});

test("all copyable choice producers retain independent commands, labels and following prose", () => {
  const source = copyableChoices("请回答：", [{ label: "继续", value: "/answer Q38 --option 1" }, { label: "跳过", value: "/skip Q38" }]) + "\n以上只是命令提示。";
  const actual = normalizeDingTalkCardContent(source);
  assert.deepEqual(codeValues(actual), ["/answer Q38 --option 1", "/skip Q38"]);
  assert.equal(normalizeDingTalkCardContent(actual), actual);
});

for (const [name, source] of Object.entries({
  backticks: "说明\n```text\n/answer Q1 literal  **x** <br>  \n> literal quote\n```\n下一项",
  tildes: "说明\n~~~text\n/answer Q2 value\n> first\n> second\n~~~\n下一项",
  longFence: "说明\n````text\n/answer Q3 value\n```\n~~~\n````\n下一项",
  falseClosing: "```text\n/answer Q4\n```not-a-closing-fence\n> first\n> second\n```\n下一项",
  tableInsideCode: "```text\n说明文字\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```\n下一项",
  quotedCode: "> 引用\n>\n> ```text\n> /answer Q5 quoted\n> ```\n> 后续引用\n\n正文",
  nestedCode: "- 选项\n\n  ```text\n  /answer Q6 nested\n  > literal\n  ```\n\n  说明\n\n正文",
  indentedCode: "说明\n\n    first\n    second\n    > literal\n\n正文",
  unclosedCode: "说明\n\n~~~text\n/answer Q7 streamed\n> first\n> second",
  commandBackticks: `说明\n\n${copyBlock("/answer Q8 a```b\n> literal")}\n下一项`
})) {
  test(`${name}: formatting preserves every code value and is idempotent`, () => {
    const expected = codeValues(source);
    assert.ok(expected.length, "fixture must contain a code block");
    const actual = normalizeDingTalkCardContent(source);
    assert.deepEqual(codeValues(actual), expected);
    assert.equal(normalizeDingTalkCardContent(actual), actual);
  });
}

test("pagination and live cursor anchors cannot leak prose into copied commands", () => {
  const source = Array.from({ length: 24 }, (_, i) => `选项 ${i}\n\n${copyBlock(`/answer Q${i} 中文😀 literal`)}\n解释 ${i}\n\n`).join("");
  const pages = resultPages(source, 1500);
  assert.equal(pages.map(page => page.source).join(""), source);
  assert.deepEqual(pages.flatMap(page => codeValues(normalizeDingTalkCardContent(page.text))), codeValues(source));
  const loading = normalizeDingTalkCardContent(dingTalkLoadingBody(copyBlock("/stop")));
  assert.deepEqual(codeValues(loading), ["/stop"]);
  assert.match(loading, /\n\n正在处理…$/);
});

for (const transport of ["HTTPS", "SDK"] as const) {
  test(`${transport}: static, running, waiting, restored and final bodies use the same code-safe renderer`, async () => {
    const writes: string[] = [];
    function body(input: any) {
      const map = input.cardData.cardParamMap, key = JSON.parse(map.sys_full_json_obj).order[0];
      if (Object.hasOwn(map, key)) writes.push(map[key]);
    }
    const client = transport === "HTTPS" ? new DingTalkHttpsAICardClient(async (url, init) => {
      const input = JSON.parse(String(init?.body));
      if (String(url).endsWith("/streaming")) writes.push(input.content);
      else if (!String(url).endsWith("/deliver")) body(input);
      return new Response(JSON.stringify({ success: true, result: String(url).endsWith("/deliver") ? [{ success: true }]
        : init?.method === "POST" ? "instance" : true }), { status: 200 });
    }, [0], async () => {}) : new DingTalkSdkAICardClient({
      async createCardWithOptions(input: any) { body(input); return { statusCode: 200, body: { success: true, result: "instance" } }; },
      async deliverCardWithOptions() { return { statusCode: 200, body: { success: true, result: [{ success: true }] } }; },
      async updateCardWithOptions(input: any) { body(input); return { statusCode: 200, body: { success: true, result: true } }; },
      async streamingUpdateWithOptions(input: any) { writes.push(input.content); return { statusCode: 200, body: { success: true, result: true } }; }
    } as never, [0], async () => {});
    const source = `批准一次：\n\n${copyBlock("/approve A2")}\n拒绝：\n\n${copyBlock("/reject A2")}\n10 分钟内未处理将自动拒绝。`;
    const base = { text: source, accessToken: "fake", contentKey: "content", outTrackId: "fixture" };
    await client.create({ ...base, cardTemplateId: "fake", robotCode: "fake", target: { type: "group", conversationId: "test-room" }, finalize: true });
    await client.update({ ...base, finalize: false, error: false, activity: "running" });
    await client.update({ ...base, finalize: false, error: false, activity: "waiting-approval" });
    await client.update({ ...base, finalize: false, error: false, activity: "running" });
    await client.update({ ...base, finalize: true, error: false });
    assert.ok(writes.length >= 5);
    for (const text of writes) assert.deepEqual(codeValues(text), ["/approve A2", "/reject A2"]);
  });
}
