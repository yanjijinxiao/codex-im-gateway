import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

// A real protocol/identity test, not proof that all native systemError causes
// can recover. The failed rollout, resume and post-read use an isolated owner.
for (const lifecycle of [false, true]) test(`real Codex state-only rehydration preserves history without model execution, retained=${lifecycle}`, {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-state-only-native-"));
  let inferenceRequests = 0;
  const server = http.createServer((request, response) => {
    request.resume(); if (request.url?.includes("responses")) inferenceRequests++;
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end('{"error":{"type":"invalid_request_error","message":"isolated failure"}}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(root, "config.toml"), [
    `thread_unload_delay_secs=${lifecycle ? 3600 : 1}`, 'model_provider="isolated"', 'model="mock-model"', '[model_providers.isolated]', 'name="Isolated state reload"',
    `base_url="http://127.0.0.1:${(server.address() as {port:number}).port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false'
  ].join("\n"));
  let nativeServer: ReturnType<typeof spawn> | undefined, wsUrl: string | undefined;
  if (lifecycle) {
    const probe = net.createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    wsUrl = `ws://127.0.0.1:${(probe.address() as { port: number }).port}`;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    nativeServer = spawn(process.env.CODEX_NATIVE_QUEUE_TEST_BIN!, ["app-server", "--listen", wsUrl],
      { env: { ...process.env, CODEX_HOME: root }, stdio: "ignore", windowsHide: true });
  }
  const build = () => new AppServerCodexRunner({ codexHome: root, requestTimeoutMs: 5000,
    transport: wsUrl ? { command: process.execPath, args: [path.resolve("test/fixtures/native-websocket-client.mjs"), wsUrl], mode: "daemon-proxy" }
      : { command: process.env.CODEX_NATIVE_QUEUE_TEST_BIN!, args: ["app-server"], mode: "stdio" } });
  const runner = build(), recoveryClient = lifecycle ? build() : runner;
  t.after(async () => {
    await Promise.all([runner.close(), ...(lifecycle ? [recoveryClient.close()] : [])]);
    if (nativeServer && nativeServer.exitCode === null) {
      const exited = new Promise<void>(resolve => nativeServer!.once("exit", () => resolve()));
      nativeServer.kill(); const kill = setTimeout(() => nativeServer?.kill("SIGKILL"), 2000); await exited; clearTimeout(kill);
    }
    server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const wire = runner as any; wire.operationLeases++;
  let id: string | undefined;
  await assert.rejects(runner.run({ prompt: "isolated failed rollout", cwd: root,
    onTurnStarted: turn => { id = turn.threadId; } }));
  assert.ok(id);
  const nativeRead = runner.readThreadSnapshot.bind(runner);
  const original = await nativeRead(id);
  const failure = original.turns.at(-1)!;
  assert.equal(failure.status, "failed");
  const beforeCalls = inferenceRequests;
  assert.equal(original.state.runtimeStatus, "systemError");
  let obligation = false;
  if (lifecycle) await wire.request("thread/resume", { threadId: id }); // A real retained native subscription, not an injected state.
  else {
    const waiting = await runner.recoverSystemError({ threadId: id, failedTurnId: failure.id, assertCurrent() {} });
    assert.equal(waiting.reason, "awaiting-unload");
    const deadline = Date.now() + 8000;
    while ((await nativeRead(id)).state.runtimeStatus !== "notLoaded" && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await nativeRead(id)).state.runtimeStatus, "notLoaded");
  }
  const result = await recoveryClient.recoverSystemError({ threadId: id, failedTurnId: failure.id, assertCurrent() {},
    ...(lifecycle ? { lifecycle: { beforeArchive() { obligation = true; }, archived() {}, restored() { obligation = false; } } } : {}) });
  const after = await nativeRead(id);
  t.diagnostic(`native runtime: ${original.state.runtimeStatus} -> ${after.state.runtimeStatus}; recovery=${result.status}`);
  assert.equal(result.state?.threadId, id);
  assert.equal(result.status, "recovered"); assert.equal(after.state.runtimeStatus, "idle");
  assert.deepEqual(after.turns, original.turns, "native history was neither edited nor extended");
  assert.equal(inferenceRequests, beforeCalls, "the recovery performed no model execution");
  assert.equal(obligation, false, "original active persistence was restored");
  wire.operationLeases--;
});
