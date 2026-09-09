// Explicit opt-in live protocol smoke test. Creates one ephemeral, read-only
// thread and never sends a message to an IM account or an existing user thread.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.ts";

if (process.argv[2] !== "--run") {
  console.log("Run explicitly: TMPDIR=/private/tmp node --import tsx scripts/verify-live-intervention.mjs --run [codex-binary]");
  process.exit(0);
}
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-live-intervention-"));
const runner = new AppServerCodexRunner({
  codexBin: process.argv[3] ?? "codex", requestTimeoutMs: 30_000, sandbox: "read-only"
});
let threadId;
let turnId;
let steered = false;
let attempted = false;
let checking = false;
let testError;
const deadline = setTimeout(() => {
  testError = new Error("Live intervention test exceeded 90 seconds");
  runner.close();
}, 90_000);
const poll = setInterval(async () => {
  if (!threadId || checking || attempted) return;
  checking = true;
  try {
    const state = await runner.inspectThread(threadId);
    if (!state.activeTurnId) return;
    turnId = state.activeTurnId;
    attempted = true;
    const response = await runner.steer({
      threadId, expectedTurnId: turnId, prompt: "修改最终输出：只回复 STAGE2_STEER_OK。"
    });
    assert.equal(response.turnId, turnId);
    steered = true;
  } catch (error) { testError = error; }
  finally { checking = false; }
}, 500);
try {
  const result = await runner.run({
    cwd, ephemeral: true, sandbox: "read-only",
    prompt: "这是网关协议回归测试。先执行只读命令 sleep 5，再回复 ORIGINAL_RESULT；若收到补充要求，以补充要求为准。不要读写其他文件。",
    onThreadCreated: (id) => { threadId = id; }
  });
  if (testError) throw testError;
  assert.equal(steered, true);
  assert.match(result.text, /STAGE2_STEER_OK/);
  console.log(JSON.stringify({ passed: true, ephemeral: true, guardedSteer: true, turnId }));
} finally {
  clearInterval(poll);
  clearTimeout(deadline);
  runner.close();
  fs.rmSync(cwd, { recursive: true, force: true });
}
