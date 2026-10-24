import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, loadConfig, MAX_INBOUND_BYTES, saveConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";

test("uses ~/.codex-im-gateway as the default Codex workspace", () => {
  assert.equal(defaultConfig().defaultCwd, path.join(os.homedir(), ".codex-im-gateway"));
  assert.deepEqual(defaultConfig().allowedWorkspaces, [path.join(os.homedir(), ".codex-im-gateway")]);
  assert.equal(defaultConfig().streamReplies, true);
  assert.equal(defaultConfig().activeMessagePolicy, "steer");
  assert.equal(defaultConfig().codexBackend, "auto");
  assert.equal(defaultConfig().codexAppServerTransport, "auto");
  assert.equal(defaultConfig().maxInboundBytes, 100 * 1024 * 1024);
  assert.equal(defaultConfig().taskboardEnabled, true);
  assert.equal(defaultConfig().taskboardUrl, "http://127.0.0.1:47823");
  assert.equal(resolveStatePaths("/tmp/codex-weixin-test").taskboardDir, "/tmp/codex-weixin-test/taskboard");
});

test("busy-message defaults migrate to steer and explicit policies are preserved", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-policy-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = resolveStatePaths(dir);
  assert.equal(loadConfig(paths).activeMessagePolicy, "steer");
  for (const policy of ["ask", "steer", "queue"] as const) {
    saveConfig(paths, { ...defaultConfig(dir), activeMessagePolicy: policy });
    assert.equal(loadConfig(paths).activeMessagePolicy, policy);
  }
  fs.writeFileSync(paths.configPath, JSON.stringify({ activeMessagePolicy: "invalid" }));
  assert.equal(loadConfig(paths).activeMessagePolicy, "steer");
});

test("binding idle policy defaults to 15 days, supports disabling, and rejects corrupt config values", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-expiry-config-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(defaultConfig().bindingIdleDays, 15);
  for (const days of [0, 7, 15, 3650]) {
    saveConfig(paths, { ...defaultConfig(root), bindingIdleDays: days }); assert.equal(loadConfig(paths).bindingIdleDays, days);
  }
  for (const value of [-1, 1.1, "15", 3651, null]) {
    fs.writeFileSync(paths.configPath, JSON.stringify({ bindingIdleDays: value })); assert.equal(loadConfig(paths).bindingIdleDays, 15);
  }
});

test("uses the selected legacy state root as the workspace fallback", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-bridge-config-legacy-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const config = loadConfig(resolveStatePaths(stateDir));
  assert.equal(config.defaultCwd, stateDir);
  assert.deepEqual(config.allowedWorkspaces, [stateDir]);
});

test("loads only supported Codex backend and app-server transport settings", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-backend-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  fs.writeFileSync(paths.configPath, JSON.stringify({
    codexBackend: "app-server",
    codexAppServerTransport: "daemon"
  }));
  assert.equal(loadConfig(paths, "/tmp/project").codexBackend, "app-server");
  assert.equal(loadConfig(paths, "/tmp/project").codexAppServerTransport, "daemon");

  fs.writeFileSync(paths.configPath, JSON.stringify({
    codexBackend: "hybrid",
    codexAppServerTransport: "socket"
  }));
  assert.equal(loadConfig(paths, "/tmp/project").codexBackend, "auto");
  assert.equal(loadConfig(paths, "/tmp/project").codexAppServerTransport, "auto");
});

test("migrates the legacy inbound limit and never exceeds 100 MiB", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-media-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  fs.writeFileSync(paths.configPath, JSON.stringify({ maxInboundBytes: 50 * 1024 * 1024 }));
  assert.equal(loadConfig(paths, "/tmp/project").maxInboundBytes, MAX_INBOUND_BYTES);

  fs.writeFileSync(paths.configPath, JSON.stringify({ maxInboundBytes: 200 * 1024 * 1024 }));
  assert.equal(loadConfig(paths, "/tmp/project").maxInboundBytes, MAX_INBOUND_BYTES);

  saveConfig(paths, { ...defaultConfig("/tmp/project"), maxInboundBytes: 200 * 1024 * 1024 });
  assert.equal(JSON.parse(fs.readFileSync(paths.configPath, "utf8")).maxInboundBytes, MAX_INBOUND_BYTES);

  fs.writeFileSync(paths.configPath, JSON.stringify({ maxInboundBytes: 25 * 1024 * 1024 }));
  assert.equal(loadConfig(paths, "/tmp/project").maxInboundBytes, 25 * 1024 * 1024);
});

test("enables process progress by default while preserving an explicit opt-out", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-progress-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  assert.equal(loadConfig(paths, "/tmp/project").streamReplies, true);
  fs.writeFileSync(paths.configPath, JSON.stringify({ streamReplies: false }));
  assert.equal(loadConfig(paths, "/tmp/project").streamReplies, false);
});

test("loads an explicit codex exec sandbox", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexExecSandbox: "danger-full-access" }));

  assert.equal(loadConfig(paths, "/tmp/project").codexExecSandbox, "danger-full-access");
});

test("rejects an invalid codex exec sandbox", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexExecSandbox: "unrestricted" }));

  assert.throws(
    () => loadConfig(paths, "/tmp/project"),
    /Invalid codexExecSandbox/
  );
});
