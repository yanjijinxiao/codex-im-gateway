import assert from "node:assert/strict";
import test from "node:test";
import { CodexMetadataReader, type MetadataConnection } from "../src/codex/metadata-reader.js";
import type { CodexThreadState } from "../src/codex/backend.js";

const state = (threadId: string): CodexThreadState => ({ threadId, persistence: "active", runtimeStatus: "idle",
  activeFlags: [], projectId: "project", projectMembership: "assigned", cwd: "/project" });
const observation = { includeTurns: false as const, timeoutMs: 25 };

test("metadata retries a stalled observer on a new connection and never returns its late result", async t => {
  let created = 0, closed = 0, late!: (state: CodexThreadState) => void;
  const reader = new CodexMetadataReader(() => {
    const generation = ++created;
    return { inspectThread: id => generation === 1 ? new Promise(resolve => { late = resolve; }) : Promise.resolve(state(id)),
      listProjects: async () => ({ backend: "app-server", projects: [] }), close() { closed++; } };
  });
  t.after(() => reader.close());
  const result = await reader.inspect("thread", "remote", observation);
  assert.equal(created, 2); assert.equal(closed, 1); assert.equal(result.projectMembership, "assigned");
  late({ ...state("thread"), projectId: "stale-project" });
  assert.equal((await reader.inspect("thread", "remote", observation)).projectId, "project");
  assert.equal(created, 2);
});

test("only concurrent reads share a request; hosts and later observations remain independent", async t => {
  const reads: string[] = [], hosts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reader = new CodexMetadataReader(host => {
    hosts.push(host);
    return { async inspectThread(id) { reads.push(host + id); await gate; return state(id); },
      listProjects: async () => ({ backend: "app-server", projects: [] }), close() {} };
  });
  t.after(() => reader.close());
  const a = reader.inspect("thread", "one", observation), b = reader.inspect("thread", "one", observation);
  assert.equal(a, b);
  const other = reader.inspect("thread", "two", observation);
  release(); await Promise.all([a, b, other]);
  assert.deepEqual(hosts, ["one", "two"]); assert.equal(reads.length, 2);
  await reader.inspect("thread", "one", observation); assert.equal(reads.length, 3);
});

test("parallel failures retire only their own generation and converge on one replacement per host", async t => {
  let created = 0, closed = 0;
  const reader = new CodexMetadataReader(() => {
    const generation = ++created;
    return { inspectThread: id => generation === 1 ? Promise.reject(Error("app-server connection closed")) : Promise.resolve(state(id)),
      listProjects: async () => ({ backend: "app-server", projects: [] }), close() { closed++; } };
  });
  t.after(() => reader.close());
  const values = await Promise.all([reader.inspect("a", "host", observation), reader.inspect("b", "host", observation)]);
  assert.equal(created, 2); assert.equal(closed, 1); assert.deepEqual(values.map(v => v.threadId), ["a", "b"]);
});

test("persistent failure is bounded and never produces cached authorization evidence", async t => {
  let created = 0, closed = 0;
  const reader = new CodexMetadataReader(() => {
    created++;
    return { inspectThread: () => new Promise(() => {}), listProjects: () => new Promise(() => {}), close() { closed++; } };
  });
  t.after(() => reader.close());
  await assert.rejects(reader.inspect("thread", "host", observation), { name: "CodexCommunicationError", code: "timeout" });
  assert.equal(created, 2); assert.equal(closed, 2);
});

test("semantic rejection and foreign-thread data are not retried or rewritten as valid membership", async t => {
  let created = 0;
  const reader = new CodexMetadataReader(() => {
    created++;
    return { inspectThread: async id => { if (id === "failure") throw Error("project no longer exists"); return state("foreign"); },
      listProjects: async () => ({ backend: "app-server", projects: [] }), close() {} };
  });
  t.after(() => reader.close());
  await assert.rejects(reader.inspect("failure", "host", observation), /no longer exists/);
  await assert.rejects(reader.inspect("thread", "host", observation), /different thread/);
  assert.equal(created, 1);
});

test("project catalog recovery uses the same read-only boundary and releases it on shutdown", async () => {
  let created = 0, closed = 0;
  const reader = new CodexMetadataReader((): MetadataConnection => {
    const generation = ++created;
    return { inspectThread: async id => state(id), listProjects: async () => {
      if (generation === 1) throw Error("app-server request timed out");
      return { backend: "app-server", projects: [] };
    }, close() { closed++; } };
  });
  assert.deepEqual(await reader.projects("host", 25), { backend: "app-server", projects: [] });
  reader.close(); assert.equal(closed, 2);
  await assert.rejects(reader.inspect("thread", "host", observation), /closed/);
  assert.equal(created, 2);
});

test("shutdown cancels an in-flight observation immediately without retrying or accepting a late result", async () => {
  let created = 0, release!: (value: CodexThreadState) => void;
  const reader = new CodexMetadataReader(() => {
    created++;
    return { inspectThread: () => new Promise(resolve => { release = resolve; }),
      listProjects: async () => ({ backend: "app-server", projects: [] }), close() {} };
  });
  const pending = reader.inspect("thread", "host", { includeTurns: false, timeoutMs: 60_000 });
  await new Promise(resolve => setImmediate(resolve));
  reader.close(); await assert.rejects(pending, /communication failed/);
  release(state("thread")); assert.equal(created, 1);
});
