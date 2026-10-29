import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { CodexHistoryReader, type HistoryConnection } from "../src/codex/history-reader.js";
import type { CodexThreadSnapshot, CodexThreadState } from "../src/codex/backend.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";

const state = (id: string): CodexThreadState => ({ threadId: id, persistence: "active", runtimeStatus: "active",
  activeTurnId: "native-turn", activeFlags: [] });
const snapshot = (id: string): CodexThreadSnapshot => ({ state: state(id), turns: [] });
const history = (read: HistoryConnection["readThreadSnapshot"], close = () => {}): HistoryConnection => ({
  readThreadSnapshot: read, getHistory: async () => [], getHistoryPage: async () => ({ messages: [] }), close
});

test("stalled history cannot block current input, native queue controls, status or the restart gate", async t => {
  const blocked = Promise.withResolvers<CodexThreadSnapshot>();
  const entered = Promise.withResolvers<void>();
  const writes: string[] = [], historyHosts: string[] = [], metadataHosts: string[] = [];
  const router = new CodexBackendRouter({ backend: "app-server",
    appServerBackend: { capabilities: APP_SERVER_BACKEND_CAPABILITIES, inspectThread() { assert.fail("preflight used the blocked execution reader"); },
      async steer(input: { expectedTurnId: string }) { writes.push(input.expectedTurnId); return { status: "accepted", threadId: "thread", turnId: "native-turn" }; },
      async listQueuedSubmissions() { return { data: [] }; },
      addQueuedSubmission() { assert.fail("unexpected queue submission"); },
      deleteQueuedSubmission() { assert.fail("unexpected queue deletion"); },
      runQueuedSubmission() { assert.fail("unexpected queue execution"); },
      hasRestartBlockingWork: () => false, close() {}
    } as never,
    metadataConnectionFactory: host => { metadataHosts.push(host); return {
      inspectThread: async id => state(id), listProjects: async () => ({ backend: "app-server", projects: [] }), close() {}
    }; },
    historyConnectionFactory: host => { historyHosts.push(host); return history(() => { entered.resolve(); return blocked.promise; }); }
  });
  t.after(() => { blocked.resolve(snapshot("thread")); return router.close(); });
  const reading = router.readThreadSnapshot("thread");
  await entered.promise;
  assert.equal((await router.submitThreadMessage({ threadId: "thread", prompt: "follow-up", cwd: "/tmp/project",
    clientUserMessageId: "stable-follow-up" })).turnId, "native-turn");
  assert.deepEqual((await router.listQueuedSubmissions("thread")).data, []);
  assert.equal((await router.inspectThread("thread", "local", { includeTurns: false, timeoutMs: 100, purpose: "status" })).activeTurnId, "native-turn");
  assert.equal(router.hasRestartBlockingWork(), false, "passive history must not become a restart obligation");
  assert.deepEqual(writes, ["native-turn"]);
  assert.deepEqual(historyHosts, ["local"]); assert.deepEqual(metadataHosts, ["local", "local"]);
  blocked.resolve(snapshot("thread")); await reading;
});

test("a timed-out history connection is replaced without closing the writer or accepting a late snapshot", async t => {
  let created = 0, writerClosed = 0, retired = 0;
  const late = Promise.withResolvers<CodexThreadSnapshot>();
  const router = new CodexBackendRouter({ backend: "app-server", timeoutMs: 40,
    appServerBackend: { close() { writerClosed++; } } as never,
    metadataConnectionFactory: () => ({ inspectThread: async id => state(id),
      listProjects: async () => ({ backend: "app-server", projects: [] }), close() {} }),
    historyConnectionFactory: () => {
      const generation = ++created;
      return history(id => generation === 1 ? late.promise : Promise.resolve(snapshot(id)), () => { retired++; });
    }
  });
  t.after(() => router.close());
  assert.equal((await router.readThreadSnapshot("thread")).state.threadId, "thread");
  assert.equal(retired, 1); assert.equal(writerClosed, 0);
  late.resolve(snapshot("foreign"));
  assert.equal((await router.readThreadSnapshot("thread")).state.threadId, "thread");
  assert.equal(created, 2); assert.equal(writerClosed, 0);
});

test("history paging shares only identical in-flight host, thread and cursor observations", async t => {
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  const reader = new CodexHistoryReader(host => ({ ...history(async id => snapshot(id)),
    async getHistoryPage(id, input) { calls.push(JSON.stringify([host, id, input?.cursor])); await gate.promise; return { messages: [] }; }
  }));
  t.after(() => reader.close());
  const a = reader.page("thread", { cursor: "one" }, "local", 1000);
  assert.equal(a, reader.page("thread", { cursor: "one" }, "local", 1000));
  const b = reader.page("thread", { cursor: "two" }, "local", 1000);
  const c = reader.page("thread", { cursor: "one" }, "remote", 1000);
  gate.resolve(); await Promise.all([a, b, c]); assert.equal(calls.length, 3);
  await reader.page("thread", { cursor: "one" }, "local", 1000); assert.equal(calls.length, 4);
});

test("history shutdown cancels a stalled read; foreign snapshots and semantic errors are never retried", async () => {
  let created = 0;
  const reader = new CodexHistoryReader(() => { created++; return history(async id => {
    if (id === "stalled") return new Promise(() => {});
    if (id === "missing") throw new Error("thread no longer exists");
    return snapshot("foreign");
  }); });
  await assert.rejects(reader.snapshot("thread", "local", 100), /different thread/);
  await assert.rejects(reader.snapshot("missing", "local", 100), /no longer exists/);
  const pending = reader.snapshot("stalled", "local", 10_000);
  reader.close(); await assert.rejects(pending, { name: "CodexCommunicationError" });
  assert.equal(created, 1);
});

test("background snapshots avoid giant tool outputs; isolated explicit history retains commentary and refuses native decisions", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-wire-")), fixture = path.join(root, "fixture.mjs");
  const trace = path.join(root, "trace.jsonl");
  fs.writeFileSync(fixture, `import readline from 'node:readline'; import fs from 'node:fs';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(trace)},line+'\\n');
 if(m.method==='initialize'){send({id:m.id,result:{}});return;}
 if(m.method==='initialized')return;
 if(m.method==='thread/read'){
  send({id:'foreign',method:'item/commandExecution/requestApproval',params:{threadId:'foreign',turnId:'other',itemId:'item',command:'NEVER_EXECUTE'}});
  send({id:m.id,result:{thread:{id:m.params.threadId,status:{type:'idle'},turns:[]}}});return;
 }
 if(m.method==='thread/turns/list'){
  if(m.params.threadId==='loop'){send({id:m.id,result:{data:[],nextCursor:'same'}});return;}
  let items=[{id:'user',type:'userMessage',clientId:'stable-origin',content:[{type:'text',text:'hello'}]},
   {id:'progress',type:'agentMessage',phase:'commentary',text:'working'}, {id:'final',type:'agentMessage',text:'done'}];
  if(m.params.itemsView==='full') items.push({id:'tool',type:'commandExecution',aggregatedOutput:'x'.repeat(8*1024*1024)});
  else items=items.filter(i=>i.id!=='progress');
  const turn={id:'turn',status:'completed',items};
  send({id:m.id,result:m.params.cursor?{data:[]}:{data:[turn],nextCursor:'next'}});return;
 }
 send({id:m.id,error:{code:-1,message:'unexpected method '+m.method}});
});`);
  const runner = new AppServerCodexRunner({ historyOnly: true, requestTimeoutMs: 1000,
    transport: { command: process.execPath, args: [fixture], mode: "remote-daemon" } });
  t.after(() => { runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = await runner.getHistory("long-lived-thread");
  assert.deepEqual(messages.map(m => m.text), ["hello", "working", "done"]);
  assert.equal(messages[0].clientUserMessageId, "stable-origin"); assert.equal(messages[1].kind, "progress");
  const before = fs.readFileSync(trace, "utf8").trim().split("\n").length;
  assert.equal((await runner.readThreadSnapshot("long-lived-thread")).turns[0]?.id, "turn");
  const snapshotReads = fs.readFileSync(trace, "utf8").trim().split("\n").slice(before).map(line => JSON.parse(line));
  assert.equal(snapshotReads.find(r => r.method === "thread/turns/list")?.params.itemsView, "summary");
  await assert.rejects(runner.getHistory("loop"), /repeated cursor/);
  await assert.rejects(runner.archiveThread("thread"), /History-only/);
  await assert.rejects(runner.listQueuedSubmissions("thread"), /History-only/);
  const raw = runner as unknown as { request(method: string, params: Record<string, unknown>): Promise<unknown> };
  await assert.rejects(raw.request("thread/read", { threadId: "thread", includeTurns: true }), /History-only/);
  await assert.rejects(raw.request("thread/turns/list", { threadId: "thread", itemsView: "full", limit: 1000 }), /History-only/);
  const requests = fs.readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(requests.some(r => r.id === "foreign"), false, "observer must not answer or decline foreign approvals");
  assert.equal(requests.some(r => r.method === "thread/read" && r.params.includeTurns !== false), false);
  assert.equal(requests.filter(r => r.method === "thread/turns/list").every(r => r.params.limit <= 100), true);
  assert.equal(requests.some(r => ["thread/resume", "turn/start", "turn/steer", "thread/queue/add"].includes(r.method)), false);
});
