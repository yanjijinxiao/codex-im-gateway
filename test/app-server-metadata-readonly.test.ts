import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

test("metadata-only transport ignores foreign native approvals and refuses controls/history hydration on the wire", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-wire-")), fixture = path.join(root, "fixture.mjs");
  fs.writeFileSync(fixture, `import readline from 'node:readline';
let decisions=0;
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.method){decisions++;return;}
 if(m.method==='initialize'){send({id:m.id,result:{}});return;}
 if(m.method==='initialized')return;
 if(m.method==='config/read'){send({id:m.id,result:{config:{model:'read-only-model',model_reasoning_effort:'high'}}});return;}
 if(m.method==='thread/read'){
  send({id:'foreign-command',method:'item/commandExecution/requestApproval',params:{threadId:'foreign',turnId:'turn',itemId:'item',command:'NEVER_EXECUTE'}});
  send({id:'foreign-mcp',method:'mcpServer/elicitation/request',params:{threadId:'foreign',turnId:'turn',serverName:'tool',mode:'form',message:'Allow?',requestedSchema:{type:'object',properties:{}}}});
  send({id:m.id,result:{thread:{id:m.params.threadId,cwd:'/tmp/project',preview:'decisions:'+decisions,status:{type:'idle'},turns:[]}}});return;
 }
 send({id:m.id,error:{code:-1,message:'unexpected wire method '+m.method}});
});`);
  const runner = new AppServerCodexRunner({ metadataOnly: true, requestTimeoutMs: 1000,
    transport: { command: process.execPath, args: [fixture], mode: "remote-daemon" } });
  t.after(() => { runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const read = () => runner.inspectThread("thread", { includeTurns: false, timeoutMs: 500 });
  assert.equal((await read()).preview, "decisions:0");
  assert.equal((await runner.getRuntimeInfo("/tmp/project")).model, "read-only-model");
  await assert.rejects(runner.archiveThread("thread"), /Metadata-only/);
  await assert.rejects(runner.getHistory("thread"), /Metadata-only/);
  assert.equal((await read()).preview, "decisions:0", "read-only observation must not even decline foreign approvals");
});

test("closing an observer during prepare cannot spawn a late proxy process", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-close-")), marker = path.join(root, "spawned");
  let ready!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const prepared = new Promise<void>(resolve => { entered = resolve; });
  const runner = new AppServerCodexRunner({ metadataOnly: true, requestTimeoutMs: 100,
    transport: { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'spawned')`],
      prepare: () => { entered(); return waiting; } } });
  t.after(() => { runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const pending = runner.inspectThread("thread", { includeTurns: false, timeoutMs: 25 });
  await prepared; runner.close(); ready();
  await assert.rejects(pending, /closed/);
  assert.equal(fs.existsSync(marker), false);
});
