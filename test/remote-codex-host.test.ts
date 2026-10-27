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

test("remote relay exits promptly when the control socket closes while Gateway stdin stays open", { timeout: 5000, skip: process.platform === "win32" }, async t => {
  const { spawn } = await import("node:child_process"), net = await import("node:net");
  const root = fs.mkdtempSync(path.join("/tmp", "relay-close-"));
  const directory = path.join(root, ".codex", "app-server-control"); fs.mkdirSync(directory, { recursive: true });
  const socketPath = path.join(directory, "app-server-control.sock"), connected = Promise.withResolvers<import("node:net").Socket>();
  const sockets = new Set<import("node:net").Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.once("data", () => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); connected.resolve(socket);
  }); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const command = resolveRemoteCodexTransport("remote-ssh-discovered:fixture").args.at(-1)!;
  const encoded = /Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(command)![1];
  const relay = spawn(process.execPath, ["-e", Buffer.from(encoded, "base64").toString()], { env: { ...process.env, HOME: root }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { relay.kill(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  const exited = new Promise<number | null>(resolve => relay.once("exit", resolve));
  const socket = await connected.promise;
  // Desktop restart closes its control connection; the SSH/JSONL input is
  // still held by Gateway. Keeping readline alive used to hide this failure.
  socket.destroy();
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await Promise.race([exited, new Promise<"still-alive">(resolve => { timer = setTimeout(() => resolve("still-alive"), 700); })]);
    assert.notEqual(code, "still-alive", "dead control socket must not masquerade as an initialized transport");
    assert.notEqual(code, 0); assert.equal(relay.stdin.writableEnded, false);
  } finally { if (timer) clearTimeout(timer); }
});
