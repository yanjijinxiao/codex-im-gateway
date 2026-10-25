import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import { dingTalkLoadingBody, dingTalkPlainText, dingTalkVisibleOrdinals } from "../src/channels/dingtalk-markdown.js";
import { DingTalkHttpsAICardClient, DingTalkSdkAICardClient, normalizeDingTalkCardContent } from "../src/channels/dingtalk.js";
import { resultPages } from "../src/channels/result-pages.js";

test("DingTalk loose numbered sections keep visible ordinals around tables, citations and child lists", () => {
  const source = [
    "1. **1284～1288：决定最终写入的版本。**", "",
    "   文件：[MetaInfoGen.java](/repo/MetaInfoGen.java:1284)", "",
    "   | 参数 | 版本 |", "   | --- | --- |", "   | 中文😀 | 2 |", "",
    "2. **1256～1266：生成完整 schema，再替换同名列。**", "",
    "   - 保留列名", "   - 替换类型", "",
    "   后续解释不应变成代码块。", "",
    "3. **取得最终生效的 SerDe 类名。**"
  ].join("\n");
  const actual = normalizeDingTalkCardContent(source);
  for (const number of [1, 2, 3]) assert.ok(actual.includes(`**${number}.** **`));
  assert.match(actual, /\n\n\| 参数 \| 版本 \|\n\| --- \| --- \|\n\| 中文😀 \| 2 \|/);
  assert.match(actual, /\n- 保留列名\n- 替换类型/);
  assert.match(actual, /\[MetaInfoGen.java\]\(\/repo\/MetaInfoGen.java:1284\)/);
  // Numbers no longer depend on an ol/li marker outside the card body.
  const html = marked.parse(actual) as string;
  assert.doesNotMatch(html, /<ol\b|<pre>/);
  assert.match(html, /<strong>2\.<\/strong>/);
  assert.match(html, /<table>/);
  assert.equal(normalizeDingTalkCardContent(actual), actual);
});

test("DingTalk numbers repeated Markdown markers from the list start, including wide ordinals", () => {
  for (const delimiter of [".", ")"]) {
    const actual = normalizeDingTalkCardContent(`9${delimiter} 第一项\n1${delimiter} 第二项\n1${delimiter} 第三项`);
    assert.equal(actual, "**9.** 第一项\n\n**10.** 第二项\n\n**11.** 第三项");
  }
  assert.equal(normalizeDingTalkCardContent("1.\n2. 内容"), "**1.** \n\n**2.** 内容");
});

test("DingTalk keeps nested ordered lists, task items and quotes subordinate and idempotent", () => {
  const source = "1. 父项\n   1. 子项\n      - 明细\n   1. 子项二\n2. 下项\n\n- [x] 检查\n\n  3. 一\n  1. 二\n\n> 4. 引用\n> 1. 引用二\n";
  const actual = dingTalkVisibleOrdinals(source);
  assert.match(actual, /\*\*1\.\*\* 父项\n- \*\*1\.\*\* 子项\n  - 明细\n- \*\*2\.\*\* 子项二/);
  assert.match(actual, /- \[x\] 检查\n  \n  - \*\*3\.\*\* 一\n  - \*\*4\.\*\* 二/);
  assert.match(actual, /> \*\*4\.\*\* 引用\n> \n> \*\*5\.\*\* 引用二/);
  assert.equal(dingTalkVisibleOrdinals(actual), actual);
  const html = marked.parse(actual) as string;
  assert.doesNotMatch(html, /<ol\b/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /type="checkbox"/);
  const normalized = normalizeDingTalkCardContent(actual);
  assert.equal(normalizeDingTalkCardContent(normalized), normalized);
});

test("ordinal compatibility does not rewrite code, inline numbers, links or reference definitions", () => {
  const unaffected = "普通段落中的 1. 不是列表。\n\n`1. 行内代码`\n\n```md\n1. fenced\n2. unchanged\n```\n\n~~~md\n1. tilde\n~~~\n\n    1. indented\n    2. code\n\n| 列 | 值 |\n| --- | --- |\n| 1. | 2. |\n\n[ref]: https://example.test/ref\n";
  assert.equal(dingTalkVisibleOrdinals(unaffected), unaffected);
  const numbered = "1. **标题**\n\n   ```md\n   1. 保留代码\n   ```\n\n   [引用][ref]\n\n   [ref]: https://example.test/ref\n";
  const actual = dingTalkVisibleOrdinals(numbered);
  assert.match(actual, /```md\n1\. 保留代码\n```/);
  assert.match(actual, /\[ref\]: https:\/\/example.test\/ref/);
  assert.match(marked.parse(actual) as string, /href="https:\/\/example.test\/ref"/);
});

test("a numbered item beginning with a code fence or heading keeps its block semantics", () => {
  const source = "1. ```md\n   1. 不应重编号\n   2. 仍是代码\n   ```\n2. ## 小标题\n\n   解释";
  const actual = normalizeDingTalkCardContent(source);
  assert.match(actual, /\*\*1\.\*\*\n\n```md\n1\. 不应重编号\n2\. 仍是代码\n```/);
  assert.match(actual, /\*\*2\.\*\*\n\n## 小标题/);
  assert.equal(normalizeDingTalkCardContent(actual), actual);
  const html = marked.parse(actual) as string;
  assert.match(html, /<pre><code class="language-md">1\. 不应重编号/);
  assert.match(html, /<h2>小标题<\/h2>/);
});

test("paginated DingTalk sections retain explicit source numbering without changing source slices or budgets", () => {
  const source = Array.from({ length: 18 }, (_, i) => `${i + 1}. **段落 ${i + 1}**\n\n   ${"中文😀 ".repeat(25)}\n\n`).join("");
  const pages = resultPages(source, 1500);
  assert.equal(pages.map(page => page.source).join(""), source);
  const visible = pages.map(page => normalizeDingTalkCardContent(page.text)).join("\n");
  for (let i = 1; i <= 18; i++) assert.ok(visible.includes(`**${i}.** **段落 ${i}**`));
  for (const page of pages) assert.ok(Buffer.byteLength(normalizeDingTalkCardContent(page.text)) <= 1500);
});

for (const transport of ["HTTPS", "SDK"] as const) {
  test(`DingTalk ${transport} uses identical visible ordinals for create, streaming and terminal snapshots`, async () => {
    const source = "1. **第一段**\n\n   解释\n\n2. **第二段**\n\n   - 明细";
    const contents: string[] = [];
    let creates = 0, deliveries = 0;
    let modePatches = 0;
    const snapshot = (body: any) => {
      const map = body.cardData.cardParamMap, key = JSON.parse(map.sys_full_json_obj).order[0];
      if (Object.hasOwn(map, key)) contents.push(map[key]);
      else modePatches++;
    };
    const client = transport === "HTTPS" ? new DingTalkHttpsAICardClient(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      const deliver = String(url).endsWith("/deliver");
      if (deliver) deliveries++;
      else if (String(url).endsWith("/streaming")) contents.push(body.content);
      else { snapshot(body); if (init?.method === "POST") creates++; }
      return new Response(JSON.stringify({ success: true, result: deliver ? [{ success: true }]
        : init?.method === "POST" ? "instance" : true }), { status: 200 });
    }, [0], async () => undefined) : new DingTalkSdkAICardClient({
      async createCardWithOptions(body: any) { creates++; snapshot(body); return { statusCode: 200, body: { success: true, result: "instance" } }; },
      async deliverCardWithOptions() { deliveries++; return { statusCode: 200, body: { success: true, result: [{ success: true }] } }; },
      async updateCardWithOptions(body: any) { snapshot(body); return { statusCode: 200, body: { success: true, result: true } }; },
      async streamingUpdateWithOptions(body: any) { contents.push(body.content); return { statusCode: 200, body: { success: true, result: true } }; }
    } as never, [0], async () => undefined);
    const input = { accessToken: "fake", contentKey: "content", outTrackId: "card-format", text: source };
    await client.create({ ...input, cardTemplateId: "template", robotCode: "fake", target: { type: "group", conversationId: "chat" } });
    await client.update({ ...input, finalize: false, error: false });
    await client.update({ ...input, finalize: true, error: false });
    assert.equal(creates, 1);
    assert.equal(deliveries, 1);
    assert.equal(contents.length, 4); assert.equal(modePatches, 1);
    assert.deepEqual(contents, [source, source, source, source].map((text, i) => normalizeDingTalkCardContent(i < 2 ? dingTalkLoadingBody(text) : text)));
    assert.ok(contents.every(content => content.includes("**2.** **第二段**")));
  });
}

test("plain DingTalk fallback preserves exact reply values without leaking fenced-code syntax", () => {
  const commands = ["/answer Q38 --option 1", "/skip Q38", '/answer Q38 a`b **literal** <tag> \\ path', "多行\n第二行"];
  for (const command of commands) {
    const fence = command.includes("`") ? "````" : "```";
    const source = `选择说明\n\n${fence}text\n${command}\n${fence}\n\n下一项`;
    assert.equal(dingTalkPlainText(source), `选择说明\n\n${command}\n\n下一项`);
  }
  assert.equal(dingTalkPlainText("~~~text\n/ide access 123456789abc\n~~~"), "/ide access 123456789abc");
  assert.equal(dingTalkPlainText("普通参考：路径 /repo 和 ID Q38"), "普通参考：路径 /repo 和 ID Q38");
});

test("all active Markdown block endings have a normal cursor anchor without changing the copied command", () => {
  for (const body of ["```text\n/stop\n```", "```text\n/stop", "> 引用", "- 列表", "| 列 | 值 |\n| --- | --- |\n| a | b |", "## 标题"]) {
    const result = dingTalkLoadingBody(body);
    assert.ok(result.endsWith("\n\n正在处理…"));
    assert.equal(dingTalkLoadingBody(result), result);
    if (body.includes("/stop")) assert.match(result, /```text\n\/stop\n```\n\n正在处理…$/);
  }
  assert.equal(dingTalkLoadingBody("任务仍在执行"), "任务仍在执行");
});
