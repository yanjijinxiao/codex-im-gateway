import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexExecRunner } from "../src/codex/exec-runner.js";

test("a newly started CLI thread is identified and can be stopped before process completion", async () => {
  const runner = new CodexExecRunner({ codexBin: fileURLToPath(new URL("./fixtures/fake-codex-exec-hold.mjs", import.meta.url)) });
  const identity = Promise.withResolvers<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = runner.run({ prompt: "synthetic", cwd: fileURLToPath(new URL("./fixtures", import.meta.url)),
    onThreadCreated(id) { identity.resolve(id); } }).then(() => undefined, error => error);
  try {
    const threadId = await Promise.race([identity.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("no identity before child completion")), 1500); })]);
    assert.equal(threadId, "thread-hold");
    assert.equal(await runner.stop("unrelated-thread"), "not-active");
    assert.equal(await runner.stop(threadId), "interrupted");
    assert.match(String(await work), /exited with code/);
  } finally { if (timer) clearTimeout(timer); runner.close(); await work; }
});

test("fragmented CLI records publish only the first identity, preserve Unicode, and await the identity journal", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-fragmented-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "synthetic.mjs");
  fs.writeFileSync(script, `const rows = [{type:"thread.started",thread_id:"first"},{type:"thread.started",thread_id:"later"},{type:"item.completed",item:{type:"agent_message",text:"中文答复🙂"}}];
const data=Buffer.from(rows.map(x=>JSON.stringify(x)).join("\\n"));
for(let p=0;p<data.length;p+=3){process.stdout.write(data.subarray(p,p+3));await new Promise(r=>setImmediate(r));}`);
  const runner = new CodexExecRunner({ codexBin: script }); t.after(() => runner.close());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const identities: string[] = []; let finished = false, turnReceipts = 0;
  const pending = runner.run({ cwd: root, prompt: "synthetic", onThreadCreated: async id => { identities.push(id); entered.resolve(); await release.promise; },
    onTurnStarted() { turnReceipts++; } }).then(result => { finished = true; return result; });
  t.after(() => release.resolve());
  await entered.promise;
  assert.equal(finished, false);
  release.resolve();
  const result = await pending;
  assert.deepEqual(identities, ["first"]); assert.equal(result.threadId, "first");
  assert.equal(result.text, "中文答复🙂"); assert.equal(turnReceipts, 0);
});

test("an identity journal failure is returned after the CLI exits without launching a replacement", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-journal-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "synthetic.mjs");
  fs.writeFileSync(script, `console.log(JSON.stringify({type:"thread.started",thread_id:"first"}));console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));`);
  const runner = new CodexExecRunner({ codexBin: script }); t.after(() => runner.close());
  let calls = 0;
  await assert.rejects(runner.run({ cwd: root, prompt: "synthetic", async onThreadCreated() { calls++; throw Error("journal unavailable"); } }), /journal unavailable/);
  assert.equal(calls, 1); assert.equal(await runner.stop("first"), "not-active");
});
