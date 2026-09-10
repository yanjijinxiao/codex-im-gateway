import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { orderSessionCatalog, type SessionCatalogRow } from "../src/bridge/session-catalog-order.js";
import { BridgeService } from "../src/bridge/service.js";
import type { CodexProjectCandidate } from "../src/server/codex-projects.js";
import type { ChannelActionCard } from "../src/channels/action-card.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { CliSessionStore } from "../src/codex/cli-sessions.js";
import { listCodexCliProjects } from "../src/codex/cli-projects.js";

const candidate = (projectId: string, name: string, hostId = "local"): CodexProjectCandidate => ({ projectId, name, hostId, workspace: "/same", lastUsedAt: "", sessionCount: 1 });
const row = (threadId: string, projectId?: string, age = 0, hostId = "local"): SessionCatalogRow => ({
  hostId, state: { threadId, projectId, cwd: "/same", title: threadId, persistence: "active", runtimeStatus: "idle", activeFlags: [], updatedAt: new Date(100000 - age).toISOString() }
});

test("sorts whole projects before recency; native membership beats cwd and standalone is last", () => {
  const catalog = [candidate("a", "项目 2"), candidate("b", "项目 10"), candidate("current", "Z 当前")];
  const active = { id: "managed", name: "旧名称", workspace: "/same", sourceProjectId: "current", createdAt: "", updatedAt: "" };
  const rows = [row("free"), row("a-old", "a", 20), row("b-new", "b"), row("current", "current", 999), row("a-new", "a"), row("b-old", "b", 10)];
  const before = structuredClone(rows);
  const result = orderSessionCatalog(rows, catalog, [active], active);
  assert.deepEqual(result.map(r => r.state.threadId), ["current", "a-new", "a-old", "b-new", "b-old", "free"]);
  assert.equal(result[0].group?.name, "Z 当前", "prefer backend's current project name");
  assert.equal(result.at(-1)?.group, undefined, "an App standalone task sharing cwd is still standalone");
  assert.deepEqual(rows, before, "presentation must not mutate backend state");
  assert.deepEqual(orderSessionCatalog([...rows].reverse(), [...catalog].reverse(), [active], active), result);
});

test("duplicate names and identical project IDs on different hosts remain separate contiguous groups", () => {
  const catalog = [candidate("p1", "Repo"), candidate("p2", "Repo"), candidate("p1", "Repo", "remote-ssh-discovered:10.0.0.2")];
  const rows = [row("one-old", "p1", 10), row("two", "p2"), row("remote", "p1", 0, "remote-ssh-discovered:10.0.0.2"), row("one-new", "p1")];
  const result = orderSessionCatalog(rows, catalog, []);
  assert.deepEqual(result.map(r => r.state.threadId), ["one-new", "one-old", "two", "remote"]);
  assert.equal(new Set(result.map(r => r.group?.id)).size, 3);
  assert.equal(new Set(result.map(r => r.group?.label)).size, 3);
  assert.match(result.at(-1)!.group!.label, /10\.0\.0\.2/);
  const unknown = orderSessionCatalog([row("unknown", "unlisted"), row("free")], [], []);
  assert.equal(unknown[0].group?.name, "项目 unlisted");
  assert.equal(unknown[1].group, undefined);
});

test("truncated project names remain visually distinct", () => {
  const prefix = "a".repeat(40);
  const result = orderSessionCatalog([row("one", "a"), row("two", "b")], [candidate("a", prefix + "one"), candidate("b", prefix + "two")], []);
  assert.notEqual(result[0].group?.label, result[1].group?.label);
  const remote = orderSessionCatalog([row("one", "a", 0, "remote"), row("two", "b", 0, "remote")], [candidate("a", "abcdefghijkl_ONE", "remote"), candidate("b", "abcdefghijkl_TWO", "remote")], []);
  assert.notEqual(remote[0].group?.label, remote[1].group?.label);
});

test("CLI adapter supplies derived group identity without inventing native membership", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-groups-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "sessions"));
  for (const project of ["Alpha", "Zulu"]) fs.mkdirSync(path.join(root, project));
  for (const [id, project] of [["z1", "Zulu"], ["a1", "Alpha"], ["z2", "Zulu"]]) {
    fs.writeFileSync(path.join(root, "sessions", id + ".jsonl"), JSON.stringify({ type: "session_meta", payload: { id, source: "cli", cwd: path.join(root, project) } }));
  }
  const sessions = new CliSessionStore(root), states = await sessions.list();
  const catalog = listCodexCliProjects(root).map(p => ({ projectId: p.id, name: p.name, workspace: p.roots[0], lastUsedAt: "", sessionCount: 0 }));
  const result = orderSessionCatalog(states.map(state => ({ state, hostId: "local" })), catalog, []);
  assert.deepEqual(result.map(r => r.group?.name), ["Alpha", "Zulu", "Zulu"]);
  assert.ok(states.every(s => s.projectId === undefined && s.workspaceProjectId));
  assert.equal((await sessions.inspect("z1")).workspaceProjectId, result[1].state.workspaceProjectId);
  assert.equal((await sessions.list({ unassigned: true })).length, 3, "native unassigned semantics do not change");
});

test("Bridge groups the full snapshot before slicing; resize and detail keep original R identities", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-group-pages-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)), cards: ChannelActionCard[] = [], texts: string[] = [];
  let catalogCalls = 0, lists = 0, seq = 0;
  const catalog = [candidate("a", "Alpha"), candidate("b", "Beta")];
  const states = [row("free").state, ...Array.from({ length: 8 }, (_, i) => row(`t${i}`, i % 2 ? "b" : "a", i).state)];
  const service = new BridgeService({ stateStore: store, config: { ...defaultConfig(root), codexBackend: "app-server", allowedSenderIds: ["alice"] },
    listCodexProjects: () => { catalogCalls++; return catalog; },
    runner: { async listThreads() { lists++; return states; } } as never,
    weixin: { async sendActionCard(x) { cards.push(x.card); return { messageId: "m" }; }, async sendText(x) { texts.push(x.text); return { messageId: "t" }; } } });
  const send = (text: string) => service.handleMessage({ senderId: "alice", id: String(seq++), text, raw: {} });
  await send("/sessions size 5");
  assert.deepEqual(cards[0].table?.rows.map(r => r[1]), ["t0", "t2", "t4", "t6", "t1"]);
  assert.deepEqual(cards[0].table?.rows.map(r => r[2]), ["Alpha", "Alpha", "Alpha", "Alpha", "Beta"]);
  assert.equal(store.listProjects().length, 0, "resolving unbound project names must be read-only");
  states.reverse(); catalog.reverse(); catalog[0] = { ...catalog[0], name: "Changed later" };
  await send("/sessions more");
  assert.deepEqual(cards.at(-1)!.table?.rows.map(r => r[0]), ["R6", "R7", "R8", "R9"]);
  assert.deepEqual(cards.at(-1)!.table?.rows.map(r => r[1]), ["t3", "t5", "t7", "free"]);
  assert.equal(cards.at(-1)!.table?.rows[0][2], "Beta");
  await send("/sessions size 30");
  assert.equal(cards.at(-1)!.actionGroups.flat()[4].value.arg, "t1 --host local");
  await send("/sessions detail R5");
  assert.match(texts.at(-1)!, /ID：t1/);
  assert.match(texts.at(-1)!, /归属：Beta/);
  assert.equal(catalogCalls, 1); assert.equal(lists, 1);
  assert.equal(store.listSessions().length, 0);
  await send("/sessions search t");
  assert.equal(cards.at(-1)!.table?.rows.length, 8);
  assert.equal(catalogCalls, 2);
});

test("missing project catalog preserves readable local and known remote sessions with a warning", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-group-partial-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)), cards: ChannelActionCard[] = [], hosts: string[] = [];
  store.createProject("Known remote", "/remote", { sourceProjectId: "p", hostId: "remote" });
  const service = new BridgeService({ stateStore: store, config: { ...defaultConfig(root), codexBackend: "app-server", allowedSenderIds: ["alice"] },
    listCodexProjects: () => { throw new Error("unavailable"); },
    runner: { async listThreads(_input, host) { hosts.push(host); return [row(host, host === "local" ? undefined : "p").state]; } } as never,
    weixin: { async sendActionCard(x) { cards.push(x.card); return { messageId: "m" }; }, async sendText() { return { messageId: "t" }; } } });
  await service.handleMessage({ id: "list", senderId: "alice", text: "/sessions", raw: {} });
  assert.deepEqual(hosts.sort(), ["local", "remote"]);
  assert.equal(cards[0].table?.rows.length, 2);
  assert.match(cards[0].body, /目录暂不可用/);
  assert.match(cards[0].table!.rows[0][2], /Known remote/);
  assert.equal(store.listProjects().length, 1);
});
