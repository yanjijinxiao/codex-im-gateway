import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { embeddedTaskboardPort, startEmbeddedTaskboard } from "../src/taskboard/embedded-server.js";

test("starts and closes the embedded Taskboard with isolated data", async (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-embedded-taskboard-"));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));

  const taskboard = await startEmbeddedTaskboard({ dataDirectory, port: 0 });
  t.after(() => taskboard.close());

  const response = await fetch(new URL("/health", taskboard.url));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(fs.existsSync(path.join(dataDirectory, "taskboard.sqlite")), true);

  await taskboard.close();
  await assert.rejects(fetch(new URL("/health", taskboard.url)));
});

test("reuses a healthy Taskboard already listening on the managed port", async (t) => {
  const ownerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-taskboard-owner-"));
  const clientDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-taskboard-client-"));
  t.after(() => fs.rmSync(ownerDirectory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(clientDirectory, { recursive: true, force: true }));

  const owner = await startEmbeddedTaskboard({ dataDirectory: ownerDirectory, port: 0 });
  t.after(() => owner.close());
  const managedPort = Number(new URL(owner.url).port);
  const reused = await startEmbeddedTaskboard({ dataDirectory: clientDirectory, port: managedPort });

  await reused.close();
  const response = await fetch(new URL("/health", owner.url));
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(path.join(clientDirectory, "taskboard.sqlite")), false);
});

test("uses the configured Codex executable for the embedded AI catalog", async (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-embedded-taskboard-"));
  const codexExecutable = path.join(dataDirectory, "fake-codex.mjs");
  fs.writeFileSync(codexExecutable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write('{"models":[{"slug":"gpt-test","display_name":"GPT Test","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"}],"service_tiers":[]}]}');
} else if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[]}}\\n');
    }
  });
}
`);
  fs.chmodSync(codexExecutable, 0o755);
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));

  const taskboard = await startEmbeddedTaskboard({ dataDirectory, port: 0, codexExecutable });
  t.after(() => taskboard.close());
  const projectResponse = await fetch(new URL("/api/projects", taskboard.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "workspace", name: "Workspace", workspacePath: dataDirectory })
  });
  assert.equal(projectResponse.status, 201);

  const catalogResponse = await fetch(new URL(
    "/api/local/ai/catalog?projectId=workspace",
    taskboard.url
  ));
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.deepEqual(catalog.models.map((model: { slug: string }) => model.slug), ["gpt-test"]);
});

test("derives the managed Taskboard port from a loopback URL", () => {
  assert.equal(embeddedTaskboardPort("http://127.0.0.1:47823"), 47823);
  assert.equal(embeddedTaskboardPort("http://localhost"), 80);
  assert.throws(() => embeddedTaskboardPort("https://127.0.0.1:47823"), /loopback/);
  assert.throws(() => embeddedTaskboardPort("http://192.168.1.2:47823"), /loopback/);
});
