import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

// Opt-in: a real installed Codex binary, fresh CODEX_HOME and a local fake model.
// Never loads real account credentials or submits to an external model service.
for (const mode of ["idle", "busy", "busy-restart"] as const) test(`real Codex consumes native queue once: ${mode}`, {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30_000
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-real-native-queue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  let firstRequested!: () => void;
  const requested = new Promise<void>(resolve => { firstRequested = resolve; });
  const server = http.createServer((request, response) => {
    request.resume(); calls++;
    const respond = () => {
    const item = { type: "message", id: "msg_mock", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "LOCAL_MOCK_DONE", annotations: [] }] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, fields: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields as object })}\n\n`);
    emit("response.created", { response: { id: "resp_mock", status: "in_progress", output: [] } });
    emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    emit("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "msg_mock", delta: "LOCAL_MOCK_DONE" });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: { id: "resp_mock", status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
    };
    if (calls === 1 && mode !== "idle") { releaseFirst = respond; firstRequested(); }
    else respond();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(dir, "config.toml"), [
    'model_provider = "gateway_mock"', 'model = "mock-model"',
    '[model_providers.gateway_mock]', 'name = "Local isolated test"',
    `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false'
  ].join("\n"));
  const build = () => new AppServerCodexRunner({ codexHome: dir, requestTimeoutMs: 5_000, transport: {
    command: process.env.CODEX_NATIVE_QUEUE_TEST_BIN!, args: ["app-server"], mode: "stdio"
  } });
  let runner = build(); t.after(() => runner.close());
  let threadId: string | undefined;
  const firstRun = runner.run({ prompt: "isolated initialization", cwd: dir,
    onTurnStarted: turn => { threadId = turn.threadId; } });
  // Closing the isolated executor intentionally interrupts its active turn.
  // Only still-pending native queue inputs should survive that restart.
  void firstRun.catch(() => undefined);
  if (mode === "idle") assert.equal((await firstRun).text, "LOCAL_MOCK_DONE");
  else await requested;
  assert.ok(threadId);
  let nativeAccepted: string | undefined;
  const item = await runner.addQueuedSubmission({ threadId, prompt: "isolated native input",
    clientUserMessageId: "isolated-native-client-id", onAccepted: id => { nativeAccepted = id; } });
  if (mode !== "idle") {
    assert.equal((await runner.listQueuedSubmissions(threadId)).data[0].id, item.id);
    if (mode === "busy-restart") {
      runner.close(); await assert.rejects(firstRun);
      runner = build();
      assert.equal((await runner.listQueuedSubmissions(threadId)).data[0].id, item.id, "pending native input survives executor restart");
    } else {
      releaseFirst!(); assert.equal((await firstRun).text, "LOCAL_MOCK_DONE");
    }
  }
  // A loaded idle native queue can auto-start on add. Observe it rather than
  // closing its executor or sending queue/start a second time.
  const second = await runner.runQueuedSubmission({ threadId, queuedSubmissionId: item.id,
    clientUserMessageId: "isolated-native-client-id", cwd: dir });
  assert.equal(second.text, "LOCAL_MOCK_DONE");
  if (mode !== "busy-restart") assert.equal(nativeAccepted, second.turnId);
  assert.equal((await runner.listQueuedSubmissions(threadId)).data.length, 0);
  const history = await runner.getHistory(threadId);
  assert.equal(history.filter(m => m.clientUserMessageId === "isolated-native-client-id").length, 1);
  assert.equal(history.find(m => m.clientUserMessageId === "isolated-native-client-id")?.turnId, second.turnId);
  assert.equal(calls, 2, "no duplicate model execution");
  runner.close(); runner = build();
  assert.equal((await runner.listQueuedSubmissions(threadId)).data.length, 0);
  assert.equal((await runner.getHistory(threadId)).filter(m => m.clientUserMessageId === "isolated-native-client-id").length, 1);
  const observed = await runner.runQueuedSubmission({ threadId, acceptedTurnId: second.turnId!,
    observeOnly: true, clientUserMessageId: "isolated-native-client-id", cwd: dir });
  assert.equal(observed.turnId, second.turnId); assert.equal(observed.text, "LOCAL_MOCK_DONE");
  assert.equal(calls, 2, "terminal recovery does not start any task");
});
