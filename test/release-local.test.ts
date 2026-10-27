import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readBuildInfo } from "../src/server/build-info.js";
// @ts-ignore JS release tooling is intentionally independent of the application runtime.
import { testCounts, treeHash, assertReleaseDirectory } from "../scripts/release-local.mjs";

test("release requires a complete successful regression, including no cancelled tests", () => {
  const log = "ℹ tests 100\nℹ pass 96\nℹ skipped 4\nℹ fail 0\nℹ cancelled 0\n";
  assert.deepEqual(testCounts(log), { tests: 100, passed: 96, skipped: 4 });
  for (const bad of ["", log.replace("pass 96", "pass 95"), log.replace("fail 0", "fail 1"), log.replace("cancelled 0", "cancelled 1")]) assert.throws(() => testCounts(bad));
});

test("release artifact hashing detects changes and refuses hidden symlink targets", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-release-hash-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "asset.js"), "old"); const before = treeHash(root);
  assert.equal(treeHash(root), before); fs.writeFileSync(path.join(root, "asset.js"), "new"); assert.notEqual(treeHash(root), before);
  fs.symlinkSync(path.join(root, "asset.js"), path.join(root, "alias")); assert.throws(() => treeHash(root), /symlink/);
});

test("release staging cannot overlap the live repository, persistent state, or their parents", () => {
  for (const dir of ["/work/project", "/work/project/dist", "/data/gateway", "/data/gateway/stage", "/work", "/data", "/"]) {
    assert.throws(() => assertReleaseDirectory(dir, "/work/project", "/data/gateway"));
  }
  assert.doesNotThrow(() => assertReleaseDirectory("/tmp/release", "/work/project", "/data/gateway"));
});

test("build identity is whitelisted, unavailable in dev, and invalid metadata never claims a deployed commit", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-build-info-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = pathToFileURL(path.join(root, "build-info.json")); assert.equal(readBuildInfo(file), undefined);
  const valid = { commit: "a".repeat(40), sourceHash: "b".repeat(64), builtAt: "2026-10-27T00:00:00.000Z" };
  fs.writeFileSync(file, JSON.stringify({ ...valid, ignored: "not published" })); assert.deepEqual(readBuildInfo(file), valid);
  fs.writeFileSync(file, JSON.stringify({ ...valid, commit: "unknown" })); assert.throws(() => readBuildInfo(file), /Invalid build/);
});
