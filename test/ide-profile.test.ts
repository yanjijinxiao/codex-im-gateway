import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { IDE_PROFILE_HELPER, IDE_SETTING_DEFAULTS, IDE_APPEARANCE_DEFAULTS } from "../src/ide/profile.js";
import { IDEConfigStore } from "../src/ide/config.js";
import { WorkspaceIDEManager } from "../src/ide/manager.js";

const seed = vm.runInNewContext(IDE_PROFILE_HELPER + ";seedSettings") as (text: string, defaults: object) => string;
const visibility = "workbench.secondarySideBar.defaultVisibility";
const chatDefaults = { [visibility]: "hidden" };

test("Chat defaults are additive, JSONC-safe and never clobber explicit preferences", () => {
  for (const text of ['', '// comment only', '/* comment only */', '\uFEFF\r\n']) {
    const after = seed(text, chatDefaults);
    assert.ok(after.startsWith(text)); assert.equal(seed(after, chatDefaults), after);
  }
  for (const text of ['{}', '{"editor.fontSize":18}', '\uFEFF// header\r\n{\r\n// keep\r\n"files.watcherExclude":{"**/node_modules":true,},\r\n}',
    '/* { header } */ {"note":"https://host/\\\"/*literal*/, }", /* keep */}', '{ /* only a comment */ }']) {
    const after = seed(text, chatDefaults);
    assert.match(after, /"workbench.secondarySideBar.defaultVisibility": "hidden"/);
    assert.equal(seed(after, chatDefaults), after, "migration is idempotent");
    assert.ok(after.includes(text.slice(text.indexOf("{", text.startsWith("/*") ? text.indexOf("*/") + 2 : 0) + 1)), "original body is retained");
  }
  for (const text of ['{"workbench.secondarySideBar.defaultVisibility":"visible"}', '// keep\n{"workbench.secondarySideBar.defaultVisibility":"visible",}'])
    assert.equal(seed(text, chatDefaults), text);
  for (const text of ['[]', 'null', '{ /* incomplete', '{"note":"oops}', '{invalid}', '{"note":1,,}', '{"note":"string, }"}x'])
    assert.throws(() => seed(text, IDE_SETTING_DEFAULTS), "invalid settings must not be rewritten");
});

test("appearance defaults match the desktop appearance and preserve explicit editor overrides", () => {
  const migrated = JSON.parse(seed('{"terminal.integrated.initialHint":false}', IDE_SETTING_DEFAULTS));
  assert.deepEqual(migrated, { ...IDE_SETTING_DEFAULTS, "terminal.integrated.initialHint": false });
  assert.equal(migrated["workbench.colorTheme"], "Dark 2026");
  assert.equal(migrated["workbench.iconTheme"], "vs-seti");
  assert.equal(migrated["workbench.productIconTheme"], "Default");
  assert.equal(migrated["editor.fontFamily"], "Menlo, Monaco, 'Courier New', monospace");
  assert.equal(migrated["editor.fontSize"], 12); assert.equal(migrated["editor.lineHeight"], 18);
  assert.equal(migrated["editor.fontWeight"], "normal"); assert.equal(migrated["editor.fontLigatures"], false);
  const explicit = { "workbench.colorTheme": "Light 2026", "editor.fontSize": 20, "editor.lineHeight": 28, "editor.fontLigatures": true };
  const after = seed(JSON.stringify(explicit), IDE_SETTING_DEFAULTS);
  assert.deepEqual(JSON.parse(after), { ...IDE_SETTING_DEFAULTS, ...explicit });
  assert.equal(seed(after, IDE_SETTING_DEFAULTS), after);
});

test("appearance settings are portable but reject invalid types and out-of-range values", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-appearance-config-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new IDEConfigStore(root), base = store.config();
  const save = (settings: Record<string, unknown>) => store.save({ ...base, profile: { settings, extensions: [] } });
  assert.doesNotThrow(() => save(IDE_APPEARANCE_DEFAULTS));
  for (const value of ["normal", "bold", "100", "900"]) assert.doesNotThrow(() => save({ "editor.fontWeight": value }));
  for (const settings of [{ "editor.fontSize": 5 }, { "editor.fontSize": "12" }, { "editor.fontSize": 101 }, { "editor.lineHeight": -1 },
    { "editor.lineHeight": 201 }, { "editor.fontWeight": 400 }, { "editor.fontWeight": "heavy" }, { "editor.fontLigatures": "false" },
    { "workbench.iconTheme": true }, { "workbench.productIconTheme": "" }, { "workbench.colorTheme": "Dark\n2026" }, { "editor.fontFamily": {} }])
    assert.throws(() => save(settings));
});

test("Chat visibility is an explicit portable setting with constrained values", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-profile-config-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new IDEConfigStore(root), config = store.config();
  for (const value of ["hidden", "visible", "visibleInWorkspace", "maximized", "maximizedInWorkspace"])
    store.save({ ...config, profile: { settings: { [visibility]: value }, extensions: [] } });
  for (const value of [true, 1, "invalid", {}]) assert.throws(() => store.save({ ...config, profile: { settings: { [visibility]: value }, extensions: [] } }));
});

function fixture(t: { after: (fn: () => Promise<void>) => void }, extensions = ["tuttieee.emacs-mcx"] as const) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-profile-process-"));
  const manager = new WorkspaceIDEManager({ root, readyTimeoutMs: 3000,
    resolve: () => ({ owner: "owner", sessionId: "s", hostId: "local", workspace: root, projectName: "fixture" }) });
  manager.configStore.save({ ...manager.config(), enabled: true,
    hosts: [{ hostId: "local", binary: path.resolve("test/fixtures/fake-code-server.mjs"), enabled: true }],
    profile: { settings: {}, extensions: [...extensions] } });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const entry = manager.entry("a", "s")!;
  const calls = () => fs.readFileSync(path.join(root, "cig-fixture-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  const plan = (value: object) => fs.writeFileSync(path.join(root, "cig-fixture-plan.json"), JSON.stringify(value));
  return { manager, entry, root, calls, plan };
}

test("first open verifies Emacs, installs only missing, isolates trust profiles, and deduplicates opens", async t => {
  const { manager, entry, root, calls } = fixture(t);
  const [a, b] = await Promise.all([manager.open(entry.id), manager.open(entry.id)]);
  assert.equal(a.id, b.id); assert.equal(a.profile?.phase, "ready");
  assert.deepEqual(a.profile?.installed, [{ id: "tuttieee.emacs-mcx", version: "0.100.1" }]);
  assert.equal(calls().filter(args => args.includes("--install-extension")).length, 1);
  await manager.stop(a.id); const next = await manager.open(entry.id);
  assert.equal(next.id, a.id); assert.equal(calls().filter(args => args.includes("--install-extension")).length, 1, "restart lists actual installation without redownloading");
  const settings = path.join(root, "ide/instances", a.id, "data/User/settings.json");
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8"))[visibility], "hidden");
  const trusted = await manager.open(entry.id, true, fs.realpathSync(root)); assert.notEqual(trusted.id, a.id);
  const installs = calls().filter(args => args.includes("--install-extension")); assert.equal(installs.length, 2);
  assert.notEqual(installs[0][installs[0].indexOf("--extensions-dir") + 1], installs[1][installs[1].indexOf("--extensions-dir") + 1]);
  await assert.rejects(manager.start(entry.id, true, true, fs.realpathSync(root)), /先停止 IDE/);
});

test("failed automatic extension install degrades visibly; explicit prepare fails and can retry", async t => {
  const { manager, entry, plan } = fixture(t); plan({ failInstall: true });
  const opened = await manager.open(entry.id);
  assert.equal(opened.status, "running"); assert.equal(opened.profile?.phase, "error");
  assert.deepEqual(opened.profile?.missing, ["tuttieee.emacs-mcx"]);
  assert.equal(opened.profile?.warning, "extensions-unavailable");
  assert.equal(JSON.stringify(manager.list()).includes("private stderr"), false);
  await manager.stop(opened.id);
  await assert.rejects(manager.start(entry.id, true), /所选扩展未安装完成/);
  assert.equal(manager.list()[0].status, "error"); assert.match(manager.list()[0].error!, /Open VSX/);
  plan({}); const prepared = await manager.start(entry.id, true);
  assert.equal(prepared.status, "stopped"); assert.equal(prepared.profile?.phase, "ready");
  const reopened = await manager.open(entry.id); assert.equal(reopened.profile?.missing.length, 0);
});

test("install exit zero without list confirmation is not reported as ready", async t => {
  const { manager, entry, plan } = fixture(t); plan({ omitInstall: true });
  const opened = await manager.open(entry.id); assert.equal(opened.profile?.phase, "error");
  assert.deepEqual(opened.profile?.installed, []); assert.deepEqual(opened.profile?.missing, ["tuttieee.emacs-mcx"]);
});

test("old settings migration keeps the instance, comments, explicit choices and invalid originals", async t => {
  const { manager, entry, root, plan } = fixture(t); plan({});
  const instance = await manager.open(entry.id); await manager.stop(instance.id);
  const settings = path.join(root, "ide/instances", instance.id, "data/User/settings.json");
  const old = '// keep user comments\n{"editor.fontSize":20,}\n'; fs.writeFileSync(settings, old);
  const migrated = await manager.open(entry.id); assert.equal(migrated.id, instance.id);
  const after = fs.readFileSync(settings, "utf8"); assert.match(after, /keep user comments/); assert.match(after, /"editor.fontSize":20,/); assert.match(after, /"hidden"/);
  await manager.stop(instance.id);
  const explicit = '// deliberate choice\n{"workbench.secondarySideBar.defaultVisibility":"visible",}'; fs.writeFileSync(settings, explicit);
  await manager.open(entry.id); assert.ok(fs.readFileSync(settings, "utf8").includes('"workbench.secondarySideBar.defaultVisibility":"visible",'));
  await manager.stop(instance.id); fs.writeFileSync(settings, '{invalid');
  const invalid = await manager.open(entry.id); assert.equal(invalid.profile?.warning, "settings-unmodified");
  assert.equal(fs.readFileSync(settings, "utf8"), '{invalid'); assert.equal(invalid.status, "running");
});

test("profile progress is visible during startup and closing cancels preparation without a late launch", async t => {
  // Keep installation pending until cancellation even if fixture process
  // startup is slow on the shared host; this is a lifecycle test, not a 5s SLA.
  const { manager, entry, calls, plan } = fixture(t); plan({ delayInstallMs: 60_000 });
  const opening = manager.open(entry.id); const rejected = assert.rejects(opening, /已退出|已改变|已取消/);
  const deadline = Date.now() + 30_000;
  while (manager.list()[0]?.profile?.phase !== "installing" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(manager.list()[0]?.profile?.phase, "installing");
  // close() is intentionally bounded by the guardian's lifecycle. It must not
  // report a running IDE or resurrect an instance after it resolves.
  const closing = manager.close(); await rejected; await closing;
  assert.equal(manager.list().some(instance => instance.status === "running"), false);
  assert.equal(calls().some(args => args.includes("--socket")), false);
});
