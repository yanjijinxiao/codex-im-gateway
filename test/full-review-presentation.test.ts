import assert from "node:assert/strict";
import test from "node:test";
import { presentAssistantText, projectAssistantProse } from "../src/channels/assistant-presentation.js";
import { dingTalkPlainText } from "../src/channels/dingtalk-markdown.js";

const directive = '::code-comment{title="finding" body="body" file="/work/file.ts" start=1}';
for (const newline of ["\r\n", "\r"]) test(`Markdown projection keeps protected original bytes for ${JSON.stringify(newline)} input`, () => {
  for (const source of [`\`\`\`text${newline}${directive}${newline}\`\`\``, `> ${directive}${newline}> quoted`,
    `paragraph \`${directive}\`${newline}tail`]) {
    assert.equal(presentAssistantText(source), source);
    assert.equal(projectAssistantProse(source, text => text.replaceAll("finding", "changed")), source);
  }
  const source = `\`\`\`text${newline}literal${newline}\`\`\`${newline}${newline}${directive}`;
  const result = presentAssistantText(source);
  assert.ok(result.startsWith(`\`\`\`text${newline}literal${newline}\`\`\``));
  assert.ok(!result.slice(result.indexOf("literal") + 7).includes(directive));
});
test("plain DingTalk transport unwraps CRLF fenced exact replies without exposing code wrappers", () => {
  const command = "/approve A1 accept";
  assert.equal(dingTalkPlainText(`说明\r\n\r\n\`\`\`text\r\n${command}\r\n\`\`\``), `说明\r\n\r\n${command}`);
});
