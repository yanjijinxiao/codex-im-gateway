import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodeServerInstaller, codeServerAsset, IDEInstallPendingError, type IDEInstallerIO } from "../src/ide/installer.js";

function fixture(t: test.TestContext, changes: Partial<IDEInstallerIO> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-install-test-")), calls: string[] = [];
  let allowed = true;
  const io: IDEInstallerIO = {
    probe: async () => ({ platform: "linux", arch: "x64", glibc: "2.31" }),
    prepare: async () => { calls.push("prepare"); return "/private/stage"; },
    remoteDownload: async () => { calls.push("remote"); throw new Error("offline"); },
    download: async (_a, progress) => { calls.push("download"); progress(42); return "/verified-cache"; },
    upload: async () => { calls.push("upload"); }, activate: async () => { calls.push("activate"); return "/managed/code-server"; }, ...changes
  };
  const installer = new CodeServerInstaller(root, { allowed: () => allowed, io });
  t.after(async () => { await installer.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, calls, installer, revoke: () => { allowed = false; } };
}

test("installer deduplicates a host job, falls back through Gateway transfer and does not submit a Codex turn", async t => {
  const f = fixture(t); f.installer.begin("remote"); f.installer.begin("remote");
  const state = await f.installer.wait("remote"); assert.equal(state?.phase, "ready");
  assert.deepEqual(f.calls, ["prepare", "remote", "download", "upload", "activate"]);
  assert.equal(state?.binary, "/managed/code-server"); assert.equal(fs.statSync(path.join(f.root, "ide/installations.json")).mode & 0o777, 0o600);
});

test("an existing compatible managed binary is reused without downloads", async t => {
  const f = fixture(t, { probe: async () => ({ platform: "linux", arch: "x64", binary: "/existing", glibc: "2.31" }) });
  f.installer.begin("remote"); await f.installer.wait("remote"); assert.equal(await f.installer.binary("remote"), "/existing");
  assert.deepEqual(f.calls, []);
});

for (const arch of ["x64", "arm64"]) test(`macOS ${arch} selects the pinned native package without a Linux libc requirement`, async t => {
  const asset = codeServerAsset("darwin", arch);
  assert.equal(asset.directory, `code-server-4.141.0-macos-${arch === "x64" ? "amd64" : "arm64"}`);
  assert.equal(asset.size, arch === "x64" ? 231_091_669 : 210_608_428);
  assert.equal(asset.sha256, arch === "x64" ? "b133e002c2a1a4f22b2ec42c5f233147f342b592e2eadcacc51703a86f447f77" : "ab45ad960725bdcdfb92998ef54feb2f479079224315ce44a4f49c54093453c9");
  let received;
  const f = fixture(t, { probe: async () => ({ platform: "darwin", arch }),
    remoteDownload: async (_host, _stage, value) => { received = value; } });
  f.installer.begin("mac"); assert.equal((await f.installer.wait("mac"))?.phase, "ready");
  assert.deepEqual(received, asset); assert.deepEqual(f.calls, ["prepare", "activate"]);
});

test("unsupported platform, old libc, revoked permission and custom binaries fail without system changes", async t => {
  assert.throws(() => codeServerAsset("linux", "arm64"), /暂支持/);
  const f = fixture(t, { probe: async () => ({ platform: "linux", arch: "x64", glibc: "2.17" }) });
  f.installer.begin("remote"); const state = await f.installer.wait("remote");
  assert.match(state!.error!, /glibc/); assert.deepEqual(f.calls, []);
  assert.throws(() => f.installer.begin("remote", "/custom"), /不会被自动替换/);
  f.revoke(); assert.throws(() => f.installer.begin("remote"), /授权/);
});

test("revocation before activation leaves the current executable untouched", async t => {
  let release!: () => void;
  const f = fixture(t, { download: async () => { await new Promise<void>(resolve => { release = resolve; }); return "/cache"; } });
  f.installer.begin("remote"); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.revoke(); release(); const state = await f.installer.wait("remote");
  assert.equal(state?.phase, "error"); assert.deepEqual(f.calls, ["prepare", "remote"]);
});

test("opening an unprepared host starts background installation and interrupted journals do not replay", async t => {
  const f = fixture(t); await assert.rejects(f.installer.binary("remote"), IDEInstallPendingError);
  await f.installer.wait("remote");
  fs.writeFileSync(path.join(f.root, "ide/installations.json"), JSON.stringify([{ hostId: "remote", phase: "transferring" }]));
  const restored = new CodeServerInstaller(f.root, { allowed: () => true, io: {} as never });
  assert.equal(restored.list()[0].phase, "error"); assert.match(restored.list()[0].error!, /中断/); await restored.close();
});

test("host-scoped installation cancellation leaves the other host running and able to activate", async t => {
  const probes = new Map<string, { signal: AbortSignal; release: () => void }>();
  const f = fixture(t, { probe: async (hostId, _binary, signal) => {
    await new Promise<void>((resolve, reject) => {
      probes.set(hostId, { signal, release: resolve }); signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true });
    }); return { platform: "linux", arch: "x64", glibc: "2.31" };
  } });
  f.installer.begin("a"); f.installer.begin("b");
  while (probes.size !== 2) await new Promise(resolve => setImmediate(resolve));
  await f.installer.cancelHosts(new Set(["b"]));
  assert.equal(probes.get("a")!.signal.aborted, false); assert.equal(probes.get("b")!.signal.aborted, true);
  assert.equal((await f.installer.wait("b"))?.phase, "error");
  probes.get("a")!.release(); assert.equal((await f.installer.wait("a"))?.phase, "ready");
  assert.equal(f.calls.filter(call => call === "activate").length, 1);
});
