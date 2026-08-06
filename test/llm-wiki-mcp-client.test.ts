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
  assert.equal(inspection.transport, "mcp");
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

test("uses an installed legacy read-only CLI when the knowledge engine has no MCP command", async (t) => {
  // Given
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-legacy-llm-wiki-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engineRoot = path.join(root, "vault");
  const commandDir = path.join(engineRoot, "tools", "knowledge-base", ".venv", "bin");
  const fallbackCommand = path.join(root, "global-llm-wiki");
  const documentPath = path.join(engineRoot, "notes", "answer.md");
  fs.mkdirSync(commandDir, { recursive: true });
  fs.mkdirSync(path.dirname(documentPath), { recursive: true });
  fs.writeFileSync(documentPath, "# Answer\n\nVerified knowledge.\n");
  const command = path.join(commandDir, "llm-wiki");
  fs.writeFileSync(command, `#!/usr/bin/env node
const [subcommand] = process.argv.slice(2);
if (subcommand === "status") {
  process.stdout.write(JSON.stringify({documents:861,blocks:16191,cas_blobs:2810}));
} else if (subcommand === "search") {
  process.stdout.write(JSON.stringify([{document_id:"doc-1",anchor:"notes/answer.md#Answer:L1-L3",snippet:"Verified knowledge."}]));
} else if (subcommand === "trace") {
  process.stdout.write(JSON.stringify({document_id:"doc-1",relative_path:"notes/answer.md",title:"Answer",artifact_hash:"hash-1"}));
} else {
  process.stderr.write("No such command 'mcp'\\n");
  process.exitCode = 2;
}
`);
  fs.chmodSync(command, 0o755);
  fs.writeFileSync(fallbackCommand, `#!/usr/bin/env node
process.stderr.write("Global llm-wiki must not override the selected project CLI\\n");
process.exitCode = 9;
`);
  fs.chmodSync(fallbackCommand, 0o755);
  const previousConfiguredCommand = process.env.LLM_WIKI_BIN;
  process.env.LLM_WIKI_BIN = fallbackCommand;
  t.after(() => {
    if (previousConfiguredCommand === undefined) delete process.env.LLM_WIKI_BIN;
    else process.env.LLM_WIKI_BIN = previousConfiguredCommand;
  });
  const now = new Date().toISOString();
  const knowledgeBase: ManagedKnowledgeBase = {
    id: "legacy-kb",
    name: "Legacy Wiki",
    rootPath: engineRoot,
    createdAt: now,
    updatedAt: now
  };
  const pool = new LlmWikiMcpClientPool();
  t.after(() => pool.close());

  // When
  const inspection = await pool.inspect(knowledgeBase);
  const search = await pool.call(knowledgeBase, "search", { query: "verified", limit: 5 });
  const document = await pool.call(knowledgeBase, "get_document", { document_id: "doc-1" });

  // Then
  assert.deepEqual(inspection.status, {
    documentCount: 861,
    blockCount: 16_191,
    rawArtifactCount: 2_810
  });
  assert.equal(inspection.transport, "cli");
  assert.match(search, /Verified knowledge/);
  assert.match(document, /# Answer/);
});

test("rejects a status-only CLI that cannot provide read-only knowledge tools", async (t) => {
  // Given
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-status-only-wiki-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commandDir = path.join(root, ".venv", "bin");
  fs.mkdirSync(commandDir, { recursive: true });
  const command = path.join(commandDir, "llm-wiki");
  fs.writeFileSync(command, `#!/usr/bin/env node
const [subcommand] = process.argv.slice(2);
if (subcommand === "status") {
  process.stdout.write(JSON.stringify({documents:1,blocks:2,cas_blobs:1}));
} else {
  process.stderr.write("No such command '" + subcommand + "'\\n");
  process.exitCode = 2;
}
`);
  fs.chmodSync(command, 0o755);
  const now = new Date().toISOString();
  const pool = new LlmWikiMcpClientPool();
  t.after(() => pool.close());

  // When / Then
  await assert.rejects(pool.inspect({
    id: "status-only",
    name: "Status Only",
    rootPath: root,
    createdAt: now,
    updatedAt: now
  }), /search.*调用失败|只读工具/s);
});

test("rejects an executable whose status JSON is not an llm-wiki status contract", async (t) => {
  // Given
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-invalid-status-wiki-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commandDir = path.join(root, ".venv", "bin");
  fs.mkdirSync(commandDir, { recursive: true });
  const command = path.join(commandDir, "llm-wiki");
  fs.writeFileSync(command, `#!/usr/bin/env node
const [subcommand] = process.argv.slice(2);
if (subcommand === "status") process.stdout.write(JSON.stringify({ok:true}));
else process.exitCode = 2;
`);
  fs.chmodSync(command, 0o755);
  const now = new Date().toISOString();
  const pool = new LlmWikiMcpClientPool();
  t.after(() => pool.close());

  // When / Then
  await assert.rejects(pool.inspect({
    id: "invalid-status",
    name: "Invalid Status",
    rootPath: root,
    createdAt: now,
    updatedAt: now
  }), /status.*格式无效/s);
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
