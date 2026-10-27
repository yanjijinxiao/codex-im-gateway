import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { WorkspaceIDEManager, type IDEWorkspace } from "../src/ide/manager.js";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

function temporary(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-review-boundaries-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function failedRename(t: test.TestContext, target: string) {
  const original = fs.renameSync;
  return t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === target) throw Error("injected durable write failure");
    return original(from, to);
  });
}
function ide(root: string, targets: Record<string, IDEWorkspace>) {
  const manager = new WorkspaceIDEManager({ root, resolve: (_a, s) => targets[s] });
  manager.configStore.save({ ...manager.config(), enabled: true,
    hosts: [{ hostId: "local", enabled: true, binary: "code-server", autoInstall: false }] });
  return manager;
}
test("failed IDE entry writes cannot return memory-only links on retry or lose aliases after restart", t => {
  const root = temporary(t), targets: Record<string, IDEWorkspace> = {
    first: { owner: "owner", sessionId: "first", projectId: "p", hostId: "local", workspace: "/project", projectName: "project" }
  };
  const manager = ide(root, targets), file = path.join(root, "ide/workspaces.json");
  const failure = failedRename(t, file);
  assert.throws(() => manager.entry("account", "first"), /injected/);
  assert.throws(() => manager.entry("account", "first"), /injected/, "no unpublished reference may escape the failed transaction");
  failure.mock.restore();
  const entry = manager.entry("account", "first")!;
  assert.ok(entry); assert.equal(ide(root, targets).resolve(entry.id).workspace, "/project");
  targets.second = { ...targets.first, sessionId: "second" };
  const aliasFailure = failedRename(t, file);
  assert.throws(() => manager.entry("account", "second"), /injected/);
  assert.throws(() => manager.entry("account", "second"), /injected/);
  aliasFailure.mock.restore();
  assert.equal(manager.entry("account", "second")!.id, entry.id);
  delete targets.first;
  assert.equal(ide(root, targets).resolve(entry.id).workspace, "/project");
});
test("failed legacy IDE pinning is retried rather than silently accepting an uncommitted identity", t => {
  const root = temporary(t), targets = { s: { owner: "owner", sessionId: "s", projectId: "p", hostId: "local", workspace: "/project", projectName: "project" } };
  const manager = ide(root, targets), file = path.join(root, "ide/workspaces.json"), id = "1".repeat(32);
  fs.writeFileSync(file, JSON.stringify({ [id]: { accountId: "account", sessionId: "s" } }));
  const restored = ide(root, targets), failure = failedRename(t, file);
  assert.throws(() => restored.resolve(id), /injected/);
  assert.throws(() => restored.resolve(id), /injected/);
  failure.mock.restore(); assert.equal(restored.resolve(id).workspace, "/project");
  assert.match(JSON.parse(fs.readFileSync(file, "utf8"))[id].identity, /^[a-f0-9]{32}$/);
});
test("failed personal allow/removal leaves both live ACL and future commits unchanged", t => {
  const root = temporary(t), paths = resolveStatePaths(root), store = new RuntimeStateStore(paths);
  store.setPairedSenderIds(["before"]);
  const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
    weixin: { async sendText() { return { messageId: "unused" }; } } as never, runner: {} as never });
  const failure = failedRename(t, paths.statePath);
  assert.throws(() => service.allowSender("failed-actor"), /injected/);
  assert.deepEqual(service.listAllowedSenders(), ["before"]);
  assert.throws(() => service.removeSender("before"), /injected/);
  assert.deepEqual(service.listAllowedSenders(), ["before"]);
  failure.mock.restore(); service.allowSender("other-actor");
  assert.deepEqual(new RuntimeStateStore(paths).listPairedSenderIds(), ["before", "other-actor"]);
});
test("small valid UTF-8 pagination budgets terminate and preserve every code point", () => {
  const source = `import { resultPages } from './src/channels/result-pages.ts';
    const input = '中文😀'.repeat(200), pages = resultPages(input, 1024, 511);
    if (pages.map(p => p.source).join('') !== input || pages.some(p => Buffer.byteLength(p.text) > 513 || p.text.includes('�'))) process.exit(2);
    console.log(pages.length);`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), timeout: 5000, encoding: "utf8" });
  assert.ok(Number(output.trim()) > 1);
});
test("personal ACL reads reconcile durable revocation instead of retaining a second in-memory allowlist", t => {
  const root = temporary(t), paths = resolveStatePaths(root), store = new RuntimeStateStore(paths);
  store.setPairedSenderIds(["revoked"]);
  const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
    weixin: { async sendText() { return { messageId: "unused" }; } } as never, runner: {} as never });
  new RuntimeStateStore(paths).setPairedSenderIds([]);
  assert.deepEqual(service.listAllowedSenders(), []);
  service.allowSender("new");
  assert.deepEqual(new RuntimeStateStore(paths).listPairedSenderIds(), ["new"]);
});
test("personal removal does not falsely claim to revoke an identity still in fixed configuration", t => {
  const root = temporary(t), store = new RuntimeStateStore(resolveStatePaths(root));
  store.setPairedSenderIds(["fixed"]);
  const config = { ...defaultConfig(root), allowedSenderIds: ["fixed"] };
  const service = new BridgeService({ config, stateStore: store,
    weixin: { async sendText() { return { messageId: "unused" }; } } as never, runner: {} as never });
  assert.throws(() => service.removeSender("fixed"), /allowedSenderIds/);
  assert.deepEqual(store.listPairedSenderIds(), ["fixed"]);
  config.allowedSenderIds = [];
  service.removeSender("fixed");
  assert.deepEqual(new RuntimeStateStore(resolveStatePaths(root)).listPairedSenderIds(), []);
});
test("knowledge binding project names are literal text, including markup and quotes", () => {
  const context = vm.createContext({ window: {}, document: { addEventListener() {} },
    state: { accounts: [] } });
  vm.runInContext(fs.readFileSync("src/web/knowledge-bases.js", "utf8"), context);
  const render = vm.runInContext("renderKnowledgeBaseRow", context);
  const html = render({ id: "k", accountId: "a", name: "knowledge", rootPath: "/root",
    boundProjects: [{ name: '<img src=x onerror="alert(1)">' }] });
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});
