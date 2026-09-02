import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import fs from "node:fs";

import { accountStatePaths, defaultStateDir, preferredStateDir, resolveStatePaths } from "../src/state/paths.js";

test("uses ~/.codex-im-gateway for new service state", () => {
  assert.equal(defaultStateDir(), path.join(os.homedir(), ".codex-im-gateway"));
});

test("prefers the canonical state directory for a new installation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-gateway-home-"));
  assert.equal(preferredStateDir(home), path.join(home, ".codex-im-gateway"));
});

test("reuses an existing legacy state directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-gateway-legacy-home-"));
  const legacy = path.join(home, ".codex-channel-bridge");
  fs.mkdirSync(legacy);
  assert.equal(preferredStateDir(home), legacy);
});

test("isolates runtime state and inbound media by account", () => {
  const paths = resolveStatePaths("/tmp/codex-weixin-test");
  const first = accountStatePaths(paths, "bot/one");
  const second = accountStatePaths(paths, "bot-two");

  assert.notEqual(first.statePath, second.statePath);
  assert.notEqual(first.inboundDir, second.inboundDir);
  assert.match(first.statePath, /runtime[/\\]bot-one[/\\]state\.json$/);
  assert.match(first.inboundDir, /inbound[/\\]bot-one$/);
});
