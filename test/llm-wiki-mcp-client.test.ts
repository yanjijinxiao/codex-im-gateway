import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LlmWikiMcpClientPool, llmWikiDynamicTools } from "../src/knowledge/llm-wiki-mcp-client.js";
import type { ManagedKnowledgeBase } from "../src/state/runtime-state.js";

test("validates llm-wiki by its runtime protocol and proxies its read-only MCP tools", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-llm-wiki-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wikiRoot = path.join(root, "knowledge");
  const commandDir = path.join(wikiRoot, "skills", "knowledge-base", ".venv", "bin");
  fs.mkdirSync(commandDir, { recursive: true });
  const command = path.join(commandDir, "llm-wiki");
  fs.writeFileSync(command, `#!/usr/bin/env node
import readline from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({document_count:3,block_count:12,raw_artifact_count:2,latest_run_id:"run-1",latest_run_status:"completed"}));
  process.exit(0);
}
const rl = readline.createInterface({input:process.stdin});
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"llm-wiki",version:"2"}}});
  if (message.method === "tools/list") return send({jsonrpc:"2.0",id:message.id,result:{tools:[{name:"search"},{name:"get_document"}]}});
  if (message.method === "tools/call") return send({jsonrpc:"2.0",id:message.id,result:{isError:false,structuredContent:{result:message.params.name === "search" ? [{document_id:"doc-1",anchor:"wiki/doc.md#answer",snippet:message.params.arguments.query}] : "{\\\"document_id\\\":\\\"doc-1\\\"}"}}});
});
`, { mode: 0o755 });
  const now = new Date().toISOString();
  const knowledgeBase: ManagedKnowledgeBase = {
    id: "kb-one",
    name: "Fixture Wiki",
    rootPath: wikiRoot,
    createdAt: now,
    updatedAt: now
  };
  const pool = new LlmWikiMcpClientPool();
  t.after(() => pool.close());

  const inspection = await pool.inspect(knowledgeBase);
  assert.equal(inspection.command, command);
  assert.deepEqual(inspection.status, {
    documentCount: 3,
    blockCount: 12,
    rawArtifactCount: 2,
    latestRunId: "run-1",
    latestRunStatus: "completed"
  });
  assert.match(await pool.call(knowledgeBase, "search", { query: "答案", limit: 5 }), /wiki\/doc\.md#answer/);
  assert.match(await pool.call(knowledgeBase, "get_document", { document_id: "doc-1" }), /document_id/);

  const namespace = llmWikiDynamicTools()[0] as { name: string; tools: Array<{ name: string }> };
  assert.equal(namespace.name, "knowledge");
  assert.deepEqual(namespace.tools.map((tool) => tool.name), ["search", "get_document"]);
});

test("rejects a directory that is not an llm-wiki project", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-not-wiki-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const pool = new LlmWikiMcpClientPool();
  t.after(() => pool.close());

  await assert.rejects(pool.inspect({
    id: "invalid",
    name: "Invalid",
    rootPath: root,
    createdAt: now,
    updatedAt: now
  }), /未找到 llm-wiki 可执行文件/);
});
