import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { defaultConfig } from "../src/state/config.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { readSessionPurposes } from "../src/state/session-purposes.js";
import type { ChannelActionCard } from "../src/channels/action-card.js";
import type { CodexThreadState } from "../src/codex/backend.js";

test("purpose registry is explicit, host-scoped, shared across accounts, and read-only", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-purposes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const a = new RuntimeStateStore(accountStatePaths(paths, "a"));
  const b = new RuntimeStateStore(accountStatePaths(paths, "b"));
  const file = a.sessionPurposeRegistryPath;
  assert.equal(file, b.sessionPurposeRegistryPath);
  assert.equal(readSessionPurposes(file).isProbe("task"), false);
  assert.equal(fs.existsSync(file), false, "discovery must not create a registry");
  const entry = { hostId: "remote", threadId: "task", purpose: "probe", reason: "Confirmed health check" };
  const save = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  save({ version: 1, entries: [entry] });
  const before = fs.readFileSync(file, "utf8"), index = readSessionPurposes(file);
  assert.equal(index.isProbe("task", "remote"), true);
  assert.equal(index.isProbe("task"), false);
  assert.equal(index.isProbe("other", "remote"), false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(readSessionPurposes(new RuntimeStateStore(paths).sessionPurposeRegistryPath).isProbe("task", "remote"), true);
  for (const invalid of [{ version: 2, entries: [entry] }, { version: 1, entries: [entry, entry] },
    { version: 1, entries: [{ ...entry, purpose: "guess" }] }, { version: 1, entries: [{ ...entry, hostId: "" }] }]) {
    save(invalid);
    assert.throws(() => readSessionPurposes(file), /Invalid session purpose registry/);
  }
  fs.writeFileSync(file, "broken json with sensitive content");
  assert.throws(() => readSessionPurposes(file), e => !String(e).includes("sensitive content"));
  save({ version: 1, entries: [{ ...entry, purpose: "conversation" }] });
  assert.equal(readSessionPurposes(file).isProbe("task", "remote"), false);
});

for (const backend of ["exec", "app-server"] as const) {
  for (const channel of ["dingtalk", "feishu", "weixin", "wecom"] as const) {
    test(`${backend}/${channel}: hide confirmed probes before paging without title heuristics or backend mutations`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-purpose-catalog-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const paths = resolveStatePaths(root), store = new RuntimeStateStore(paths);
      const states: CodexThreadState[] = Array.from({ length: 8 }, (_, i) => ({
        threadId: `task-${i}`, title: i === 0 ? "Reply exactly READY." : `正常任务 ${i}`, cwd: root,
        persistence: "active", runtimeStatus: "notLoaded", activeFlags: [], updatedAt: new Date(100000 - i).toISOString()
      }));
      const probe = { ...states[0], threadId: "probe", title: "Confirmed probe" };
      // Duplicate IDs should count as one exclusion; archived and internal remain excluded too.
      states.unshift(probe, probe, { ...probe, threadId: "archived", persistence: "archived" }, { ...probe, threadId: "internal", internal: true });
      const registry = { version: 1, entries: [
        { hostId: "local", threadId: "probe", purpose: "probe", reason: "Confirmed health check" },
        { hostId: "other-host", threadId: "task-0", purpose: "probe", reason: "Different host" }
      ] };
      fs.writeFileSync(store.sessionPurposeRegistryPath, JSON.stringify(registry));
      const texts: string[] = [], cards: ChannelActionCard[] = [];
      let lists = 0, inspections = 0, seq = 0;
      const service = new BridgeService({
        config: { ...defaultConfig(root), codexBackend: backend, allowedSenderIds: ["alice"] }, stateStore: store,
        listCodexProjects: () => [],
        channel: createChannelClient(channel, { ...TEXT_CAPABILITIES,
          ...(channel === "dingtalk" ? { tableLayout: "markdown" } : {}),
          ...(channel === "feishu" ? { tableLayout: "native", actions: "available" } : {})
        }, {
          async sendText(x) { texts.push(x.text); return { messageId: "m" }; },
          async sendActionCard(x) { cards.push(x.card); texts.push(x.card.fallbackText); return { messageId: "c" }; }
        }),
        runner: {
          async listThreads() { lists++; return states; },
          async inspectThread(id: string) { inspections++; return states.find(s => s.threadId === id); },
          async getHistory() { return []; }
        } as never
      });
      const send = (text: string) => service.handleMessage({ senderId: "alice", id: String(seq++), text, raw: {} });
      await send("/sessions size 5");
      assert.match(texts.at(-1)!, /8 个.*第 1\/2 页/);
      assert.match(texts.at(-1)!, /已隐藏 1 个已确认的探活/);
      assert.match(texts.at(-1)!, /Reply exactly READY/);
      assert.doesNotMatch(texts.at(-1)!, /Confirmed probe/);
      const numbers = texts.at(-1)!.match(/\[R\d+\]/g)!;
      await send("/sessions more");
      numbers.push(...texts.at(-1)!.match(/\[R\d+\]/g)!);
      assert.deepEqual(numbers, Array.from({ length: 8 }, (_, i) => `[R${i + 1}]`));
      assert.equal(lists, 1);
      assert.equal(inspections, 0);
      assert.equal(store.listSessions().length, 0);
      if (cards.length) assert.equal(cards[0].table!.rows.length, 5);
      await send("/sessions all");
      assert.match(texts.at(-1)!, /8 个/);
      await send("/sessions unbound");
      assert.match(texts.at(-1)!, /8 个/);
      await send("/sessions search Confirmed probe");
      assert.match(texts.at(-1)!, /0 个/);
      await send("/sessions search READY");
      assert.match(texts.at(-1)!, /1 个/);
      assert.match(texts.at(-1)!, /Reply exactly READY/);
      // Filtering is reversible, reloads on refresh, and never archives a task.
      fs.writeFileSync(store.sessionPurposeRegistryPath, JSON.stringify({ version: 1, entries: [] }));
      await send("/sessions");
      assert.match(texts.at(-1)!, /9 个/);
      assert.match(texts.at(-1)!, /Confirmed probe/);
      fs.writeFileSync(store.sessionPurposeRegistryPath, "invalid");
      await send("/sessions");
      assert.match(texts.at(-1)!, /用途配置无法读取/);
      assert.match(texts.at(-1)!, /9 个/);
      fs.writeFileSync(store.sessionPurposeRegistryPath, JSON.stringify(registry));
      await send("/session probe");
      assert.equal(store.getActiveSession("alice")?.threadId, "probe", "direct explicit access remains available");
      assert.equal(probe.persistence, "active");
    });
  }
}
