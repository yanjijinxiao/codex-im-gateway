import assert from "node:assert/strict";
import test from "node:test";
import { parseActionBlocks } from "../src/bridge/actions.js";

for(const newline of ["\n","\r\n"])test(`an actual action cannot splice an identical earlier fenced example: ${JSON.stringify(newline)}`,()=>{
  const action=['```codex-im-gateway-actions','{"send":[{"type":"file","path":"/tmp/example.txt"}]}','```'].join(newline);
  const example=['````markdown',action,'````'].join(newline),prose="示例保留，下面实际发送附件。";
  const parsed=parseActionBlocks(example+newline+newline+prose+newline+newline+action);
  assert.equal(parsed.visibleText,example+newline+newline+prose);
  assert.deepEqual(parsed.actions.send,[{type:"file",path:"/tmp/example.txt"}]);
});
