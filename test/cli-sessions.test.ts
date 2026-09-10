import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliSessionStore } from "../src/codex/cli-sessions.js";
import { CodexExecRunner } from "../src/codex/exec-runner.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { CodexBackendCapabilityError } from "../src/codex/backend.js";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
test("CLI catalog and paged public history are independent of Desktop and reject internal identities", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir);
  const record = (id: string, source: unknown = "cli", session_id?: string) => JSON.stringify({ type: "session_meta", payload: { id, source, session_id, cwd: root } }) + "\n";
  const main = path.join(dir, "main.jsonl");
  fs.writeFileSync(main, record("main"));
  fs.writeFileSync(path.join(dir, "guardian.jsonl"), record("guardian", { subagent: { other: "guardian" } }, "main"));
  const append = (x: unknown) => fs.appendFileSync(main, JSON.stringify(x) + "\n");
  for(let i = 0; i < 3; i++) {
    append({ type: "event_msg", payload: { type: "task_started", turn_id: `t${i}` } });
    append({ type: "event_msg", payload: { type: "user_message", message: `question${i}` } });
    append({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question${i}` }] } });
    append({ type: "response_item", payload: { type: "message", role: "assistant", phase: "analysis", content: [{ type: "output_text", text: "PRIVATE_REASONING" }] } });
    append({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `answer${i}` }] } });
    append({ type: "event_msg", payload: { type: "task_complete", turn_id: `t${i}`, last_agent_message: `answer${i}` } });
  }
  fs.writeFileSync(path.join(root, "session_index.jsonl"), JSON.stringify({ id: "main", thread_name: "Local task" }) + "\n");
  const store = new CliSessionStore(root);
  assert.deepEqual((await store.list()).map(x => x.threadId), ["main"]);
  assert.equal((await store.list())[0].title, "Local task");
  assert.equal((await store.inspect("main")).title, "Local task");
  assert.equal((await store.inspect("guardian")).persistence, "missing");
  const snapshot = await store.snapshot("main");
  assert.equal(snapshot.turns.length, 3);
  assert.equal(snapshot.turns.flatMap(t => t.messages).length, 6, "event and response duplicates are collapsed");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_REASONING/);
  assert.equal(snapshot.state.runtimeStatus, "unknown", "disk history is not proof of a live writer");
  const page = await store.historyPage("main", { limit: 2 });
  assert.deepEqual(page.messages.map(x => x.text), ["question2", "answer2"]);
  assert.deepEqual((await store.historyPage("main", { limit: 2, cursor: page.nextCursor })).messages.map(x => x.text), ["question1", "answer1"]);
  await assert.rejects(store.historyPage("different", { cursor: page.nextCursor }), /Invalid CLI history cursor/);
  const archived = path.join(root, "archived_sessions");
  fs.mkdirSync(archived);
  fs.renameSync(main, path.join(archived, "main.jsonl"));
  assert.equal((await store.list({ persistence: "active" })).length, 0);
  assert.equal((await store.inspect("main")).persistence, "archived");
});
test("every CLI control-plane command uses the CLI implementation or an explicit unsupported error", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const foreign: string[] = [];
  const forbidden = new Proxy({}, { get: (_target, key) => key === "close" ? () => { } : () => { foreign.push(String(key)); throw new Error("FORBIDDEN APP SERVER"); } });
  const router = new CodexBackendRouter({ backend: "exec", codexHome: root, appServerBackend: forbidden as never, desktopRunner: forbidden as never });
  t.after(() => router.close());
  assert.equal((await router.listProjects()).backend, "exec");
  assert.equal(router.backendInfo().id, "exec");
  assert.equal(router.backendInfo().capabilities.history, true);
  assert.equal(router.backendInfo().capabilities.liveFollow, false);
  assert.deepEqual(await router.listThreads(), []);
  assert.equal((await router.inspectThread("missing")).persistence, "missing");
  assert.deepEqual(await router.getHistory("missing"), []);
  assert.deepEqual((await router.readThreadSnapshot("missing")).turns, []);
  assert.deepEqual((await router.getHistoryPage("missing")).messages, []);
  await router.warmUp(root);
  assert.equal(await router.stop(), "not-active");
  for(const op of [() => router.getRuntimeInfo(root), () => router.listModels(), () => router.getAccountRateLimits(), () => router.getGoal("a"), () => router.setGoal("a", {}), () => router.clearGoal("a"), () => router.archiveThread("a"), () => router.unarchiveThread("a"), () => router.deleteThread("a"), () => router.steer({ threadId: "a", prompt: "hi" }), () => router.runEphemeral({ cwd: root, prompt: "hi" })]) {
    await assert.rejects(op, CodexBackendCapabilityError);
  }
  assert.throws(() => router.listThreads({}, "remote"), /纯 CLI/);
  assert.deepEqual(foreign, []);
});
test("CLI standalone chat supports runtime flags but rejects unsupported controls before changing state", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-chat-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "sessions"));
  fs.writeFileSync(path.join(home, "sessions", "main.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "main", cwd: home, source: "cli" } }) + "\n");
  const router = new CodexBackendRouter({ backend: "exec", codexHome: home });
  t.after(() => router.close());
  const store = new RuntimeStateStore(resolveStatePaths(path.join(home, "gateway")));
  const replies: string[] = [];
  const service = new BridgeService({
    runner: router, stateStore: store,
    config: { ...defaultConfig(home), codexBackend: "exec", allowedSenderIds: ["alice"] },
    weixin: { async sendText(x) { replies.push(x.text); return { messageId: "m" }; } }
  });
  const send = (text: string) => service.handleMessage({ id: text, text, senderId: "alice", raw: {} });
  await send("/session main");
  assert.equal(store.getActiveProject("alice"), undefined);
  assert.equal(store.getActiveSession("alice")?.follow, false);
  await send("/model example-model");
  assert.equal(store.getActiveSession("alice")?.model, "example-model");
  for(const command of ["/follow on", "/plan on", "/goal", "/stream on"]) {
    await assert.rejects(send(command), CodexBackendCapabilityError);
  }
  assert.equal(store.getActiveSession("alice")?.collaborationMode, undefined);
  assert.equal(store.getActiveSession("alice")?.follow, false);
  await send("/stream off");
  assert.equal(store.getActiveSession("alice")?.streamReplies, false);
  assert.equal(store.listProjects().length, 0);
});
test("CLI project discovery does not truncate its catalog to the last 2000 rollouts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-full-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "sessions"));
  const old = path.join(root, "old-workspace");
  fs.mkdirSync(old);
  for(let i = 0; i < 2001; i++)
    fs.writeFileSync(path.join(root, "sessions", `${i}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: `t${i}`, cwd: i === 0 ? old : root } }) + "\n");
  const runner = new CodexExecRunner({ codexHome: root });
  assert.equal((await runner.listProjects()).projects.length, 2);
  assert.equal((await runner.listThreads()).length, 2001);
  const project = (await runner.listProjects()).projects.find(p => p.roots[0] === fs.realpathSync(old))!;
  assert.equal((await runner.listThreads({ cwd: project.roots[0], projectId: project.id })).length, 1);
});
