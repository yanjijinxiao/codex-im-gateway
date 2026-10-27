import assert from "node:assert/strict";
import test from "node:test";
import { Lexer, marked } from "marked";
import { markdownPreview } from "../src/channels/markdown-preview.js";
import { dingTalkProgressContent, dingTalkPlainText } from "../src/channels/dingtalk-markdown.js";

const source = '## 三类规则\n\n1. **普通索引** 使用 `checkIndexProperties`。\n   - 校验 key\n2. **FULLTEXT** 单独处理。\n\n| 类型 | 配置 |\n| --- | --- |\n| VECTOR | `vectorOptions` |\n\n```java\nif (x < 1) {\n  check();\n}\n```';

test("stream preview keeps bold, inline code, visible numbering, nested hierarchy and table values without block widgets", () => {
  const preview = markdownPreview(source, 1200), projected = dingTalkProgressContent(preview);
  const html = marked.parse(projected) as string;
  assert.match(html, /<strong>三类规则<\/strong>/); assert.match(html, /<strong>普通索引<\/strong>/);
  assert.match(html, /<code>checkIndexProperties<\/code>/); assert.match(html, /<strong>1\\?\.<\/strong>/);
  assert.ok(projected.includes("• 校验 key")); assert.ok(projected.includes("VECTOR")); assert.ok(projected.includes("vectorOptions"));
  assert.doesNotMatch(projected, /将在最终答复|```/); assert.doesNotMatch(html, /<table|<pre|<ol|<ul/);
  assert.deepEqual(Lexer.lex(projected).map(token => token.type), ["paragraph"]);
  assert.ok(dingTalkPlainText(preview).includes("VECTOR")); assert.ok(dingTalkPlainText(preview).includes("校验 key"));
});

test("every partial frame remains structurally closed and cannot inject native HTML or extra copy widgets", () => {
  const examples = [source, '1. **未完成标题\n\n| Option | 值 |\n|---|---|\n| `expiration', '[label](https://example.test/path)', '<script>alert(1)</script>\n\n`<img src=x onerror=bad>`'];
  for (const text of examples) for (let i = 1; i <= text.length; i++) {
    const output = dingTalkProgressContent(markdownPreview(text.slice(0, i), 160));
    const tokens = Lexer.lex(output); assert.ok(tokens.every(token => token.type === "paragraph" || token.type === "space"));
    assert.ok(!(marked.parse(output) as string).includes('<script>')); assert.ok(!output.includes('```'));
  }
});

test("truncation closes formatting and never leaks Gateway action JSON; final source stays intact", () => {
  const raw = '**很长的标题**\n\n' + '测试😀'.repeat(100) + '\n\n```codex-im-gateway-actions\n{"send":[{"path":"/private/value"}]}\n```';
  const copy = raw, output = markdownPreview(raw, 30);
  assert.ok(output.endsWith("…")); assert.equal(raw, copy); assert.ok(!output.includes("/private/value"));
  assert.match(marked.parse(output) as string, /<strong>很长的标题<\/strong>/);
  assert.equal(markdownPreview('```codex-im-gateway-actions\n{"send":[{"path":"/private/value"}]}\n```'), "");
});

test("long code previews keep at most twelve visible lines and never add copy widgets", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
  const output = markdownPreview('```text\n' + lines.join('\n') + '\n```', 10_000);
  assert.ok(output.endsWith("…")); assert.ok(output.includes("line11")); assert.ok(!output.includes("line12"));
  assert.doesNotMatch(marked.parse(dingTalkProgressContent(output)) as string, /<pre/);
});
