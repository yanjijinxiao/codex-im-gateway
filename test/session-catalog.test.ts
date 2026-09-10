import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import type { CodexThreadState } from "../src/codex/backend.js";
for(const backend of ["exec", "app-server"] as const)
  test(`${backend}: global session catalog pages stable choices and binds without any project`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-catalog-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = resolveStatePaths(path.join(root, "state"));
    const store = new RuntimeStateStore(paths);
    const rows: CodexThreadState[] = Array.from({ length: 19 }, (_, i) => ({ threadId: `task-${i}`, cwd: root, title: `任务 ${i}`, persistence: "active", runtimeStatus: "idle", activeFlags: [], updatedAt: new Date(2000000 - i * 1000).toISOString() }));
    rows.push({ ...rows[0], threadId: "archived", title: "ARCHIVED", persistence: "archived" }, { ...rows[0], threadId: "guardian", title: "INTERNAL", internal: true }, { ...rows[0], threadId: "missing", title: "MISSING", persistence: "missing" });
    const texts: string[] = [], runs: any[] = [], steers: any[] = [];
    const inspections: string[] = [];
    let lists = 0;
    const service = new BridgeService({
      stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["alice"], codexBackend: backend, streamReplies: false },
      listCodexProjects: () => [], weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } },
      runner: {
        async listThreads(input) { lists++; return rows.filter(r => !input?.cwd || r.cwd === input.cwd); }, async inspectThread(id) { inspections.push(id); return rows.find(x => x.threadId === id) ?? { threadId: id, persistence: "missing", runtimeStatus: "unknown", activeFlags: [] }; },
        async getHistory() { return [{ id: "u", role: "user", text: "之前的问题" }, { id: "a", role: "assistant", text: "之前的答案" }]; },
        async run(x) { runs.push(x); return { threadId: x.threadId, text: "已继续", raw: "" }; }, async stop() { return "not-active"; }, async steer(x) { steers.push(x); return { status: "accepted", threadId: x.threadId, turnId: x.expectedTurnId }; }
      } as never
    });
    let seq = 0;
    const send = (text: string) => service.handleMessage({ senderId: "alice", id: String(seq++), text, raw: {} });
    await send("/sessions size 8");
    assert.match(texts.at(-1)!, /19 个.*第 1\/3 页/);
    assert.equal(texts.at(-1)!.match(/\[R\d+\]/g)?.length, 8);
    assert.doesNotMatch(texts.at(-1)!, /ARCHIVED|INTERNAL|MISSING/);
    assert.equal(store.listProjects().length, 0);
    rows.reverse();
    await send("/sessions more");
    assert.equal(lists, 1);
    assert.match(texts.at(-1)!, /\[R9\] 任务 8/);
    await send("/session R9");
    assert.equal(store.getActiveSession("alice")?.threadId, "task-8");
    assert.match(texts.at(-1)!, /之前的问题[\s\S]*之前的答案/);
    await send("继续");
    assert.equal(runs[0].threadId, "task-8");
    assert.equal(runs[0].cwd, root);
    assert.equal(runs[0].projectId, undefined);
    assert.equal(runs[0].projectName, undefined);
    assert.equal(store.getActiveSession("alice")?.projectBinding, "none");
    assert.equal(store.getActiveProject("alice"), undefined);
    const reload = new RuntimeStateStore(paths);
    assert.equal(reload.listProjects().length, 0);
    assert.equal(reload.getActiveSession("alice")?.threadId, "task-8");
    await send("/sessions search 任务 18");
    assert.match(texts.at(-1)!, /1 个/);
    assert.match(texts.at(-1)!, /任务 18/);
    await send("/session task-18");
    assert.equal(store.getActiveSession("alice")?.threadId, "task-18");
    const count = store.listSessions().length;
    await send("/session task-18");
    assert.equal(store.listSessions().length, count);
    await send("/session archived");
    assert.match(texts.at(-1)!, /归档/);
    assert.equal(store.getActiveSession("alice")?.threadId, "task-18");
    await send("/session guardian");
    assert.match(texts.at(-1)!, /不可绑定/);
    await send("/session missing");
    assert.equal(store.getActiveSession("alice")?.threadId, "task-18");
    await send("/session 2");
    assert.match(texts.at(-1)!, /R 开头/);
    await send("/sessions prev");
    assert.match(texts.at(-1)!, /第 1\/1 页/);
    await send("/leave");
    assert.equal(store.getActiveSession("alice"), undefined);
    assert.equal(steers.length, 0);
  });
test("native project membership, remote host isolation, and unavailable-host warnings survive selection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-catalog-hosts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = store.createProject("Local project", root, { sourceProjectId: "p" });
  const rows: CodexThreadState[] = [{ threadId: "same", cwd: root, title: "独立任务", persistence: "active", runtimeStatus: "idle", activeFlags: [] },
  { threadId: "member", cwd: root, title: "项目任务", projectId: "p", persistence: "active", runtimeStatus: "active", activeTurnId: "turn", activeFlags: [] }];
  const texts: string[] = [], routed: string[] = [], steers: any[] = [];
  const service = new BridgeService({
    stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["alice"], codexBackend: "app-server" },
    listCodexProjects: () => [{ name: "Remote", workspace: root, hostId: "remote", lastUsedAt: "", sessionCount: 1 }, { name: "Offline", workspace: root, hostId: "offline", lastUsedAt: "", sessionCount: 0 }],
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } }, runner: {
      async listThreads(_input, host) {
        if(host === "offline")
          throw new Error("offline"); return host === "remote" ? [rows[0]] : rows;
      },
      async inspectThread(id, host) { routed.push(host); return rows.find(x => x.threadId === id); }, async getHistory(_id, host) { routed.push(host); return []; }, async stop(_id, host) { routed.push(host); return "not-active"; },
      async steer(x, host) { steers.push({ x, host }); return { status: "accepted", threadId: x.threadId, turnId: x.expectedTurnId }; }
    } as never
  });
  let seq = 0;
  const send = (text: string) => service.handleMessage({ senderId: "alice", id: String(seq++), text, raw: {} });
  await send("/sessions unbound");
  assert.match(texts.at(-1)!, /2 个/);
  assert.doesNotMatch(texts.at(-1)!, /项目任务/);
  assert.match(texts.at(-1)!, /offline.*暂不可用/);
  await send("/session same --host remote");
  assert.equal(store.getActiveSession("alice")?.hostId, "remote");
  assert.equal(store.getActiveSession("alice")?.projectId, undefined);
  await send("/stop");
  assert.equal(routed.at(-1), "remote");
  await send("/session same");
  assert.equal(store.listSessions().length, 2, "same thread id on different hosts must not alias");
  await send("/session member");
  assert.equal(store.getActiveSession("alice")?.projectId, project.id);
  await send("/steer 补充");
  assert.equal(steers[0].x.expectedTurnId, "turn");
  assert.equal(steers[0].host, "local");
});
test("viewer cannot bind through /sessions alias, and actor-scoped R codes cannot cross chats", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-catalog-acl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  store.setRole("chat", "bob", "viewer");
  const texts: string[] = [];
  const row = { threadId: "t", cwd: root, title: "task", persistence: "active", runtimeStatus: "idle", activeFlags: [] };
  const service = new BridgeService({ stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["chat"], codexBackend: "exec" }, weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } }, runner: { async listThreads() { return [row]; }, async inspectThread() { return row; }, async getHistory() { return []; } } as never });
  const send = (actor: string, text: string) => service.handleMessage({ senderId: actor, replyTargetId: "chat", id: actor + text, text, raw: {} });
  await send("alice", "/sessions");
  await send("bob", "/session R1");
  assert.match(texts.at(-1)!, /需要 participant/);
  await send("bob", "/sessions t");
  assert.equal(store.listSessions().length, 0);
  assert.match(texts.at(-1)!, /需要 participant/);
  await send("charlie", "/session R1");
  assert.match(texts.at(-1)!, /已过期/);
});
