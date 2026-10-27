import assert from "node:assert/strict";
import test from "node:test";
import { parseActionBlocks } from "../src/bridge/actions.js";

const action = '```codex-im-gateway-actions\n{"send":[{"type":"file","path":"/tmp/should-not-send"}],"control":[{"type":"thread.reset"}]}\n```';
for (const text of ["````markdown\n" + action + "\n````", action.split("\n").map(line => "> " + line).join("\n"),
  "- example\n\n" + action.split("\n").map(line => "  " + line).join("\n")]) test("quoted or nested action examples cannot send files or reset a thread", () => {
  const result = parseActionBlocks(text);
  assert.deepEqual(result.actions, { send: [], control: [], remember: [] });
  assert.equal(result.visibleText, text);
});
test("an unfinished action fence cannot execute an apparently complete JSON payload", () => {
  const result = parseActionBlocks(action.slice(0, -3), { strict: false });
  assert.deepEqual(result.actions, { send: [], control: [], remember: [] });
});
test("optional invalid actions keep the answer visible, omit raw payloads and fail closed as one response", () => {
  const result = parseActionBlocks("first paragraph\n\n" + action + '\n\n```codex-im-gateway-actions\n{"send": [broken}\n```\n\nlast paragraph', { strict: false });
  assert.deepEqual(result.actions, { send: [], control: [], remember: [] });
  assert.match(result.visibleText, /first paragraph/); assert.match(result.visibleText, /last paragraph/);
  assert.doesNotMatch(result.visibleText, /broken|should-not-send|codex-im-gateway-actions/);
  assert.match(result.visibleText, /未执行/);
});
test("the three personal-knowledge limit applies to the whole response, including multiple aliases and CRLF", () => {
  const block = (name: string, title: string) => `\`\`\`${name}-actions\r\n${JSON.stringify({ remember: Array.from({ length: 3 }, (_, i) => ({ kind: "knowledge", scope: "account", title: title + i, content: "durable fact" })) })}\r\n\`\`\``;
  const result = parseActionBlocks(block("codex-im-gateway", "first") + "\r\n\r\n" + block("codex-weixin", "second"));
  assert.equal(result.actions.remember.length, 3);
});
