import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repositoryRoot, "scripts", "install-local.mjs");

test("local installer links every bundled Skill without named business dependencies", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-gateway-installer-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const environment = { ...process.env, HOME: home };

  const installed = await execFileAsync(process.execPath, [
    installer,
    "--skip-dependencies",
    "--skip-build"
  ], { cwd: repositoryRoot, env: environment });
  const result: unknown = JSON.parse(installed.stdout);
  assert.deepEqual(result, {
    ok: true,
    mode: "install",
    projectRoot: repositoryRoot,
    taskboardRoot: path.join(repositoryRoot, "taskboard"),
    stateDirectory: path.join(home, ".codex-im-gateway", "taskboard"),
    links: {
      taskctl: "created",
      skills: {
        "manage-taskboard": "created",
        "manage-weekly-report": "created"
      }
    },
    urls: { admin: "http://127.0.0.1:8787", taskboard: "http://127.0.0.1:47823" }
  });
  assert.equal(
    fs.realpathSync(path.join(home, ".codex", "skills", "manage-taskboard")),
    fs.realpathSync(path.join(repositoryRoot, "taskboard", "skills", "manage-taskboard"))
  );
  assert.equal(
    fs.realpathSync(path.join(home, ".codex", "skills", "manage-weekly-report")),
    fs.realpathSync(path.join(repositoryRoot, "taskboard", "skills", "manage-weekly-report"))
  );

  const checked = await execFileAsync(process.execPath, [installer, "--check"], {
    cwd: repositoryRoot,
    env: environment
  });
  const checkResult: unknown = JSON.parse(checked.stdout);
  assert.match(JSON.stringify(checkResult), /"manage-taskboard":"current"/);
  assert.match(JSON.stringify(checkResult), /"manage-weekly-report":"current"/);
});
