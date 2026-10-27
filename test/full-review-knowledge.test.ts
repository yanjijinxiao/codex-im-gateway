import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LlmWikiMcpClientPool } from "../src/knowledge/llm-wiki-mcp-client.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { BridgeService } from "../src/bridge/service.js";

function fixture(t: test.TestContext, source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-review-wiki-")), wiki = path.join(root, "wiki"), bin = path.join(wiki, ".venv/bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "llm-wiki"), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  const pool = new LlmWikiMcpClientPool(); t.after(() => { pool.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, wiki, pool, kb: { id: "knowledge", name: "wiki", rootPath: wiki, createdAt: "now", updatedAt: "now" } };
}
test("concurrent knowledge calls wait for the same completed MCP initialization", { timeout: 5000 }, async t => {
  const f = fixture(t, `const fs=require('node:fs'), path=require('node:path'), rl=require('node:readline').createInterface({input:process.stdin});
    const root=path.dirname(process.argv[3]), send=(m)=>console.log(JSON.stringify(m));let ready=false;
    rl.on('line',line=>{const m=JSON.parse(line);
      if(m.method==='initialize'){fs.writeFileSync(path.join(root,'entered'),'1');const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'release'))){clearInterval(timer);ready=true;send({id:m.id,result:{}});}},5);}
      if(m.method==='tools/list') send({id:m.id,result:{tools:[{name:'search'},{name:'get_document'}]}});
      if(m.method==='tools/call') send({id:m.id,result: ready ? {structuredContent:{ok:true}} : {isError:true,content:[{text:'called before initialization'}]}});
    });`);
  const first = f.pool.call(f.kb, "search", { query: "first" });
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(path.join(f.root, "entered"))) { assert.ok(Date.now() < deadline); await delay(5); }
  const all = Promise.allSettled([first, f.pool.call(f.kb, "search", { query: "second" })]);
  await delay(20); fs.writeFileSync(path.join(f.root, "release"), "1");
  const results = await all;
  assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results));
});

test("an old knowledge delete button retains its entry after the list order changes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-knowledge-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)), cards: any[] = [];
  const service = new BridgeService({ stateStore: store, config: defaultConfig(root),
    weixin: { async sendText() { return { messageId: "text" }; }, async sendActionCard(input) { cards.push(input.card); return { messageId: "card" }; } } }) as any;
  store.rememberKnowledge({ kind: "knowledge", scope: "account", title: "Original", content: "original" });
  const original = store.listKnowledge()[0];
  await service.handleMemoryCommand("chat", "");
  const button = cards[0].actionGroups.flat().find((action: any) => action.label.startsWith("删除"));
  store.rememberKnowledge({ kind: "knowledge", scope: "account", title: "New", content: "new" });
  await service.handleMemoryCommand("chat", button.value.arg);
  assert.equal(store.listKnowledge().some(entry => entry.id === original.id), false);
  assert.equal(store.listKnowledge().some(entry => entry.title === "New"), true);
});
test("failed MCP initialization closes the unready child and the next call initializes a replacement", { timeout: 5000 }, async t => {
  const f = fixture(t, `const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});
    const marker=path.join(path.dirname(process.argv[3]),'attempts'), n=Number(fs.existsSync(marker)?fs.readFileSync(marker,'utf8'):0)+1;fs.writeFileSync(marker,String(n));
    const send=m=>console.log(JSON.stringify(m));let ready=false;
    rl.on('line',line=>{const m=JSON.parse(line);
      if(m.method==='initialize'){ready=n>1;send(ready?{id:m.id,result:{}}:{id:m.id,error:{message:'initialization rejected'}});}
      if(m.method==='tools/list')send({id:m.id,result:{tools:[{name:'search'},{name:'get_document'}]}});
      if(m.method==='tools/call')send({id:m.id,result:ready?{structuredContent:{ok:true}}:{isError:true,content:[{text:'unready child reused'}]}});
    });`);
  await assert.rejects(f.pool.call(f.kb, "search", { query: "first" }), /initialization rejected/);
  assert.match(await f.pool.call(f.kb, "search", { query: "retry" }), /"ok": true/);
  assert.equal(fs.readFileSync(path.join(f.root, "attempts"), "utf8"), "2");
});
for (const scenario of ["symlink", "oversized"] as const) test(`legacy knowledge reads reject ${scenario} documents`, async t => {
  const f = fixture(t, `const cmd=process.argv[2];if(cmd==='mcp'){console.error("No such command 'mcp'");process.exitCode=2;}
    else if(cmd==='status')console.log(JSON.stringify({documents:1,blocks:1,cas_blobs:1}));
    else if(cmd==='trace')console.log(JSON.stringify({relative_path:'document.md'}));else console.log('[]');`);
  if (scenario === "symlink") { const outside = path.join(f.root, "outside.md"); fs.writeFileSync(outside, "outside evidence"); fs.symlinkSync(outside, path.join(f.wiki, "document.md")); }
  else fs.writeFileSync(path.join(f.wiki, "document.md"), "x".repeat(2 * 1024 * 1024 + 1));
  await f.pool.inspect(f.kb);
  await assert.rejects(f.pool.call(f.kb, "get_document", { document_id: "document" }), scenario === "symlink" ? /外部路径/ : /过大|大小|上限/);
});
