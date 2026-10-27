import assert from "node:assert/strict";
import test from "node:test";

import { parseActionBlocks } from "../src/bridge/actions.js";

test("parses explicit codex-im-gateway action blocks and ignores prose paths", () => {
  const text = [
    "Report saved at C:/tmp/report.pdf but do not send it.",
    "```codex-im-gateway-actions",
    JSON.stringify({
      send: [
        { type: "image", path: "C:/tmp/chart.png" },
        { type: "file", path: "/tmp/report.pdf" }
      ],
      control: [{ type: "thread.reset" }]
    }),
    "```"
  ].join("\n");

  const parsed = parseActionBlocks(text);

  assert.equal(parsed.actions.send.length, 2);
  assert.deepEqual(parsed.actions.control, [{ type: "thread.reset" }]);
  assert.equal(parsed.visibleText.includes("C:/tmp/report.pdf"), true);
});

test("rejects relative outbound file paths in action blocks", () => {
  const text = [
    "```codex-im-gateway-actions",
    JSON.stringify({ send: [{ type: "file", path: "relative/report.pdf" }] }),
    "```"
  ].join("\n");

  assert.throws(() => parseActionBlocks(text), /absolute path/i);
});

test("accepts legacy codex-channel-bridge action blocks", () => {
  const parsed = parseActionBlocks([
    "```codex-channel-bridge-actions",
    JSON.stringify({ send: [{ type: "file", path: "/tmp/legacy.txt" }] }),
    "```"
  ].join("\n"));

  assert.deepEqual(parsed.actions.send, [{ type: "file", path: "/tmp/legacy.txt" }]);
});

test("keeps local markdown images as references without implicit sends or lost prose", () => {
  const text = [
    "找到了这张，来自下载目录：",
    "",
    "![generated_image_latest.png](C:/Users/THU/Downloads/generated_image_latest.png)",
    "",
    "如果图片没有直接显示，点这里打开：[generated_image_latest.png](C:/Users/THU/Downloads/generated_image_latest.png)"
  ].join("\n");

  const parsed = parseActionBlocks(text);

  assert.deepEqual(parsed.actions.send, []);
  assert.equal(parsed.visibleText.includes("Downloads/generated_image_latest.png"), true);
  assert.equal(parsed.visibleText.includes("如果图片没有直接显示"), true);
  assert.equal(parsed.visibleText.startsWith("找到了这张，来自下载目录："), true);
  assert.equal(parsed.visibleText.includes("]("), false);
});

test("keeps local markdown files as references without implicit sends", () => {
  const parsed = parseActionBlocks("报告在这里：[report.pdf](C:\\Users\\THU\\Downloads\\report.pdf)");

  assert.deepEqual(parsed.actions.send, []);
  assert.equal(parsed.visibleText, "报告在这里：Downloads/report.pdf");
});

test("parses explicit video send actions", () => {
  const text = [
    "```codex-weixin-actions",
    JSON.stringify({ send: [{ type: "video", path: "C:/Users/THU/Desktop/demo.mp4" }] }),
    "```"
  ].join("\n");

  const parsed = parseActionBlocks(text);

  assert.deepEqual(parsed.actions.send, [
    { type: "video", path: "C:/Users/THU/Desktop/demo.mp4" }
  ]);
  assert.equal(parsed.visibleText, "");
});

test("keeps local markdown videos as references without implicit sends", () => {
  const parsed = parseActionBlocks("Random desktop video: [demo.mp4](C:/Users/THU/Desktop/demo.mp4)");

  assert.deepEqual(parsed.actions.send, []);
  assert.equal(parsed.visibleText, "Random desktop video: Desktop/demo.mp4");
});

test("preserves both remote source citations and their entire explanatory lines", () => {
  const parsed = parseActionBlocks([
    "这两个都是无状态辅助类，但职责不同。",
    "1. [RegularTablePropertyPolicy](/home/admin/project/RegularTablePropertyPolicy.java:32) 负责属性过滤。",
    "2. [SchemaPartSupport](/home/admin/project/SchemaPartSupport.java:20) 负责构造 AST。",
    "保留后续说明。"
  ].join("\n"));

  assert.deepEqual(parsed.actions.send, []);
  assert.equal(parsed.visibleText, [
    "这两个都是无状态辅助类，但职责不同。",
    "1. RegularTablePropertyPolicy（project/RegularTablePropertyPolicy.java:32） 负责属性过滤。",
    "2. SchemaPartSupport（project/SchemaPartSupport.java:20） 负责构造 AST。",
    "保留后续说明。"
  ].join("\n"));
});

test("renders local URI, angle-bracket, fragment and Windows references without sends", () => {
  for (const [link, target] of [
    ["[source](file:///tmp/source.ts#L12)", "tmp/source.ts:12"],
    ["[source](</tmp/My Project (copy)/source.ts:12:3>)", "My Project (copy)/source.ts:12"],
    ["[source](/tmp/My%20Project/source.ts#L12-L18)", "My Project/source.ts:12"],
    ["[source](C:\\work\\source.ts:12)", "work/source.ts:12"],
    ["[source](\\\\server\\share\\source.ts)", "share/source.ts"],
    ["[source](/tmp/`source`.ts)", "tmp/`source`.ts"]
  ]) {
    const parsed = parseActionBlocks(link);
    assert.deepEqual(parsed.actions.send, []);
    assert.ok(parsed.visibleText.includes(target));
    assert.ok(parsed.visibleText.startsWith("source（"));
    assert.ok(!parsed.visibleText.includes("]("));
  }
});

test("leaves web and relative links unchanged", () => {
  const text = "[docs](https://example.com/docs#L12) ![image](https://example.com/image.png) [relative](./source.ts)";
  assert.deepEqual(parseActionBlocks(text), {
    visibleText: text, actions: { send: [], control: [], remember: [] }
  });
});

test("only explicit actions send attachments alongside references, with deduplication", () => {
  const parsed = parseActionBlocks([
    "源码：[source](/home/admin/project/source.ts:12)，附件：[report](/tmp/report.pdf)。",
    "```codex-im-gateway-actions",
    JSON.stringify({ send: [
      { type: "file", path: "/tmp/report.pdf" },
      { type: "file", path: "/tmp/report.pdf" },
      { type: "image", path: "/tmp/image.png" },
      { type: "video", path: "/tmp/video.mp4" }
    ] }),
    "```"
  ].join("\n"));
  assert.deepEqual(parsed.actions.send, [
    { type: "file", path: "/tmp/report.pdf" },
    { type: "image", path: "/tmp/image.png" },
    { type: "video", path: "/tmp/video.mp4" }
  ]);
  assert.match(parsed.visibleText, /源码：source/);
  assert.match(parsed.visibleText, /附件：report/);
  assert.ok(!parsed.visibleText.includes("codex-im-gateway-actions"));
});

test("accepts legacy codex-weixin-server action blocks from existing threads", () => {
  const parsed = parseActionBlocks([
    "```codex-weixin-server-actions",
    JSON.stringify({ send: [{ type: "file", path: "/tmp/legacy.txt" }] }),
    "```"
  ].join("\n"));

  assert.deepEqual(parsed.actions.send, [{ type: "file", path: "/tmp/legacy.txt" }]);
});

test("parses bounded personal knowledge actions", () => {
  const parsed = parseActionBlocks([
    "已按你的习惯处理。",
    "```codex-weixin-actions",
    JSON.stringify({
      remember: [
        { kind: "preference", scope: "account", title: "回复语言", content: "默认使用简体中文" },
        { kind: "workflow", scope: "project", title: "发布检查", content: "发布前先运行测试和构建" }
      ]
    }),
    "```"
  ].join("\n"));

  assert.equal(parsed.visibleText, "已按你的习惯处理。");
  assert.deepEqual(parsed.actions.remember, [
    { kind: "preference", scope: "account", title: "回复语言", content: "默认使用简体中文" },
    { kind: "workflow", scope: "project", title: "发布检查", content: "发布前先运行测试和构建" }
  ]);
});

test("ignores malformed optional knowledge without hiding the reply", () => {
  const parsed = parseActionBlocks([
    "正常回复。",
    "```codex-weixin-actions",
    JSON.stringify({ remember: [{ kind: "secret", scope: "account", title: "x", content: "y" }] }),
    "```"
  ].join("\n"));

  assert.equal(parsed.visibleText, "正常回复。");
  assert.deepEqual(parsed.actions.remember, []);
});
