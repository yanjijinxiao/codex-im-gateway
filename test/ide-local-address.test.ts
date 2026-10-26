import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { resolveLocalIDEAccess } from "../src/ide/local-address.js";
import { ideConfigSchema } from "../src/ide/config.js";
import { WorkspaceIDEManager } from "../src/ide/manager.js";

test("automatic local selection follows only the named interface's unique IPv4, never VPN order or IPv6", () => {
  const access = { interfaceName: "en1", bindAddress: "30.1.2.3", publicOrigin: "https://30.1.2.3:8790", port: 8790 };
  const addresses = [{ name: "utun4", address: "30.9.8.7" }, { name: "en1", address: "fd00::1" }, { name: "en1", address: "30.1.2.4" }];
  assert.deepEqual(resolveLocalIDEAccess(access, addresses), { ...access, bindAddress: "30.1.2.4", publicOrigin: "https://30.1.2.4:8790" });
  assert.equal(access.bindAddress, "30.1.2.3", "discovery does not mutate the saved policy");
  assert.throws(() => resolveLocalIDEAccess(access, addresses.filter(a => a.name !== "en1")), /暂无 IPv4/);
  assert.throws(() => resolveLocalIDEAccess(access, [...addresses, { name: "en1", address: "30.1.2.5" }]), /多个 IPv4/);
  const { interfaceName: _, ...fixed } = access;
  assert.equal(resolveLocalIDEAccess(fixed, addresses), fixed, "old fixed policy never migrates implicitly");
});

test("automatic local schema validates interface identity and IPv4 while keeping fixed IPv6 compatible", () => {
  const config = { enabled: true, routing: "per-host", publicOrigin: "http://127.0.0.1:8790", port: 8790,
    localAccess: { publicOrigin: "https://30.1.2.3:8790", bindAddress: "30.1.2.3", port: 8790, interfaceName: "en1" },
    hosts: [{ hostId: "local", enabled: true, binary: "code-server" }], profile: { settings: {}, extensions: [] } };
  assert.ok(ideConfigSchema.safeParse(config).success);
  for (const interfaceName of ["", "en1\n", " "]) assert.equal(ideConfigSchema.safeParse({ ...config, localAccess: { ...config.localAccess, interfaceName } }).success, false);
  const v6 = { publicOrigin: "https://[fd00::1]:8790", bindAddress: "fd00::1", port: 8790 };
  assert.ok(ideConfigSchema.safeParse({ ...config, localAccess: v6 }).success);
  assert.equal(ideConfigSchema.safeParse({ ...config, localAccess: { ...v6, interfaceName: "en1" } }).success, false);
});

test("a cached automatic IP cannot be published without a live endpoint coordinator", t => {
  const root = fs.mkdtempSync("/private/tmp/cig-local-address-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new WorkspaceIDEManager({ root, resolve: (_account, sessionId) => ({ owner: "owner", sessionId, hostId: "local", workspace: root, projectName: "fixture" }) });
  manager.configStore.save({ ...manager.config(), enabled: true, routing: "per-host", hosts: [{ hostId: "local", enabled: true, binary: "code-server" }],
    localAccess: { bindAddress: "30.1.2.3", publicOrigin: "https://30.1.2.3:8790", port: 8790, interfaceName: "en1" } });
  assert.equal(manager.entry("account", "project"), undefined);
});
