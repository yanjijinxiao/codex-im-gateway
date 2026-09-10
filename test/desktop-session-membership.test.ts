import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopSessionMembership } from "../src/codex/desktop-session-membership.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import type { CodexThreadState } from "../src/codex/backend.js";
test("Desktop membership joins exact host/thread IDs, not shared cwd; explicit moves override stale ordering", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-membership-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = {
    "local-projects": { p: { id: "p", rootPaths: ["/tmp/shared"] }, p2: { id: "p2" } },
    "remote-projects": [{ id: "rp", hostId: "remote" }],
    "sidebar-project-thread-orders": { p: { threadIds: ["member", "moved", "detached"] }, rp: { threadIds: ["remote-member"] } },
    "thread-project-assignments": { moved: { projectId: "p2" }, detached: { projectId: null } }
  };
  fs.writeFileSync(path.join(home, ".codex-global-state.json.bak"), JSON.stringify(state));
  fs.writeFileSync(path.join(home, ".codex-global-state.json"), "{");
  const local = desktopSessionMembership(home);
  const remote = desktopSessionMembership(home, "remote");
  const thread = (threadId: string, projectId?: string): CodexThreadState => ({ threadId, projectId, cwd: "/tmp/shared", persistence: "active", runtimeStatus: "idle", activeFlags: [] });
  assert.equal(local(thread("member")).projectId, "p");
  assert.equal(local(thread("moved", "native-old")).projectId, "p2");
  assert.equal(local(thread("detached", "native-old")).projectId, undefined);
  assert.equal(local(thread("independent")).projectId, undefined);
  assert.equal(local(thread("remote-member")).projectId, undefined);
  assert.equal(remote(thread("member")).projectId, undefined);
  assert.equal(remote(thread("remote-member")).projectId, "rp");
  assert.equal(local(thread("native-only", "native")).projectId, "native");
  fs.unlinkSync(path.join(home, ".codex-global-state.json.bak"));
  assert.equal(desktopSessionMembership(home)(thread("member", "native")).projectId, "native");
});
test("App backend applies membership before filtering/limit across all native pages, and inspect agrees", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-native-pages-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { p: { id: "p" } },
    "thread-project-assignments": { first: { projectId: "p" } }
  }));
  const runner = new AppServerCodexRunner({
    codexHome: home, requestTimeoutMs: 2000,
    transport: { command: process.execPath, args: [path.resolve("test/fixtures/fake-codex-catalog.mjs")] }
  });
  t.after(() => runner.close());
  const all = await runner.listThreads({ persistence: "active" });
  assert.equal(all.length, 3);
  assert.equal(all.find(x => x.threadId === "first")?.projectId, "p");
  assert.equal((await runner.inspectThread("first")).projectId, "p");
  assert.deepEqual((await runner.listThreads({ persistence: "active", unassigned: true, limit: 1 })).map(x => x.threadId), ["second"]);
  assert.deepEqual((await runner.listThreads({ persistence: "active", projectId: "p" })).map(x => x.threadId), ["first"]);
});
