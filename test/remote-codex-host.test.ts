import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveRemoteCodexTransport } from "../src/codex/remote-host.js";
import { HybridCodexRunner } from "../src/codex/runner.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("resolves a Codex Desktop host id through its managed SSH connection", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-host-"));
  try {
    fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
      "codex-managed-remote-connections": [{
        hostId: "remote-ssh-discovered:devbox",
        alias: "devbox",
        sshPort: 22022,
        identity: "/tmp/test-identity"
      }]
    }));
    const transport = resolveRemoteCodexTransport("remote-ssh-discovered:devbox", {
      codexHome,
      sshBin: "/test/ssh"
    });
    assert.equal(transport.command, "/test/ssh");
    assert.equal(transport.label, "remote-ssh-discovered:devbox");
    assert.equal(transport.mode, "remote-daemon");
    assert.deepEqual(transport.args.slice(0, 9), [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2"
    ]);
    assert.deepEqual(transport.args.slice(9, 14), ["-p", "22022", "-i", "/tmp/test-identity", "devbox"]);
    assert.match(transport.args.at(-1) ?? "", /^exec node -e /);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("rejects remote projects explicitly when codex exec is pinned", async (t) => {
  let resolved = false;
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    remoteTransportResolver() {
      resolved = true;
      throw new Error("must not resolve app-server transport");
    }
  });
  t.after(() => runner.close());

  await assert.rejects(
    runner.run({
      prompt: "remote-turn",
      cwd: "/home/admin/project",
      hostId: "remote-ssh-discovered:devbox"
    }),
    /codex exec backend cannot run a remote Codex Desktop project/i
  );
  assert.equal(resolved, false);
});

test("routes remote project turns and history to a host-specific app-server transport", async (t) => {
  const hosts: string[] = [];
  const fixture = path.join(fixturesDir, "fake-codex-app-server.mjs");
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: fixture,
    timeoutMs: 2_000,
    remoteTransportResolver(hostId) {
      hosts.push(hostId);
      return {
        command: process.execPath,
        args: [fixture],
        label: hostId
      };
    }
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "remote-turn",
    cwd: "/home/admin/project",
    hostId: "remote-ssh-discovered:devbox"
  });
  assert.equal(result.text, "reply:remote-turn");
  assert.deepEqual(hosts, ["remote-ssh-discovered:devbox"]);
  assert.equal((await runner.getHistory("thread-existing", "remote-ssh-discovered:devbox"))[0]?.text, "hello history");
  assert.deepEqual(hosts, ["remote-ssh-discovered:devbox"]);
});
