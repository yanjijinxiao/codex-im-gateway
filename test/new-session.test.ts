import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { parseCommand, channelHelpText } from "../src/bridge/channel-commands.js";
import { parseNewSessionTarget } from "../src/bridge/new-session.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import type { CodexRunnerInput } from "../src/codex/backend.js";
import type { CodexProjectCandidate } from "../src/server/codex-projects.js";

test("new target parser and aliases reject mixed/unknown flags", () => {
  assert.deepEqual(parseNewSessionTarget(""), { kind: "current" });
  assert.deepEqual(parseNewSessionTarget("--standalone"), { kind: "standalone" });
  assert.deepEqual(parseNewSessionTarget(' --project "My Project" '), { kind: "project", selector: "My Project" });
  assert.deepEqual(parseNewSessionTarget("P2"), { kind: "project", selector: "P2" });
  for (const arg of ["--project", "--project --standalone", "--standalone P1", "P1 --standalone", "--project P1 --unknown", "--host remote", '--project ""']) {
    assert.equal(parseNewSessionTarget(arg).kind, "invalid", arg);
  }
  for (const command of ["/n --standalone", "/session new --standalone", "/s NEW --standalone"]) {
    assert.deepEqual(parseCommand(command), { name: "new", arg: "--standalone" });
  }
  assert.deepEqual(parseCommand("/session new"), { name: "new", arg: "" });
  assert.deepEqual(parseCommand("/session new-thread"), { name: "session", arg: "new-thread" });
  assert.match(channelHelpText([], "session"), /\/new --standalone/);
  assert.match(channelHelpText([]), /\/session new/);
});

for (const backend of ["exec", "app-server"] as const) {
  test(`${backend}: /new targets current, selected and durable independent sessions without eager runs`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-new-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = resolveStatePaths(path.join(root, "state"));
    let store = new RuntimeStateStore(paths);
    const first = store.createProject("First", path.join(root, "first"));
    const second = store.createProject("Second", path.join(root, "second"));
    const texts: string[] = [], runs: CodexRunnerInput[] = [];
    const candidates: CodexProjectCandidate[] = [{ name: "Discovered", projectId: "native-third", workspace: path.join(root, "third"), lastUsedAt: "", sessionCount: 0 }];
    const build = () => new BridgeService({
      config: { ...defaultConfig(root), allowedSenderIds: ["alice"], codexBackend: backend, streamReplies: false },
      stateStore: store, listCodexProjects: () => candidates,
      weixin: { async sendText(x) { texts.push(x.text); return { messageId: `reply-${texts.length}` }; } },
      runner: {
        async run(input: CodexRunnerInput) { runs.push(input); return { threadId: input.threadId ?? `t-${runs.length}`, text: "done", raw: "" }; },
        async inspectThread(id: string) { return { threadId: id, persistence: "active", runtimeStatus: "idle", activeFlags: [] }; }
      } as never
    });
    let service = build(), seq = 0;
    const send = (text: string) => service.handleMessage({ senderId: "alice", id: String(seq++), text, raw: {} });
    const projectCode = (id: string) => `P${store.listProjects().findIndex(p => p.id === id) + 1}`;
    await send("/new");
    assert.equal(store.listSessions().length, 0, "no implicit first-project selection");
    assert.match(texts.at(-1)!, /当前没有项目/);
    store.activateProject("alice", first.id);
    await send("/new");
    const oldSession = store.getActiveSession("alice")!;
    assert.equal(oldSession.projectId, first.id);
    assert.equal(runs.length, 0);
    await send(`/new ${projectCode(second.id)}`);
    assert.equal(store.getActiveSession("alice")?.projectId, second.id);
    assert.notEqual(store.getActiveSession("alice")?.id, oldSession.id);
    await send("question in second");
    assert.equal(runs[0].cwd, second.workspace);
    assert.equal(runs[0].projectName, "Second");
    assert.equal(runs[0].threadId, undefined);
    await send("/new C1");
    assert.equal(store.listProjects().length, 3);
    assert.equal(store.getActiveProject("alice")?.sourceProjectId, "native-third");
    await send("question in discovered");
    assert.equal(runs[1].projectId, "native-third");
    await send("/new --project First");
    assert.equal(store.getActiveProject("alice")?.id, first.id);
    const beforeInvalid = store.getActiveSession("alice")!.id;
    for (const cmd of ["/new P99", "/new missing", "/new --project", "/new --standalone P1"]) {
      await send(cmd);
      assert.equal(store.getActiveSession("alice")?.id, beforeInvalid, cmd);
    }
    await send("/session new --standalone");
    const standalone = store.getActiveSession("alice")!;
    assert.equal(standalone.threadId, undefined);
    assert.equal(standalone.projectBinding, "none");
    assert.equal(standalone.projectId, undefined);
    assert.equal(standalone.hostId, "local");
    assert.ok(fs.statSync(standalone.workspace).isDirectory());
    assert.ok(standalone.workspace.startsWith(store.standaloneWorkspacesDir + path.sep));
    assert.equal(store.getActiveProject("alice"), undefined);
    assert.equal(store.listProjects().length, 3);
    // Restart before the first message: a pending independent session stays usable.
    store = new RuntimeStateStore(paths);
    service = build();
    assert.equal(store.getActiveProject("alice"), undefined);
    await send("/new");
    assert.equal(store.getActiveSession("alice")?.id, standalone.id);
    await send("independent question");
    assert.equal(runs[2].cwd, standalone.workspace);
    assert.equal(runs[2].hostId, "local");
    assert.equal(runs[2].projectId, undefined);
    assert.equal(runs[2].projectName, undefined);
    assert.equal(runs[2].projectBinding, "none");
    assert.equal(runs[2].threadId, undefined);
    await send("continue independent");
    assert.equal(runs[3].threadId, "t-3");
    assert.equal(store.getActiveProject("alice"), undefined);
    await send("/new --standalone");
    assert.notEqual(store.getActiveSession("alice")?.workspace, standalone.workspace);
    assert.ok(fs.existsSync(standalone.workspace), "old workspace is retained");
    assert.equal(store.listProjects().length, 3);
  });
}

test("/new preserves host routing, rejects ambiguous names and enforces ACL/mode before allocating", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-new-hosts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const local = store.createProject("Same", root);
  store.activateProject("chat", local.id);
  store.setRole("chat", "bob", "viewer");
  const candidates: CodexProjectCandidate[] = [
    { name: "Same", workspace: root, hostId: "remote", projectKind: "remote", projectId: "native", lastUsedAt: "", sessionCount: 0 },
    { name: "Broken", workspace: root + "/broken", projectKind: "remote", lastUsedAt: "", sessionCount: 0 }
  ];
  const runs: CodexRunnerInput[] = [], texts: string[] = [];
  const config = { ...defaultConfig(root), allowedSenderIds: ["chat"], codexBackend: "app-server" as "exec" | "app-server", streamReplies: false };
  const service = new BridgeService({ stateStore: store, config, listCodexProjects: () => candidates,
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } },
    runner: { async run(x: CodexRunnerInput) { runs.push(x); return { threadId: "t", text: "done", raw: "" }; } } as never });
  let seq = 0;
  const send = (text: string, actor = "alice") => service.handleMessage({ senderId: actor, replyTargetId: "chat", id: String(seq++), text, raw: {} });
  await send("/new Same");
  assert.match(texts.at(-1)!, /多个同名项目/);
  assert.equal(store.listSessions().length, 0);
  await send("/new C2");
  assert.match(texts.at(-1)!, /hostId/);
  assert.equal(store.listProjects().length, 1);
  await send("/session new --standalone", "bob");
  assert.match(texts.at(-1)!, /participant/);
  assert.equal(fs.existsSync(store.standaloneWorkspacesDir), false);
  config.codexBackend = "exec";
  await send("/new C1");
  assert.match(texts.at(-1)!, /CLI.*不能.*远程/);
  assert.equal(store.listProjects().length, 1);
  config.codexBackend = "app-server";
  await send("/new C1");
  config.codexBackend = "exec";
  const remoteSession = store.getActiveSession("chat")!.id;
  await send("/new");
  assert.equal(store.getActiveSession("chat")?.id, remoteSession, "default /new validates the saved remote route too");
  assert.match(texts.at(-1)!, /CLI.*不能.*远程/);
  config.codexBackend = "app-server";
  await send("remote question");
  assert.equal(runs[0].hostId, "remote");
  assert.equal(runs[0].projectId, "native");
  await send("/new --standalone");
  await send("local independent question");
  assert.equal(runs[1].hostId, "local", "standalone does not inherit remote host");
  assert.equal(runs[1].projectBinding, "none");
  service.configureModeSettings({ enabledModes: ["task"], defaultMode: "task" });
  const count = store.listSessions().length;
  await send("/s new --standalone");
  assert.equal(store.listSessions().length, count, "alias cannot bypass disabled session mode");
});
