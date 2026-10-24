import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { IDEEndpointManager } from "../src/ide/endpoint-manager.js";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import { ideConfigSchema, type IDEConfig } from "../src/ide/config.js";
import type { IDELaunchInput } from "../src/ide/transport.js";
import { runtimeChanges } from "../src/ide/reconfiguration.js";

const ingressHost = "remote:ingress", secondHost = "remote:second", management = "http://127.0.0.1:18788";
async function freePort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function until(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(5); } assert.fail("hotplug fixture timeout"); }
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => release = resolve); return { promise, release }; }

/** Real HTTP/TLS/upgrade traffic and owned Unix sockets; no real SSH hosts,
 * production grants, files or Codex turns are used by this regression. */
async function fixture(t: test.TestContext, legacy = false) {
  const root = fs.mkdtempSync("/private/tmp/cig-hotplug-"), port = await freePort(), external = await freePort();
  const origin = legacy ? `http://127.0.0.1:${port}` : `https://203.0.113.10:${external}`;
  const url = new URL(origin);
  const launches: IDELaunchInput[] = [], stops: string[] = [], relays: string[] = [];
  const gates = new Map<string, ReturnType<typeof latch>>(), launchGates = new Map<string, ReturnType<typeof latch>>(), offline = new Set<string>();
  const localAddresses = [{ name: "isolated-loopback-fixture", address: "127.0.0.1" }];
  const manager = new WorkspaceIDEManager({ root, resolve: (_account, sessionId) => ({ owner: "owner", sessionId,
    hostId: sessionId.split("/")[0], projectName: "fixture", workspace: root }),
    transport: { canonicalDirectory: async hostId => { await gates.get(hostId)?.promise; return root; }, launch: async input => {
      if (offline.has(input.hostId)) throw Error("fixture unavailable");
      launches.push(input);
      const gate = launchGates.get(input.hostId);
      if (gate) await Promise.race([gate.promise, new Promise<void>((_resolve, reject) => {
        if (input.signal?.aborted) reject(Error("fixture launch cancelled"));
        else input.signal?.addEventListener("abort", () => reject(Error("fixture launch cancelled")), { once: true });
      })]);
      const sockets = new Set<net.Socket>(), socketPath = path.join(root, input.id + ".sock");
      const server = http.createServer((req, res) => res.end(req.url === "/healthz" ? "ok" : "fixture IDE"));
      server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
      server.on("upgrade", (_req, socket) => {
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
        socket.on("data", chunk => socket.write(chunk));
      });
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      let stopping: Promise<void> | undefined;
      return { socketPath, alive: () => server.listening, stop: () => stopping ??= (async () => {
        stops.push(input.hostId); for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      })() };
    } }
  });
  manager.configStore.save({ ...manager.config(), enabled: true, ...(legacy ? {} : { routing: "per-host", sharedIngressHostId: ingressHost }),
    port, publicOrigin: `http://127.0.0.1:${port}`, hosts: [{ hostId: "local", enabled: true, binary: "code-server" },
      { hostId: ingressHost, enabled: true, binary: "code-server", ...(legacy ? {} : { access: { publicOrigin: origin, bindAddress: "192.168.5.3", port: 80 } }) }] });
  const access = new IDEEndpointManager(manager, { localAddresses: () => localAddresses, ingressTiming: { retryMs: 5, probeMs: 100 }, ingressIO: {
    connect: async input => {
      relays.push(input.hostId); if (offline.has(input.hostId)) throw Error("fixture offline ingress");
      const sockets = new Set<net.Socket>(), server = net.createServer(client => {
        const upstream = net.connect(input.localPort, "127.0.0.1"); sockets.add(client); sockets.add(upstream);
        client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
        client.on("close", () => { sockets.delete(client); upstream.destroy(); });
        upstream.on("close", () => { sockets.delete(upstream); client.destroy(); }); client.pipe(upstream).pipe(client);
      });
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(new URL(input.access.publicOrigin).port), "127.0.0.1", resolve); });
      let finish!: () => void, closing: Promise<void> | undefined; const closed = new Promise<void>(resolve => finish = resolve);
      return { closed, close: () => closing ??= (async () => { for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve())); finish(); })() };
    }, probe: async input => { assert.equal((await request("/", {}, input.access.publicOrigin)).status, 200); }
  } });
  t.after(async () => { for (const gate of [...gates.values(), ...launchGates.values()]) gate.release(); await access.close(); fs.rmSync(root, { recursive: true, force: true }); });
  access.setManagementOrigin(management); await access.reload(false);
  await until(() => legacy ? access.running() : access.statuses().some(s => s.hostId === ingressHost && s.state === "ready"));
  function request(route: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}, publicOrigin = origin) {
    const url = new URL(publicOrigin), ca = legacy ? undefined : access.tls.caCertificate();
    return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const client = legacy ? http : https;
      const req = client.request({ host: "127.0.0.1", port: url.port, path: route, ca, agent: false, method: options.method,
        checkServerIdentity: (_host: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(url.hostname, cert),
        headers: { Host: url.host, ...options.headers } }, res => {
        let body = ""; res.on("data", chunk => body += chunk); res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      }); req.on("error", reject); req.end(options.body);
    });
  }
  async function login(host: string) {
    const entry = manager.entry("account", host)!, grant = await access.grant(entry.id);
    const result = await request("/authorize", { method: "POST", headers: { Origin: management }, body: new URLSearchParams({ token: grant.token, entryId: entry.id }).toString() });
    assert.equal(result.status, 200); return { entry, cookie: result.headers["set-cookie"]![0].split(";")[0] };
  }
  async function open(browser: Awaited<ReturnType<typeof login>>) {
    const page = await request(`/workspace/${browser.entry.id}`, { headers: { Cookie: browser.cookie } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
    assert.equal((await request(`/open/${browser.entry.id}`, { method: "POST", headers: { Cookie: browser.cookie, Origin: origin }, body: new URLSearchParams({ csrf }).toString() })).status, 303);
    return new Promise<net.Socket>((resolve, reject) => {
      const req = (legacy ? http : https).request({ host: "127.0.0.1", port: url.port, path: `/ide/${browser.entry.id}/socket`, ca: legacy ? undefined : access.tls.caCertificate(), agent: false,
        checkServerIdentity: (_host: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(url.hostname, cert),
        headers: { Host: url.host, Origin: origin, Cookie: browser.cookie, Connection: "Upgrade", Upgrade: "websocket" } });
      req.on("upgrade", (_res, socket) => { socket.on("error", () => {}); socket.resume(); resolve(socket); }); req.on("error", reject); req.end();
    });
  }
  const files = () => new Map(fs.readdirSync(path.join(root, "ide")).filter(name => /^authorization.*\.json$/.test(name)).map(name => [name, fs.readFileSync(path.join(root, "ide", name), "utf8")]));
  const enabledHost = (hostId: string) => ({ hostId, enabled: true, binary: "code-server", autoInstall: false });
  return { root, manager, access, origin, request, login, open, files, launches, stops, relays, gates, launchGates, offline, enabledHost, localAddresses };
}

test("local direct HTTPS is a separate publication and audience; adding it preserves the shared relay, live WS and grants", async t => {
  const f = await fixture(t), a = await f.login("local"), remote = await f.login(ingressHost);
  const socket = await f.open(remote), before = f.files(), ca = f.access.tls.caCertificate();
  const port = await freePort(), direct = `https://127.0.0.1:${port}`;
  await f.access.configure({ ...f.manager.config(), localAccess: { publicOrigin: direct, bindAddress: "127.0.0.1", port } });
  assert.equal(new URL(f.manager.entry("account", "local")!.url).origin, direct);
  assert.equal(new URL(f.manager.entry("account", ingressHost)!.url).origin, f.origin);
  for (const [name, bytes] of before) assert.equal(f.files().get(name), bytes, "existing grants unchanged");
  assert.deepEqual(f.access.tls.caCertificate(), ca); assert.equal(f.relays.length, 1); assert.equal(f.stops.length, 0);
  assert.equal(socket.destroyed, false); assert.equal(f.access.statuses().length, 3);
  assert.equal(f.access.statuses().find(s => s.localDirect)?.state, "ready");
  assert.equal((await f.request("/api/ide", {}, direct)).status, 401, "management API is never exposed");
  assert.equal((await f.request(`/workspace/${remote.entry.id}`, {}, direct)).status, 404, "direct listener only serves local projects");
  assert.match((await f.request(`/workspace/${a.entry.id}`, { headers: { Cookie: a.cookie } }, direct)).body, /等待 Gateway 授权/, "shared cookie cannot grant direct access");
  const grant = await f.access.grant(a.entry.id);
  assert.equal(grant.action, direct + "/authorize");
  const body = new URLSearchParams({ token: grant.token, entryId: a.entry.id }).toString();
  assert.equal((await f.request("/authorize", { method: "POST", headers: { Origin: management }, body })).status, 401, "direct token cannot be consumed by the old ingress");
  const authorized = await f.request("/authorize", { method: "POST", headers: { Origin: management }, body }, direct);
  assert.equal(authorized.status, 200);
  const cookie = authorized.headers["set-cookie"]![0].split(";")[0];
  const page = await f.request(`/workspace/${a.entry.id}`, { headers: { Cookie: cookie } }, direct);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
  assert.equal((await f.request(`/open/${a.entry.id}`, { method: "POST", headers: { Cookie: cookie, Origin: direct }, body: new URLSearchParams({ csrf }).toString() }, direct)).status, 303);
  assert.equal((await f.request(`/ide/${a.entry.id}/`, { headers: { Cookie: cookie } }, direct)).body, "fixture IDE");
  const directFile = f.files().get("authorization-local-direct.json"); assert.ok(directFile);
  await f.access.configure(f.manager.config());
  assert.equal(f.files().get("authorization-local-direct.json"), directFile, "no-op save preserves durable direct grants");
  assert.equal(socket.destroyed, false); assert.equal(f.relays.length, 1);
});

test("missing local IP suppresses direct publication without affecting remote availability or hot-add", async t => {
  const f = await fixture(t), config = f.manager.config(), port = await freePort();
  const localAccess = { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: "127.0.0.1", port };
  f.localAddresses.length = 0;
  await assert.rejects(f.access.configure({ ...config, localAccess }), /当前未分配/);
  assert.deepEqual(f.manager.config(), config, "new unassigned binding is not committed");
  f.localAddresses.push({ name: "fixture", address: "127.0.0.1" });
  await f.access.configure({ ...config, localAccess });
  f.localAddresses.length = 0;
  assert.equal(f.manager.entry("account", "local"), undefined);
  assert.match(f.access.statuses().find(s => s.localDirect)!.error!, /已离线或发生变化/);
  await f.access.configure({ ...f.manager.config(), hosts: [...config.hosts, f.enabledHost(secondHost)] });
  assert.equal(new URL(f.manager.entry("account", secondHost)!.url).origin, f.origin);
  assert.equal((await f.request("/")).status, 200); assert.equal(f.relays.length, 1);
});

test("a direct port conflict fails independently; explicit retry repairs only that listener", async t => {
  const f = await fixture(t), remote = await f.login(ingressHost), socket = await f.open(remote), before = f.files();
  const blocker = net.createServer(); await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => { if (blocker.listening) blocker.close(); });
  const port = (blocker.address() as net.AddressInfo).port;
  await f.access.configure({ ...f.manager.config(), localAccess: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: "127.0.0.1", port } });
  assert.equal(f.access.statuses().find(s => s.localDirect)?.state, "error");
  assert.equal(f.manager.entry("account", "local"), undefined, "no fallback to old URL");
  assert.equal(new URL(f.manager.entry("account", ingressHost)!.url).origin, f.origin);
  for (const [name, bytes] of before) assert.equal(f.files().get(name), bytes);
  assert.equal(socket.destroyed, false); assert.equal(f.relays.length, 1);
  await new Promise<void>(resolve => blocker.close(() => resolve())); await f.access.configure(f.manager.config());
  assert.equal(f.access.statuses().find(s => s.localDirect)?.state, "ready"); assert.equal(socket.destroyed, false);
});

test("direct rebind revokes only its audience; removing it restores the previous canonical publication", async t => {
  const f = await fixture(t), remote = await f.login(ingressHost), socket = await f.open(remote), before = f.files();
  const port = await freePort(), origin = `https://127.0.0.1:${port}`;
  await f.access.configure({ ...f.manager.config(), localAccess: { publicOrigin: origin, bindAddress: "127.0.0.1", port } });
  const entry = f.manager.entry("account", "local")!, grant = await f.access.grant(entry.id);
  const nextPort = await freePort(), nextOrigin = `https://127.0.0.1:${nextPort}`;
  await f.access.configure({ ...f.manager.config(), localAccess: { publicOrigin: nextOrigin, bindAddress: "127.0.0.1", port: nextPort } });
  assert.equal((await f.request("/authorize", { method: "POST", headers: { Origin: management }, body: new URLSearchParams({ token: grant.token, entryId: entry.id }).toString() }, nextOrigin)).status, 401);
  const { localAccess: _, ...withoutDirect } = f.manager.config(); await f.access.configure(withoutDirect);
  assert.equal(new URL(f.manager.entry("account", "local")!.url).origin, f.origin);
  for (const [name, bytes] of before) assert.equal(f.files().get(name), bytes);
  assert.equal(socket.destroyed, false); assert.equal(f.stops.length, 0); assert.equal(f.relays.length, 1);
});

test("local direct schema enforces exact IP/port HTTPS, per-host scope and unique origins", () => {
  const localAccess = { publicOrigin: "https://30.1.2.3:8790", bindAddress: "30.1.2.3", port: 8790 };
  const config = { enabled: true, routing: "per-host", publicOrigin: "http://127.0.0.1:8790", port: 8790, localAccess,
    hosts: [{ hostId: "local", enabled: true, binary: "code-server" }], profile: { settings: {}, extensions: [] } };
  assert.ok(ideConfigSchema.safeParse(config).success);
  for (const overrides of [{ publicOrigin: "http://30.1.2.3:8790" }, { bindAddress: "0.0.0.0" }, { publicOrigin: "https://30.1.2.4:8790" },
    { port: 8791 }, { port: 80 }, { publicOrigin: "https://30.1.2.3:8790/path" }, { publicOrigin: "https://u:p@30.1.2.3:8790" }])
    assert.equal(ideConfigSchema.safeParse({ ...config, localAccess: { ...localAccess, ...overrides } }).success, false);
  assert.equal(ideConfigSchema.safeParse({ ...config, routing: undefined }).success, false);
  assert.equal(ideConfigSchema.safeParse({ ...config, hosts: [] }).success, false);
  assert.equal(ideConfigSchema.safeParse({ ...config, hosts: [...config.hosts, { hostId: "remote:test", enabled: true, binary: "code-server", access: { ...localAccess, port: 80 } }] }).success, false);
});

for (const legacy of [false, true]) test(`${legacy ? "legacy" : "shared"} hot-add/no-op preserves HTTP, live WS, grants and pending requests; disable is host-scoped and durable`, async t => {
  const f = await fixture(t, legacy), a = await f.login("local"), remote = await f.login(ingressHost);
  const aSocket = await f.open(a), remoteSocket = await f.open(remote);
  const pending = await f.request(`/workspace/${a.entry.id}`), request = f.access.pendingAccess().find(r => r.entryId === a.entry.id)!;
  const unused = await f.access.grant(remote.entry.id), before = f.files(), config = f.manager.config();
  await f.access.configure({ ...config, hosts: [...config.hosts, f.enabledHost(secondHost)] });
  await f.access.configure({ ...f.manager.config(), hosts: [...f.manager.config().hosts].reverse() });
  assert.deepEqual(f.files(), before); assert.equal(f.stops.length, 0); assert.equal(f.launches.length, 2);
  assert.equal(f.relays.length, legacy ? 0 : 1); assert.equal(aSocket.destroyed, false); assert.equal(remoteSocket.destroyed, false);
  assert.equal(f.access.pendingAccess().find(r => r.id === request.id)?.code, request.code);
  await f.access.approveAccess(request.id, a.entry.id);
  assert.equal((await f.request(`/workspace/${a.entry.id}`, { headers: { Cookie: pending.headers["set-cookie"]![0].split(";")[0] } })).status, 303);
  assert.equal((await f.request("/authorize", { method: "POST", headers: { Origin: management }, body: new URLSearchParams({ token: unused.token, entryId: remote.entry.id }).toString() })).status, 200);
  const b = await f.login(secondHost), bSocket = await f.open(b), bGrant = await f.access.grant(b.entry.id);
  await f.request(`/workspace/${b.entry.id}`);
  const bRequest = f.access.pendingAccess().find(r => r.entryId === b.entry.id)!;
  assert.equal(new URL(b.entry.url).origin, f.origin); assert.equal(f.relays.length, legacy ? 0 : 1);
  const bClosed = new Promise<void>(resolve => bSocket.once("close", () => resolve()));
  await f.access.configure({ ...f.manager.config(), hosts: f.manager.config().hosts.map(h => h.hostId === secondHost ? { ...h, enabled: false } : h) });
  await bClosed; assert.deepEqual(f.stops, [secondHost]);
  assert.equal(aSocket.destroyed, false); assert.equal(remoteSocket.destroyed, false);
  assert.equal(f.access.pendingAccess().some(r => r.id === bRequest.id), false);
  await f.access.configure({ ...f.manager.config(), hosts: f.manager.config().hosts.map(h => ({ ...h, enabled: true })) });
  assert.match((await f.request(`/workspace/${b.entry.id}`, { headers: { Cookie: b.cookie } })).body, /等待 Gateway 授权/);
  assert.equal((await f.request("/authorize", { method: "POST", headers: { Origin: management }, body: new URLSearchParams({ token: bGrant.token, entryId: b.entry.id }).toString() })).status, 401);
  await assert.rejects(f.access.approveAccess(bRequest.id, b.entry.id));
  const echo = new Promise<string>(resolve => aSocket.once("data", data => resolve(String(data)))); aSocket.write("still-alive"); assert.equal(await echo, "still-alive");
  const durable = [...f.files().values()].flatMap(data => JSON.parse(data).sessions);
  assert.equal(durable.some(record => record.session.entryId === b.entry.id), false);
  assert.ok(durable.some(record => record.session.entryId === a.entry.id));
});

test("new offline endpoint fails independently and a later retry does not restart the existing shared relay", async t => {
  const f = await fixture(t), a = await f.login("local"), socket = await f.open(a), before = f.files();
  f.offline.add(secondHost); const port = await freePort();
  await f.access.configure({ ...f.manager.config(), hosts: [...f.manager.config().hosts, { ...f.enabledHost(secondHost),
    access: { publicOrigin: `https://203.0.113.11:${port}`, bindAddress: "192.168.5.4", port: 80 } }] });
  await until(() => f.relays.includes(secondHost));
  assert.equal(f.access.statuses().find(s => s.hostId === ingressHost)?.state, "ready");
  assert.equal(socket.destroyed, false); assert.deepEqual(f.files(), before); assert.equal(f.stops.length, 0);
  assert.equal(f.relays.filter(h => h === ingressHost).length, 1);
  const b = await f.login(secondHost);
  assert.equal((await f.request(`/open/${b.entry.id}`, { method: "POST", headers: { Cookie: b.cookie, Origin: f.origin }, body: "csrf=wrong" })).status, 403);
  f.offline.delete(secondHost);
  await until(() => f.access.statuses().find(s => s.hostId === secondHost)?.state === "ready");
  assert.equal(f.relays.filter(h => h === ingressHost).length, 1); assert.equal(socket.destroyed, false);
});

test("binary changes fence only the affected host, including pre-instance directory work and late trust grants", async t => {
  const f = await fixture(t), a = await f.login("local"), socket = await f.open(a);
  await f.access.configure({ ...f.manager.config(), hosts: [...f.manager.config().hosts, f.enabledHost(secondHost)] });
  const b = await f.login(secondHost), gate = latch(); f.gates.set(secondHost, gate);
  const pendingStart = assert.rejects(f.manager.open(b.entry.id), /改变/);
  const lateGrant = assert.rejects(f.access.grant(b.entry.id, true), /改变/);
  await delay(5);
  await f.access.configure({ ...f.manager.config(), hosts: f.manager.config().hosts.map(h => h.hostId === secondHost ? { ...h, binary: "/new/code-server" } : h) });
  gate.release(); await Promise.all([pendingStart, lateGrant]);
  assert.deepEqual(f.launches.map(i => i.hostId), ["local"]); assert.equal(socket.destroyed, false); assert.equal(f.stops.length, 0);
  assert.match((await f.request(`/workspace/${b.entry.id}`, { headers: { Cookie: b.cookie } })).body, /等待 Gateway 授权/);
});

test("configuration commits are serialized, caller snapshots are immutable, and validation failure leaves existing service untouched", async t => {
  const f = await fixture(t), browser = await f.login("local"), socket = await f.open(browser), before = f.files();
  const gate = latch(), order: string[] = [], validate = f.access.validateConfig.bind(f.access);
  t.mock.method(f.access, "validateConfig", async (config: IDEConfig) => {
    const added = config.hosts.at(-1)!.hostId; order.push(added); if (added === secondHost) await gate.promise;
    if (added === "remote:invalid") throw Error("fixture validation failure"); await validate(config);
  });
  const base = f.manager.config(), first = { ...base, hosts: [...base.hosts, f.enabledHost(secondHost)] };
  const added = f.access.configure(first); first.hosts.at(-1)!.binary = "/caller/mutation";
  const second = f.access.configure({ ...base, hosts: [...base.hosts, f.enabledHost(secondHost), f.enabledHost("remote:third")] });
  await until(() => order.length === 1); assert.deepEqual(f.manager.config(), base);
  gate.release(); await Promise.all([added, second]);
  assert.deepEqual(order, [secondHost, "remote:third"]); assert.equal(f.manager.config().hosts.find(h => h.hostId === secondHost)!.binary, "code-server");
  const stable = f.manager.config();
  await assert.rejects(f.access.configure({ ...stable, hosts: [...stable.hosts, f.enabledHost("remote:invalid")] }), /validation failure/);
  assert.deepEqual(f.manager.config(), stable); assert.deepEqual(f.files(), before); assert.equal(socket.destroyed, false); assert.equal(f.relays.length, 1);
});

test("failed durable revocation prevents configuration commit; retry persists the tombstone before host removal", async t => {
  const f = await fixture(t), a = await f.login("local"), socket = await f.open(a);
  await f.access.configure({ ...f.manager.config(), hosts: [...f.manager.config().hosts, f.enabledHost(secondHost)] });
  const b = await f.login(secondHost), base = f.manager.config(), rename = fs.renameSync;
  const mocked = t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to).includes("authorization")) throw Error("fixture read-only authorization state"); return rename(from, to);
  });
  const removed = { ...base, hosts: base.hosts.filter(h => h.hostId !== secondHost) };
  await assert.rejects(f.access.configure(removed), /read-only/);
  assert.deepEqual(f.manager.config(), base); assert.equal(socket.destroyed, false); assert.equal(f.stops.length, 0);
  mocked.mock.restore(); await f.access.configure(removed);
  await f.access.configure(base);
  assert.match((await f.request(`/workspace/${b.entry.id}`, { headers: { Cookie: b.cookie } })).body, /等待 Gateway 授权/);
  assert.equal([...f.files().values()].flatMap(value => JSON.parse(value).sessions).some(record => record.session.entryId === b.entry.id), false);
});

test("automatic installation permission and entrance maintenance do not stop unrelated project processes", async t => {
  const f = await fixture(t), browser = await f.login("local"), socket = await f.open(browser), before = f.files();
  const base = f.manager.config(), withInstall = { ...base, hosts: base.hosts.map(h => ({ ...h, autoInstall: true })) };
  await f.access.configure(withInstall);
  const withoutInstall = { ...withInstall, hosts: withInstall.hosts.map(h => h.hostId === "local" ? { ...h, autoInstall: false } : h) };
  const changes = runtimeChanges(withInstall, withoutInstall);
  assert.deepEqual([...changes.stopHosts], []); assert.deepEqual([...changes.cancelInstalls], ["local"]);
  await f.access.configure(withoutInstall);
  const port = await freePort();
  await f.access.configure({ ...f.manager.config(), port, publicOrigin: `http://127.0.0.1:${port}` });
  assert.equal(socket.destroyed, false); assert.deepEqual(f.files(), before); assert.equal(f.stops.length, 0); assert.equal(f.relays.length, 1);
});

test("a Profile change stops its project instances but keeps the independent relay alive; global disable remains explicit", async t => {
  const f = await fixture(t), a = await f.login("local"), b = await f.login(ingressHost);
  const aSocket = await f.open(a), bSocket = await f.open(b), base = f.manager.config();
  const aClosed = new Promise<void>(resolve => aSocket.once("close", resolve)), bClosed = new Promise<void>(resolve => bSocket.once("close", resolve));
  await f.access.configure({ ...base, profile: { ...base.profile, settings: { ...base.profile.settings, "editor.fontSize": 14 } } });
  await Promise.all([aClosed, bClosed]);
  assert.deepEqual([...f.stops].sort(), ["local", ingressHost].sort()); assert.equal(f.relays.length, 1);
  assert.match((await f.request(`/workspace/${a.entry.id}`, { headers: { Cookie: a.cookie } })).body, /等待 Gateway 授权/);
  await f.access.configure({ ...f.manager.config(), enabled: false });
  assert.equal(f.access.running(), false); assert.equal(f.access.statuses().length, 0); assert.equal(f.manager.entry("account", "local"), undefined);
  await f.access.configure({ ...f.manager.config(), enabled: true });
  await until(() => f.access.statuses().some(s => s.hostId === ingressHost && s.state === "ready"));
  assert.match((await f.request(`/workspace/${b.entry.id}`, { headers: { Cookie: b.cookie } })).body, /等待 Gateway 授权/);
  assert.equal(f.launches.length, 2, "re-enabling never silently restarts a stopped IDE");
});

test("hot-add leaves existing startup preparation alone; disabling that host cancels only its launch", async t => {
  const f = await fixture(t), a = await f.login("local"), socket = await f.open(a);
  await f.access.configure({ ...f.manager.config(), hosts: [...f.manager.config().hosts, f.enabledHost(secondHost)] });
  const b = await f.login(secondHost); f.launchGates.set(secondHost, latch());
  const starting = assert.rejects(f.manager.open(b.entry.id), /cancelled/);
  await until(() => f.launches.some(input => input.hostId === secondHost));
  const launch = f.launches.find(input => input.hostId === secondHost)!;
  await f.access.configure({ ...f.manager.config(), hosts: [...f.manager.config().hosts, f.enabledHost("remote:third")] });
  assert.equal(launch.signal!.aborted, false); assert.equal(f.manager.list().find(i => i.hostId === secondHost)?.status, "starting");
  await f.access.configure({ ...f.manager.config(), hosts: f.manager.config().hosts.map(h => h.hostId === secondHost ? { ...h, enabled: false } : h) });
  await starting; assert.equal(launch.signal!.aborted, true); assert.equal(socket.destroyed, false);
  assert.equal(f.stops.length, 0); assert.equal(f.relays.length, 1);
});
