import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createInstalledSkillCapabilitiesProvider } from "../src/bridge/installed-skill-capabilities.js";

function manifest(id: string, commandName: string, alias: string, intent: string): unknown {
  return {
    schemaVersion: 1,
    channel: {
      capabilityId: id,
      command: {
        name: commandName,
        aliases: [alias],
        helpLine: `/${commandName} - ${id}`,
        usage: `/${commandName}`,
        defaultOperation: "status"
      },
      operations: [{
        name: "status",
        aliases: [],
        instruction: `查看 ${id}。`,
        ai: { intent, guidance: `查看 ${id}。`, argument: "none" }
      }]
    }
  };
}

function writeSkill(
  root: string,
  name: string,
  value: unknown,
  invocationName = name
): string {
  const skillRoot = path.join(root, "skills", name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `---\nname: ${invocationName}\n---\n`);
  fs.writeFileSync(path.join(skillRoot, "channel-capability.json"), JSON.stringify(value));
  return skillRoot;
}

function writeSkillEntry(root: string, name: string): string {
  const skillRoot = path.join(root, "skills", name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return skillRoot;
}

test("same provider reflects install, invalid update, repair, and removal on the next call", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-installed-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warnings: string[] = [];
  const provider = createInstalledSkillCapabilitiesProvider({ codexHome: root, warn: (message) => warnings.push(message) });

  assert.deepEqual(await provider(), []);
  const skillRoot = writeSkill(root, "manage-example", manifest("example", "example", "ex", "example_status"));
  assert.deepEqual((await provider()).map((capability) => capability.id), ["example"]);
  fs.writeFileSync(path.join(skillRoot, "channel-capability.json"), "{");
  assert.deepEqual(await provider(), []);
  fs.writeFileSync(
    path.join(skillRoot, "channel-capability.json"),
    JSON.stringify(manifest("example-v2", "example", "ex", "example_status"))
  );
  assert.deepEqual((await provider()).map((capability) => capability.id), ["example-v2"]);
  fs.rmSync(skillRoot, { recursive: true, force: true });
  assert.deepEqual(await provider(), []);
  assert.equal(warnings.length, 1);
});

test("rejects every conflict participant while retaining unrelated capabilities", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-conflicts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeSkill(root, "manage-alpha", manifest("alpha", "alpha", "same", "alpha_status"));
  writeSkill(root, "manage-beta", manifest("beta", "beta", "same", "beta_status"));
  writeSkill(root, "manage-help-conflict", manifest("help-conflict", "help", "hc", "help_conflict_status"));
  writeSkill(root, "manage-help-intent-conflict", manifest("help-intent-conflict", "custom-help", "ch", "help"));
  writeSkill(root, "manage-valid", manifest("valid", "valid", "vld", "valid_status"));

  const capabilities = await createInstalledSkillCapabilitiesProvider({ codexHome: root, warn: () => {} })();
  assert.deepEqual(capabilities.map((capability) => capability.id), ["valid"]);
});

test("invokes the Skill frontmatter name instead of assuming the install directory name", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-invocation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeSkill(
    root,
    "example-skill-directory",
    manifest("example", "example", "ex", "example_status"),
    "example-invocation"
  );

  const [capability] = await createInstalledSkillCapabilitiesProvider({ codexHome: root })();
  assert.ok(capability);
  const resolution = capability.resolve("status");
  assert.equal(resolution.kind, "run_skill");
  if (resolution.kind === "run_skill") {
    assert.equal(resolution.skillName, "example-invocation");
  }
});

test("limits validated capabilities instead of letting ordinary Skills exhaust the scan", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-scan-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 64; index += 1) {
    writeSkillEntry(root, `plain-${String(index).padStart(2, "0")}`);
  }
  writeSkill(root, "zz-manage-valid", manifest("valid", "valid", "vld", "valid_status"));

  const capabilities = await createInstalledSkillCapabilitiesProvider({ codexHome: root })();
  assert.deepEqual(capabilities.map((capability) => capability.id), ["valid"]);
});

test("isolates an unreadable Skill extension from other installed capabilities", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file permissions are required");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-unreadable-"));
  const unreadableRoot = writeSkill(
    root,
    "manage-unreadable",
    manifest("unreadable", "unreadable", "unr", "unreadable_status")
  );
  const unreadableManifest = path.join(unreadableRoot, "channel-capability.json");
  fs.chmodSync(unreadableManifest, 0o000);
  t.after(() => {
    if (fs.existsSync(unreadableManifest)) fs.chmodSync(unreadableManifest, 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });
  writeSkill(root, "manage-valid", manifest("valid", "valid", "vld", "valid_status"));
  const warnings: string[] = [];

  const capabilities = await createInstalledSkillCapabilitiesProvider({
    codexHome: root,
    warn: (message) => warnings.push(message)
  })();

  assert.deepEqual(capabilities.map((capability) => capability.id), ["valid"]);
  assert.equal(warnings.length, 1);
});

test("rejects final manifest symlinks and oversized files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "external.json");
  fs.writeFileSync(target, JSON.stringify(manifest("linked", "linked", "lnk", "linked_status")));
  const linkedRoot = writeSkill(root, "manage-linked", manifest("placeholder", "placeholder", "ph", "placeholder_status"));
  fs.rmSync(path.join(linkedRoot, "channel-capability.json"));
  fs.symlinkSync(target, path.join(linkedRoot, "channel-capability.json"));
  const oversizedRoot = writeSkill(root, "manage-oversized", manifest("oversized", "oversized", "big", "oversized_status"));
  fs.writeFileSync(path.join(oversizedRoot, "channel-capability.json"), "x".repeat(65 * 1024));

  const capabilities = await createInstalledSkillCapabilitiesProvider({ codexHome: root, warn: () => {} })();
  assert.deepEqual(capabilities, []);
});
