import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexExecRunner } from "../src/codex/exec-runner.js";
import { CodexSessionCompletionMonitor } from "../src/server/codex-session-monitor.js";
import { DiagnosticTail } from "../src/codex/diagnostic-tail.js";

test("diagnostic byte budgets remain bounded for Unicode and arbitrary binary chunks", () => {
  for (const budget of [64, 65, 127, 256]) {
    const tail = new DiagnosticTail(budget);
    tail.append("small"); assert.equal(tail.text(), "small");
    for (let i = 0; i < 100; i++) {
      tail.append(i % 2 ? Buffer.alloc(83, 0xff) : "中文🙂".repeat(i));
      assert.ok(Buffer.byteLength(tail.text()) <= budget, `budget ${budget}, chunk ${i}`);
    }
    assert.match(tail.text(), /truncated/);
  }
});

test("an oversized CLI record cannot be returned as a successful partial answer", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-record-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "synthetic.mjs");
  fs.writeFileSync(script, `console.log(JSON.stringify({type:"thread.started",thread_id:"first"}));console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"x".repeat(17*1024*1024)}}));console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"partial"}}));`);
  const runner = new CodexExecRunner({ codexBin: script }); t.after(() => runner.close());
  const identities: string[] = [];
  await assert.rejects(runner.run({ cwd: root, prompt: "synthetic", onThreadCreated(id) { identities.push(id); } }), /16 MiB.*unconfirmed/);
  assert.deepEqual(identities, ["first"]);
});

test("App Server raw diagnostics are bounded independently of the complete answer", async () => {
  const runner: any = new AppServerCodexRunner(), answer = "完整答复。".repeat(60_000);
  const work = runner.waitForTurn("thread", "turn");
  for (let i = 0; i < 600; i++) runner.handleMessage(JSON.stringify({ method: "item/completed", params: {
    threadId: "thread", turnId: "turn", item: { type: "synthetic-diagnostic", output: "d".repeat(4096) } } }));
  runner.handleMessage(JSON.stringify({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { type: "agentMessage", text: answer } } }));
  runner.handleMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } }));
  const result = await work;
  assert.equal(result.text, answer);
  assert.ok(Buffer.byteLength(result.raw) <= 256 * 1024);
  assert.match(result.raw, /diagnostic.*truncated/i);
  await runner.close();
});

test("unobserved completed turns release payloads while a start acknowledgement race retains its result", async () => {
  const runner: any = new AppServerCodexRunner();
  const complete = (id: string) => {
    runner.handleMessage(JSON.stringify({ method: "item/completed", params: { threadId: "thread", turnId: id, item: { type: "agentMessage", text: "answer" } } }));
    runner.handleMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id, status: "completed" } } }));
  };
  for (let i = 0; i < 100; i++) complete(String(i));
  for (const name of ["completedTurns", "turnEvents", "turnTexts", "queuedTurnEvents", "itemPhasesByTurn", "reasoningSummariesByTurn"]) assert.equal(runner[name].size, 0, name);
  runner.operationLeases = 1; runner.expectedTurnThreads?.set("other-thread", 1);
  complete("unrelated-operation"); assert.equal(runner.completedTurns.size, 0);
  runner.nativeQueueOrigins.set("unrelated", { threadId: "other-thread" });
  complete("unrelated-queue"); assert.equal(runner.completedTurns.size, 0);
  runner.expectedTurnThreads?.set("thread", 1); complete("early");
  assert.equal((await runner.waitForTurn("thread", "early")).text, "answer");
  runner.operationLeases = 0; await runner.close();
});

test("CLI diagnostics cannot accumulate every output chunk or truncate the final answer", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "synthetic.mjs"), answer = "完整答复。".repeat(60_000);
  fs.writeFileSync(script, `for (let i=0;i<600;i++) console.log(JSON.stringify({type:"diagnostic", output:"d".repeat(4096)})); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:${JSON.stringify(answer)}}}));`);
  const runner = new CodexExecRunner({ codexBin: script }); t.after(() => runner.close());
  const result = await runner.run({ prompt: "synthetic", cwd: root });
  assert.equal(result.text, answer);
  assert.ok(Buffer.byteLength(result.raw) <= 256 * 1024);
  assert.match(result.raw, /diagnostic.*truncated/i);
});

test("rollout growth is read in chunks, preserving split UTF-8 and an unfinished last record", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-monitor-chunks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl"), completions: any[] = [];
  const monitor: any = new CodexSessionCompletionMonitor({ codexHome: root, onCompletion: x => { completions.push(x); } });
  const original = fs.promises.open.bind(fs.promises), allocations: number[] = [];
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    const fd = await original(...args);
    if (String(args[0]) !== file) return fd;
    return { async read(buffer: Buffer, ...rest: any[]) { allocations.push(buffer.length); return (fd.read as any)(buffer, ...rest); }, close: () => fd.close() };
  });
  const rows = [{ type: "session_meta", payload: { id: "thread", cwd: root } }, { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }];
  const prefix = rows.map(x => JSON.stringify(x)).join("\n") + "\n" + (JSON.stringify({ type: "ignored", padding: "d".repeat(8192) }) + "\n").repeat(600);
  const terminal = Buffer.from(JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn", last_agent_message: "未截断的中文答复" } }));
  const cut = terminal.indexOf(Buffer.from("中文")) + 1;
  fs.writeFileSync(file, Buffer.concat([Buffer.from(prefix), terminal.subarray(0, cut)]));
  await monitor.processFile(file);
  assert.equal(completions.length, 0);
  fs.appendFileSync(file, Buffer.concat([terminal.subarray(cut), Buffer.from("\n")]));
  await monitor.processFile(file);
  assert.deepEqual(completions.map(x => [x.sessionId, x.turnId, x.text]), [["thread", "turn", "未截断的中文答复"]]);
  assert.ok(allocations.length > 2);
  assert.ok(Math.max(...allocations) <= 1024 * 1024);
});
