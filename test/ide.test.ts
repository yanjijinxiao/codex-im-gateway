import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IDEConfigStore } from "../src/ide/config.js";
import { WorkspaceIDEManager, type IDEWorkspace } from "../src/ide/manager.js";
import { IDEAccessServer } from "../src/ide/access-server.js";
import type { IDEHostTransport, IDELaunchInput } from "../src/ide/transport.js";
import { ideEntryLink, withIDEEntry } from "../src/ide/completion.js";
import { IDE_SETTING_DEFAULTS } from "../src/ide/profile.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { resolveStatePaths, accountStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { AccountManager } from "../src/server/account-manager.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { TurnAudienceJournal } from "../src/bridge/turn-audience.js";

async function freePort(): Promise<number> {
  const server = net.createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function config(store: IDEConfigStore, port = 8790) {
  return { ...store.config(), enabled: true, port, publicOrigin: `http://127.0.0.1:${port}`,
    hosts: [{ hostId: "local", enabled: true, binary: "code-server" }, { hostId: "remote:test", enabled: true, binary: "/tools/code-server" }] };
}
class FakeTransport implements IDEHostTransport {
  launches: IDELaunchInput[] = [];
  servers: http.Server[] = [];
  sockets: net.Socket[] = [];
  async canonicalDirectory(_host: string, directory: string) { return directory.replace("/alias", "/canonical"); }
  async launch(input: IDELaunchInput) {
    this.launches.push(input);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cig-upstream-")), socketPath = path.join(directory, "ide.sock");
    let alive = true;
    const server = http.createServer((req, res) => {
      if (req.url === "/healthz") { res.writeHead(200).end("{}"); return; }
      res.setHeader("Set-Cookie", "cig_ide_session=evil; Path=/");
      res.end(JSON.stringify({ headers: req.headers, url: req.url }));
    });
    server.on("connection", socket => { this.sockets.push(socket); });
    server.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); this.servers.push(server);
    return { socketPath, ...(input.rootPaths ? { workspaceFile: `/private/ide/${input.id}/project.code-workspace` } : {}), alive: () => alive, stop: async () => {
      alive = false; for (const socket of this.sockets) socket.destroy();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    } };
  }
}

test("IDE config is opt-in, needs no separate password and rejects unsafe origins/settings/extensions", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-config-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new IDEConfigStore(root); assert.equal(store.config().enabled, false);
  store.save(config(store));
  assert.equal(JSON.stringify(store.config()).includes("password"), false);
  fs.writeFileSync(store.filePath, JSON.stringify({ ...store.config(), passwordHash: "legacy-private-hash" }));
  assert.equal(store.config().enabled, true); store.save(store.config());
  assert.equal(fs.readFileSync(store.filePath, "utf8").includes("passwordHash"), false);
  assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
  for (const origin of ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?token=x"]) assert.throws(() => store.save({ ...config(store), publicOrigin: origin }));
  for (const settings of [{ "terminal.integrated.env.linux": { KEY: "secret" } }, { "github.copilot.chat.otel.outfile": "/tmp/log" }, { "python.defaultInterpreterPath": "/evil" }]) assert.throws(() => store.save({ ...config(store), profile: { settings, extensions: [] } }));
  assert.throws(() => store.save({ ...config(store), profile: { settings: {}, extensions: ["ms-python.vscode-pylance"] } }));
});

test("canonical host/owner/profile instance reuse, concurrent opens and fresh target validation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-manager-")), transport = new FakeTransport();
  const targets: Record<string, IDEWorkspace> = { a: { owner: "owner", sessionId: "a", workspace: "/alias/project", hostId: "local", projectName: "test" },
    b: { owner: "owner", sessionId: "b", workspace: "/canonical/project", hostId: "local", projectName: "test" } };
  const manager = new WorkspaceIDEManager({ root, transport, resolve: (_account, session) => targets[session] });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  manager.configStore.save(config(manager.configStore));
  const a = manager.entry("account", "a")!, b = manager.entry("account", "b")!;
  assert.equal(transport.launches.length, 0, "links never start an IDE");
  await Promise.all([manager.open(a.id), manager.open(a.id), manager.open(b.id)]);
  assert.equal(transport.launches.length, 1); assert.ok(manager.endpoint(a.id)); assert.ok(manager.endpoint(b.id));
  assert.equal(transport.launches[0].workspace, "/canonical/project");
  targets.a = { ...targets.a, workspace: "/different/project" }; assert.equal(manager.endpoint(a.id), undefined);
  delete targets.b; assert.throws(() => manager.endpoint(b.id), /失效/);
  assert.equal(manager.entry("account", "none"), undefined);
});

test("external first hop silently rechecks Strict cookies without approval UI, grants or IDE startup", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-first-hop-")), transport = new FakeTransport();
  const manager = new WorkspaceIDEManager({ root, transport, resolve: () => ({ owner: "owner", sessionId: "s",
    workspace: "/project", hostId: "local", projectName: "project" }) });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, management = "http://127.0.0.1:18788";
  manager.configStore.save(config(manager.configStore, port));
  const access = new IDEAccessServer(manager); access.setManagementOrigin(management); await access.reload(false);
  t.after(async () => { await access.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const entry = manager.entry("a", "s")!, checked = `${entry.url}?auth_check=1`;
  const first = await fetch(entry.url, { headers: { "Sec-Fetch-Site": "cross-site" } }), html = await first.text();
  assert.equal(first.status, 200); assert.match(html, /正在核验已有授权/);
  assert.doesNotMatch(html, /等待 Gateway 授权|<section data-ide-wait|<form/);
  assert.match(html, new RegExp(`location\\.replace\\("/workspace/${entry.id}\\?auth_check=1"\\)`));
  assert.equal(first.headers.get("set-cookie"), null); assert.equal(first.headers.get("refresh"), null);
  assert.match(first.headers.get("content-security-policy")!, /script-src 'nonce-/);
  assert.equal(access.pendingAccess().length, 0); assert.equal(transport.launches.length, 0);
  const unauthenticated = await fetch(checked);
  assert.match(await unauthenticated.text(), /等待 Gateway 授权/);
  assert.equal(access.pendingAccess().length, 1, "the public marker is not authorization");
  assert.equal(transport.launches.length, 0);
  const grant = await access.grant(entry.id);
  const login = await fetch(origin + "/authorize", { method: "POST", redirect: "manual", headers: { Origin: management },
    body: new URLSearchParams({ entryId: entry.id, token: grant.token }) });
  assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const verified = await fetch(checked, { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" } });
  const ready = await verified.text();
  assert.match(ready, /data-ide-auto-open/); assert.doesNotMatch(ready, /等待 Gateway 授权/);
  assert.equal(transport.launches.length, 0, "GET recheck must remain read-only");
  const csrf = /name="csrf" value="([^"]+)"/.exec(ready)![1];
  const opened = await fetch(`${origin}/open/${entry.id}`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ csrf }) });
  assert.equal(opened.status, 303);
  const again = await fetch(entry.url, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(again.status, 303); assert.match(again.headers.get("location")!, /^\/ide\//);
  assert.equal(transport.launches.length, 1);
});

test("temporary membership failure returns retryable 503, preserves existing grants and POST tickets, and never opens a stale target", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-membership-unavailable-")), transport = new FakeTransport();
  let unavailable = false, removed = false;
  const target: IDEWorkspace = { owner: "owner", sessionId: "s", workspace: "/project", hostId: "local", projectName: "project", projectId: "p" };
  const manager = new WorkspaceIDEManager({ root, transport, resolve: () => removed ? undefined : target,
    refresh: async () => { if (unavailable) throw Error("thread/read timed out"); return removed ? undefined : target; } });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, management = "http://127.0.0.1:18788";
  manager.configStore.save(config(manager.configStore, port));
  const access = new IDEAccessServer(manager); access.setManagementOrigin(management); await access.reload(false);
  t.after(async () => { await access.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const entry = manager.entry("account", "s")!, grant = await access.grant(entry.id);
  const authorizationBytes = () => fs.existsSync(manager.authorizationFile()) ? fs.readFileSync(manager.authorizationFile(), "utf8") : undefined;
  const before = authorizationBytes();
  unavailable = true;
  const page = await fetch(entry.url), text = await page.text();
  assert.equal(page.status, 503); assert.equal(page.headers.get("retry-after"), "3");
  assert.match(text, /项目状态暂时无法核验/); assert.match(text, /setTimeout\(\(\)=>location.reload\(\),3000\)/); assert.doesNotMatch(text, /<section data-ide-wait|<form data-ide-auto-open/);
  assert.equal(page.headers.get("set-cookie"), null); assert.equal(access.pendingAccess().length, 0); assert.equal(transport.launches.length, 0);
  const form = new URLSearchParams({ entryId: entry.id, token: grant.token });
  const blocked = await fetch(origin + "/authorize", { method: "POST", redirect: "manual", headers: { Origin: management }, body: form });
  assert.equal(blocked.status, 503); assert.doesNotMatch(await blocked.text(), /setTimeout\(\(\)=>location.reload/);
  assert.equal(authorizationBytes(), before, "failed observation cannot consume or revoke a ticket");
  unavailable = false;
  const authorized = await fetch(origin + "/authorize", { method: "POST", redirect: "manual", headers: { Origin: management }, body: form });
  assert.equal(authorized.status, 303); const cookie = authorized.headers.get("set-cookie")!.split(";")[0];
  const granted = fs.readFileSync(manager.authorizationFile(), "utf8");
  unavailable = true;
  assert.equal((await fetch(entry.url, { headers: { Cookie: cookie } })).status, 503);
  assert.equal(fs.readFileSync(manager.authorizationFile(), "utf8"), granted, "an existing browser login is retained");
  unavailable = false;
  assert.match(await (await fetch(entry.url, { headers: { Cookie: cookie } })).text(), /data-ide-auto-open/);
  removed = true;
  assert.equal((await fetch(entry.url)).status, 404, "actual project removal stays fail-closed");
});

for (const source of ["local", "personal"] as const) test(`${source} browser authentication guards HTTP/WS, strips credentials, denies foreign origins and revokes sockets`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-access-")), transport = new FakeTransport();
  const manager = new WorkspaceIDEManager({ root, transport, resolve: () => ({ owner: "owner", sessionId: "s", workspace: "/project", hostId: "local", projectName: "<project>" }),
    refresh: async () => ({ owner: "owner", sessionId: "s", workspace: "/actual/worktree", hostId: "local", projectName: "<project>" }) });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  manager.configStore.save(config(manager.configStore, port));
  const access = new IDEAccessServer(manager); await access.reload();
  let personalAllowed = true;
  access.setAccessAuthority({ isSubjectAllowed: () => personalAllowed });
  const managementOrigin = "http://127.0.0.1:18788"; access.setManagementOrigin(managementOrigin);
  t.after(async () => { await access.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const entry = manager.entry("account", "s")!;
  const anon = await fetch(entry.url + "?auth_check=1"), waitingPage=await anon.text(); assert.match(waitingPage, /等待 Gateway 授权/); assert.equal(transport.launches.length, 0);
  assert.equal(anon.headers.get("refresh"), null, "HTTP refresh must not interrupt the copy control");
  const nonce=/<script nonce="([^"]+)">/.exec(waitingPage)![1];
  assert.match(anon.headers.get("content-security-policy")!,new RegExp(`script-src 'nonce-${nonce.replace(/[+]/g,"\\+")}'`));
  assert.match(waitingPage,/data-ide-wait/);assert.match(waitingPage,/data-copy-button/);assert.match(waitingPage,/window\.location\.reload/);
  const primary=waitingPage.split("<details")[0];
  assert.match(primary,/当前浏览器尚未授权，不代表个人准入丢失/);
  assert.doesNotMatch(primary,/请先.*登记|首次.*登记|尚未登记管理员/);
  assert.match(primary,/申请有效期为 5 分钟/);assert.match(primary,/访问授权有效期为 90 天/);
  assert.match(primary,/Gateway 重启保留，不自动延期/);
  assert.match(primary,/撤销个人准入.*重新允许也不会恢复旧登录/);
  assert.match(waitingPage,/<details data-ide-registration-help><summary>首次使用/);
  assert.doesNotMatch(waitingPage,/<details[^>]*\bopen\b/);
  assert.equal(anon.headers.get("referrer-policy"), "strict-origin-when-cross-origin", "native browser POST must retain a verifiable Origin");
  let logged: Response;
  if (source === "local") {
    const grant = await access.grant(entry.id);
    const login = (originHeader: string) => fetch(`${origin}/authorize`, { method: "POST", headers: { Origin: originHeader }, redirect: "manual",
      body: new URLSearchParams({ token: grant.token, entryId: entry.id }) });
    assert.equal((await login("https://evil.invalid")).status, 403);
    logged = await login(managementOrigin); assert.equal(logged.status, 303);
    assert.equal((await login(managementOrigin)).status, 401, "grant cannot be replayed");
  } else {
    const request = access.pendingAccess()[0];
    await access.approveAccess(request.id, entry.id, false, undefined, {
      principal: { accountId: "account", channel: "dingtalk", providerId: "bot", actorId: "alice" }, basis: "im-personal", epoch: 0 });
    logged = await fetch(entry.url + "?auth_check=1", { headers: { Cookie: anon.headers.get("set-cookie")!.split(";")[0] }, redirect: "manual" });
    assert.equal(logged.status, 303);
  }
  const cookie = logged.headers.get("set-cookie")!.split(";")[0]; assert.match(logged.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  assert.match(logged.headers.get("set-cookie")!, /Max-Age=7776000/);
  const landing = await fetch(entry.url + "?auth_check=1", { headers: { Cookie: cookie } }); const html = await landing.text();
  assert.match(html, /&lt;project&gt;/); const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
  assert.equal((await fetch(`${origin}/open/${entry.id}`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: "csrf=wrong" })).status, 403);
  const opened = await fetch(`${origin}/open/${entry.id}`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ csrf }), redirect: "manual" });
  assert.equal(opened.status, 303); assert.equal(new URL(opened.headers.get("location")!, origin).searchParams.get("folder"), "/actual/worktree");
  assert.equal(transport.launches[0].workspace, "/actual/worktree");
  const response = await fetch(`${origin}/ide/${entry.id}/file?q=x`, { headers: { Cookie: cookie, Authorization: "Bearer private", "X-Codex-IM-Gateway-Token": "admin-secret" } });
  const echo = await response.json(); assert.equal(echo.url, "/file?q=x"); assert.equal(echo.headers.cookie, undefined);
  assert.equal(echo.headers.authorization, undefined); assert.equal(echo.headers["x-codex-im-gateway-token"], undefined); assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { Cookie: cookie } })).status, 401, "project cookie is not a Gateway management credential");
  const ws = await new Promise<net.Socket>((resolve, reject) => {
    const request = http.request(`${origin}/ide/${entry.id}/socket`, { headers: { Cookie: cookie, Origin: origin, Connection: "Upgrade", Upgrade: "websocket" } });
    request.on("upgrade", (_res, socket) => resolve(socket)); request.on("error", reject); request.end();
  });
  const closed = new Promise<void>(resolve => ws.once("close", () => resolve()));
  if (source === "personal") { personalAllowed = false; access.reconcileAccess(); } else access.revoke();
  await closed;
  assert.equal((await fetch(`${origin}/ide/${entry.id}/file`, { headers: { Cookie: cookie }, redirect: "manual" })).status, 303);
});

test("management entry API is mutation-protected and never trusts a client path or host", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-api-")), transport = new FakeTransport();
  const ide = new WorkspaceIDEManager({ root, transport, resolve: (a,s) => a === "account" && s === "s" ? { owner: "owner", sessionId: s, workspace: "/project", hostId: "local", projectName: "test" } : undefined });
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), port: 0, accountManager: { ide, listProjects: () => [] } as never });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const headers = { Origin: server.url, "X-Codex-IM-Gateway-Token": server.requestToken, "Content-Type": "application/json" };
  assert.equal((await fetch(`${server.url}/api/ide/entry`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(`${server.url}/api/ide/entry`, { method: "POST", headers, body: JSON.stringify({ accountId: "account", sessionId: "s", workspace: "/etc" }) })).status, 400);
  assert.equal((await fetch(`${server.url}/api/ide/entry`, { method: "POST", headers, body: JSON.stringify({ accountId: "account", sessionId: "s" }) })).status, 409);
  const data = await (await fetch(`${server.url}/api/ide`)).json(); assert.equal(data.config.enabled, false); assert.equal(data.passwordHash, undefined);
  assert.equal(data.authorization.sessionTtlDays, 90);
});

test("browser cookie survives access-server restart and trusted workbench cannot switch root", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-restart-")), store = new IDEConfigStore(root);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, managementOrigin = "http://127.0.0.1:18788";
  // This test restarts a listener on the same port. Test cookie persistence on
  // new connections, not undici's race to reuse a just-destroyed keepalive socket.
  const freshFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers); headers.set("Connection", "close");
    return fetch(input, { ...init, headers });
  };
  store.save(config(store, port)); const all: IDEAccessServer[] = [];
  t.after(async () => { for (const server of all) await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function start() {
    const transport = new FakeTransport(), manager = new WorkspaceIDEManager({ root, transport,
      resolve: () => ({ owner: "owner", sessionId: "s", hostId: "local", workspace: "/exact/project", projectName: "project" }) });
    const access = new IDEAccessServer(manager); all.push(access); access.setManagementOrigin(managementOrigin); await access.reload(false);
    return { access, manager, transport };
  }
  const first = await start(), entry = first.manager.entry("a", "s")!, grant = await first.access.grant(entry.id, true);
  const login = await freshFetch(`${origin}/authorize`, { method: "POST", redirect: "manual", headers: { Origin: managementOrigin },
    body: new URLSearchParams({ entryId: entry.id, token: grant.token }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  await login.text();
  await first.access.close();
  const second = await start(), landing = await (await freshFetch(entry.url + "?auth_check=1", { headers: { Cookie: cookie } })).text();
  assert.doesNotMatch(landing, /等待 Gateway 授权/); assert.match(landing, /Gateway 已授权并信任/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(landing)![1];
  const opened = await freshFetch(`${origin}/open/${entry.id}`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ csrf }), redirect: "manual" });
  assert.equal(opened.status, 303); assert.equal(second.transport.launches[0].trustWorkspace, true);
  assert.equal((await freshFetch(`${origin}/ide/${entry.id}/?folder=/different/project`, { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await freshFetch(`${origin}/ide/${entry.id}/?folder=/exact/project`, { headers: { Cookie: cookie } })).status, 200);
  second.access.revoke(); await second.access.close();
  await start(); assert.match(await (await freshFetch(entry.url + "?auth_check=1", { headers: { Cookie: cookie } })).text(), /等待 Gateway 授权/);
});

test("an IM entry pairs only the approved browser and project changes invalidate existing grants", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-pair-")), transport = new FakeTransport();
  let workspace = "/project";
  const manager = new WorkspaceIDEManager({ root, transport, resolve: (_a, sessionId) => ({ owner: "owner", sessionId,
    hostId: "local", workspace, projectName: "project" }) });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  manager.configStore.save(config(manager.configStore, port));
  const access = new IDEAccessServer(manager); access.setManagementOrigin("http://127.0.0.1:18788"); await access.reload();
  t.after(async () => { await access.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const entry = manager.entry("a", "one")!, other = manager.entry("a", "two")!;
  const visit = await fetch(entry.url + "?auth_check=1"), proofCookie = visit.headers.get("set-cookie")!.split(";")[0];
  assert.doesNotMatch(await visit.text(), /type="password"/);
  const pending = access.pendingAccess()[0]; assert.equal("proof" in pending, false);
  await access.approveAccess(pending.id, entry.id);
  const stranger = await fetch(entry.url + "?auth_check=1"); assert.match(await stranger.text(), /等待 Gateway 授权/);
  const confirmed = await fetch(entry.url + "?auth_check=1", { headers: { Cookie: proofCookie }, redirect: "manual" });
  assert.equal(confirmed.status, 303); const cookie = confirmed.headers.get("set-cookie")!.split(";")[0];
  assert.match(await (await fetch(entry.url + "?auth_check=1", { headers: { Cookie: cookie } })).text(), /打开 Web IDE/);
  assert.match(await (await fetch(other.url + "?auth_check=1", { headers: { Cookie: cookie } })).text(), /等待 Gateway 授权/);
  const grant = await access.grant(entry.id); workspace = "/new-project";
  assert.match(await (await fetch(entry.url + "?auth_check=1", { headers: { Cookie: cookie } })).text(), /等待 Gateway 授权/);
  const stale = await fetch(`${origin}/authorize`, { method: "POST", headers: { Origin: "http://127.0.0.1:18788" },
    body: new URLSearchParams({ token: grant.token, entryId: entry.id }) });
  assert.equal(stale.status, 401); assert.equal(transport.launches.length, 0);
});

test("local Gateway mints IDE access only behind mutation protection and no password API remains", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-grant-api-")), transport = new FakeTransport();
  const projects: { hostId: string }[] = [];
  const ide = new WorkspaceIDEManager({ root, transport, resolve: (_a, id) => ({ owner: "owner", sessionId: id,
    hostId: id === "remote" ? "remote:new" : "local", workspace: "/project", projectName: "test" }) });
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), port: 0, accountManager: { ide, listProjects: () => projects } as never });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const headers = { Origin: server.url, "X-Codex-IM-Gateway-Token": server.requestToken, "Content-Type": "application/json" };
  const settings = config(ide.configStore, await freePort());
  settings.hosts = settings.hosts.filter(host => host.hostId === "local");
  assert.equal((await fetch(`${server.url}/api/ide/config`, { method: "PUT", headers, body: JSON.stringify({ config: settings, password: "obsolete-password" }) })).status, 400);
  const saved = await fetch(`${server.url}/api/ide/config`, { method: "PUT", headers, body: JSON.stringify({ config: settings }) });
  assert.equal(saved.status, 200, await saved.text());
  const entry = ide.entry("a", "s")!;
  const body = JSON.stringify({ entryId: entry.id });
  assert.equal((await fetch(`${server.url}/api/ide/access`, { method: "POST", body })).status, 403);
  const grant = await (await fetch(`${server.url}/api/ide/access`, { method: "POST", headers, body })).json();
  assert.equal(grant.action, settings.publicOrigin + "/authorize"); assert.ok(grant.token);
  const login = await fetch(grant.action, { method: "POST", redirect: "manual", headers: { Origin: server.url }, body: new URLSearchParams({ token: grant.token, entryId: entry.id }) });
  assert.equal(login.status, 303); const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const hotConfig = { ...ide.config(), hosts: [...ide.config().hosts, { hostId: "remote:new", enabled: true, autoInstall: false, binary: "code-server" }] };
  assert.equal((await fetch(`${server.url}/api/ide/config`, { method: "PUT", headers, body: JSON.stringify({ config: hotConfig }) })).status, 400, "an arbitrary host cannot be hot-enabled");
  projects.push({ hostId: "remote:new" });
  assert.equal(ide.entry("a", "remote"), undefined, "project discovery alone does not enable IDE or installation");
  assert.equal((await fetch(`${server.url}/api/ide/config`, { method: "PUT", body: JSON.stringify({ config: hotConfig }) })).status, 403);
  assert.equal((await fetch(`${server.url}/api/ide/config`, { method: "PUT", headers, body: JSON.stringify({ config: hotConfig }) })).status, 200);
  assert.ok(ide.entry("a", "remote")); assert.equal(transport.launches.length, 0);
  assert.match(await (await fetch(entry.url + "?auth_check=1", { headers: { Cookie: cookie } })).text(), /打开 Web IDE/, "the protected config API preserves unrelated browser grants");
  assert.equal((await fetch(`${settings.publicOrigin}/login`, { method: "POST", headers: { Origin: settings.publicOrigin }, body: "password=x" })).status, 401);
  const revoke = await fetch(`${server.url}/api/ide/revoke`, { method: "POST", headers }); assert.equal(revoke.status, 200);
});

test("workspace resolution requires actual managed project membership and host identity", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-resolve-")), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "account", token: "test", baseUrl: "http://localhost" });
  const store = new RuntimeStateStore(accountStatePaths(paths, "account"));
  const project = store.createProject("remote", "/project", { hostId: "remote:test", projectKind: "remote" });
  const session = store.createSession("conversation", "/project", "task", project.id);
  const manager = new AccountManager({ paths }); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(manager.ideWorkspace("account", session.id)?.workspace, "/project");
  assert.equal(manager.ideWorkspace("account", session.id)?.hostId, "remote:test");
  const noProject = store.createSession("other", "/project", "independent", undefined, "session", undefined, { standalone: true });
  assert.equal(manager.ideWorkspace("account", noProject.id), undefined);
});

test("same project entry opens both roots only after explicit expanded approval and persists exact trust", async t => {
  const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...init.headers, Connection: "close" } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-multi-http-")), transport = new FakeTransport();
  let target: IDEWorkspace = { owner: "owner", sessionId: "s", hostId: "local", workspace: "/alias/bridge", projectName: "two repos" };
  const manager = new WorkspaceIDEManager({ root, transport, resolve: () => target });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, management = "http://127.0.0.1:18788";
  manager.configStore.save(config(manager.configStore, port));
  let access = new IDEAccessServer(manager); access.setManagementOrigin(management); await access.reload(false);
  t.after(async () => { await access.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const entry = manager.entry("a", "s")!;
  const login = async (trust: boolean) => {
    const grant = await access.grant(entry.id, trust);
    const response = await request(grant.action, { method: "POST", redirect: "manual", headers: { Origin: management }, body: new URLSearchParams({ entryId: entry.id, token: grant.token }) });
    assert.equal(response.status, 303); return response.headers.get("set-cookie")!.split(";")[0];
  };
  const oldCookie = await login(true);
  target = { ...target, rootPaths: ["/alias/bridge", "/alias/farming"] };
  assert.equal(manager.entry("a", "s")!.url, entry.url, "project keeps its single stable link");
  const pending = await request(entry.url + "?auth_check=1", { headers: { Cookie: oldCookie } });
  const html = await pending.text(); assert.match(html, /等待 Gateway 授权/); assert.match(html, /2 个目录/);
  assert.match(html, /\/alias\/bridge/); assert.match(html, /\/alias\/farming/);
  assert.deepEqual(access.pendingAccess()[0].rootPaths, target.rootPaths);
  assert.equal(transport.launches.length, 0, "old single root grant cannot launch expanded scope");
  const cookie = await login(true), approved = await (await request(entry.url, { headers: { Cookie: cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(approved)![1];
  const opened = await request(`${origin}/open/${entry.id}`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ csrf }) });
  assert.equal(opened.status, 303); const location = opened.headers.get("location")!;
  assert.match(location, /\?workspace=/); assert.doesNotMatch(location, /\?folder=/);
  assert.deepEqual(transport.launches[0].rootPaths, ["/canonical/bridge", "/canonical/farming"]);
  for (const query of ["folder=/etc", "workspace=/etc/other.code-workspace", "ew=true", "workspace=a&workspace=b"]) {
    const denied = await request(`${origin}/ide/${entry.id}/?${query}`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(denied.status, 403); await denied.text();
  }
  const warm = await request(entry.url, { headers: { Cookie: cookie }, redirect: "manual" }); assert.equal(warm.headers.get("location"), location);
  const persisted = JSON.parse(fs.readFileSync(manager.authorizationFile(), "utf8"));
  const multi = persisted.sessions.find((item: any) => item.session.trustedRootPaths);
  assert.deepEqual(multi.session.trustedRootPaths, ["/canonical/bridge", "/canonical/farming"]);
  const expiry = multi.session.expiresAt;
  await access.close(); access = new IDEAccessServer(manager); access.setManagementOrigin(management); await access.reload(false);
  const after = await (await request(entry.url, { headers: { Cookie: cookie } })).text();
  assert.doesNotMatch(after, /等待 Gateway 授权/); assert.match(after, /data-ide-auto-open/);
  assert.equal(JSON.parse(fs.readFileSync(manager.authorizationFile(), "utf8")).sessions.find((item: any) => item.session.trustedRootPaths).session.expiresAt, expiry);
  const confirmedScope = manager.authorizationScope(entry.id);
  target = { ...target, rootPaths: [...target.rootPaths!, "/alias/third"] };
  await assert.rejects(access.grant(entry.id, true, confirmedScope), /重新核对完整目录/);
  assert.match(await (await request(entry.url + "?auth_check=1", { headers: { Cookie: cookie } })).text(), /等待 Gateway 授权/);
});

test("managed project metadata exposes all same-host IDE roots without changing session cwd or binding", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-multi-membership-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveAccount(paths, { accountId: "account", token: "test", baseUrl: "http://localhost" });
  const store = new RuntimeStateStore(accountStatePaths(paths, "account"));
  const project = store.createProject("two", "/bridge", { hostId: "remote:test", projectKind: "remote", rootPaths: ["/bridge", "/farming"] });
  const session = store.createSession("conversation", "/bridge", "task", project.id); store.setSessionThread(session.id, "native");
  const manager = new AccountManager({ paths }), target = manager.ideWorkspace("account", session.id)!;
  assert.deepEqual(target.rootPaths, ["/bridge", "/farming"]); assert.equal(target.workspace, "/bridge"); assert.equal(target.hostId, "remote:test");
  const unchanged = new RuntimeStateStore(accountStatePaths(paths, "account")).getSession(session.id)!;
  assert.equal(unchanged.threadId, "native"); assert.equal(unchanged.workspace, "/bridge");
});

test("multi-root canonical checks reject retargeting, missing members and project mutations during approval", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-multi-scope-")), transport = new FakeTransport();
  let target: IDEWorkspace = { owner: "owner", sessionId: "s", hostId: "remote:test", workspace: "/bridge", rootPaths: ["/bridge", "/farming"], projectName: "two" };
  const manager = new WorkspaceIDEManager({ root, transport, resolve: () => target });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  manager.configStore.save(config(manager.configStore)); const entry = manager.entry("a", "s")!;
  const trust = await manager.canonicalForTrust(entry.id);
  await assert.rejects(manager.open(entry.id, true, trust.workspace), /已信任目录不一致/);
  transport.canonicalDirectory = async (_host, directory) => directory === "/farming" ? "/different" : directory;
  await assert.rejects(manager.open(entry.id, true, trust.workspace, trust.rootPaths), /已信任目录不一致/);
  transport.canonicalDirectory = async (_host, directory) => { if (directory === "/farming") throw Error("missing"); return directory; };
  await assert.rejects(manager.open(entry.id), /missing/); assert.equal(transport.launches.length, 0);
  transport.canonicalDirectory = async (_host, directory) => { if (directory === "/farming") target = { ...target, rootPaths: ["/bridge", "/third"] }; return directory; };
  await assert.rejects(manager.canonicalForTrust(entry.id), /项目已改变/);
});

test("real host helper generates a private multi-root workspace without writing config into repositories", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cig-multi-process-")));
  const bridge = path.join(root, "bridge"), farming = path.join(root, "farming");
  fs.mkdirSync(bridge); fs.mkdirSync(farming);
  const manager = new WorkspaceIDEManager({ root, readyTimeoutMs: 3000, resolve: () => ({ owner: "owner", sessionId: "s", hostId: "local",
    workspace: bridge, rootPaths: [bridge, farming], projectName: "two" }) });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  manager.configStore.save({ ...config(manager.configStore), hosts: [{ hostId: "local", enabled: true, binary: path.resolve("test/fixtures/fake-code-server.mjs") }] });
  const entry = manager.entry("a", "s")!, trust = await manager.canonicalForTrust(entry.id);
  const instance = await manager.open(entry.id, true, trust.workspace, trust.rootPaths), endpoint = manager.endpoint(entry.id, true)!;
  assert.ok(instance.workspaceFile); assert.equal(endpoint.workspaceFile, instance.workspaceFile);
  assert.equal(path.dirname(instance.workspaceFile!), path.join(root, "ide", "instances", instance.id));
  const workspace = JSON.parse(fs.readFileSync(instance.workspaceFile!, "utf8"));
  assert.deepEqual(workspace.folders, [{ name: "bridge", path: bridge }, { name: "farming", path: farming }]);
  assert.equal(workspace.settings["terminal.integrated.cwd"], bridge); assert.equal(fs.statSync(instance.workspaceFile!).mode & 0o777, 0o600);
  const calls = fs.readFileSync(path.join(bridge, "cig-fixture-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.at(-1).at(-1), instance.workspaceFile); assert.ok(calls.at(-1).includes("--disable-workspace-trust"));
  assert.deepEqual(fs.readdirSync(farming), []); assert.equal(fs.existsSync(path.join(bridge, ".vscode")), false);
});

test("completion entry is idempotent and separate from model history", () => {
  const url = "https://ide.example.com/workspace/abc";
  assert.equal(withIDEEntry("answer"), "answer"); assert.equal(withIDEEntry(withIDEEntry("answer", url), url), withIDEEntry("answer", url));
  assert.equal(withIDEEntry("answer", url), `answer\n\n[打开项目 Web IDE](${url})`);
  assert.throws(() => ideEntryLink("javascript:alert(1)"));
  assert.equal(ideEntryLink("https://ide.example.com/workspace/(id)"), "[打开项目 Web IDE](https://ide.example.com/workspace/%28id%29)");
  const escapedURL = "https://ide.example.com/workspace/(id)";
  assert.equal(withIDEEntry(withIDEEntry("answer", escapedURL), escapedURL), withIDEEntry("answer", escapedURL));
});

test("real process guardian launches only a private socket and preserves existing user settings", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-process-"));
  const manager = new WorkspaceIDEManager({ root, readyTimeoutMs: 3000,
    resolve: () => ({ owner: "owner", sessionId: "s", hostId: "local", workspace: root, projectName: "fixture" }) });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const fixture = path.resolve("test/fixtures/fake-code-server.mjs");
  manager.configStore.save({ ...config(manager.configStore), hosts: [{ hostId: "local", binary: fixture, enabled: true }] });
  const entry = manager.entry("a", "s")!, instance = await manager.open(entry.id), endpoint = manager.endpoint(entry.id)!;
  const read = () => new Promise<{ cwd: string; args: string[] }>((resolve, reject) => {
    http.get({ socketPath: endpoint.socketPath, path: "/", agent: false }, response => {
      let body = ""; response.on("data", value => body += value); response.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
  const body = await read(); assert.equal(body.cwd, fs.realpathSync(root));
  assert.equal(body.args[body.args.indexOf("--auth") + 1], "none"); assert.ok(body.args.includes("--disable-proxy"));
  assert.ok(body.args.includes("--socket")); assert.equal(body.args.includes("--bind-addr"), false);
  assert.equal(fs.statSync(endpoint.socketPath).mode & 0o777, 0o600);
  const settings = path.join(root, "ide", "instances", instance.id, "data", "User", "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ "editor.fontSize": 18 }));
  await manager.stop(instance.id); await manager.open(entry.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { ...IDE_SETTING_DEFAULTS, "editor.fontSize": 18 });
  const trusted = await manager.open(entry.id, true, fs.realpathSync(root)), trustedEndpoint = manager.endpoint(entry.id, true)!;
  assert.notEqual(trusted.id, instance.id, "a trusted browser must not reuse an untrusted process");
  const trustedArgs = await new Promise<string[]>((resolve, reject) => {
    http.get({ socketPath: trustedEndpoint.socketPath, path: "/", agent: false }, response => {
      let body = ""; response.on("data", value => body += value); response.on("end", () => resolve(JSON.parse(body).args));
    }).on("error", reject);
  });
  assert.ok(trustedArgs.includes("--disable-workspace-trust")); assert.equal(body.args.includes("--disable-workspace-trust"), false);
  await assert.rejects(manager.open(entry.id, true, "/wrong/project"), /已信任目录不一致/);
});

test("pending native cwd validation cannot start an IDE after configuration revocation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-revoke-")), transport = new FakeTransport();
  const target = { owner: "owner", sessionId: "s", hostId: "local", workspace: "/project", projectName: "project" };
  let release!: (value: IDEWorkspace) => void;
  const manager = new WorkspaceIDEManager({ root, transport, resolve: () => target,
    refresh: () => new Promise(resolve => { release = resolve; }) });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  manager.configStore.save(config(manager.configStore)); const entry = manager.entry("a", "s")!;
  const opening = manager.open(entry.id); await manager.close(); release({ ...target, workspace: "/actual-worktree" });
  await assert.rejects(opening, /配置已改变/); assert.equal(transport.launches.length, 0);
});

test("corrupt optional IDE files fail closed without breaking unrelated Gateway construction", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-corrupt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(root, "ide"));
  fs.writeFileSync(path.join(root, "ide/config.json"), "not JSON"); fs.writeFileSync(path.join(root, "ide/workspaces.json"), "not JSON");
  const manager = new AccountManager({ paths: resolveStatePaths(root) });
  assert.equal(manager.ide.config().enabled, false); assert.match(manager.ide.configStore.error!, /配置文件无效/);
  assert.equal(fs.readFileSync(path.join(root, "ide/config.json"), "utf8"), "not JSON");
});

test("final IDE entry is in the same result body passed to participant @ delivery", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-final-"));
  const journal = new TurnAudienceJournal(path.join(root, "audience.json"));
  const scope = { bindingKey: "binding", conversationId: "group", hostId: "local", threadId: "thread", turnId: "turn" };
  journal.record(scope, { bindingKey: "binding", conversationId: "group", actorId: "alice", mention: { userId: "alice" } });
  const finals: string[] = [], notices: string[] = [], url = "https://ide.example.com/workspace/example";
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "group", managed: true,
    client: { capabilities: { progress: "available", mentions: "available", completionMentionCard: "available" } as never,
      resumableTextStream: true, async sendText() { return { messageId: "text" }; },
      async startTextStream() { return { messageId: "original" }; }, async updateTextStream(input) { if (input.finalize) finals.push(input.text); },
      async sendMentionNotification(input) { notices.push(input.completedCard?.text ?? input.text); return { messageId: "mention" }; } } };
  const hub = new ThreadEventHub({ filePath: path.join(root, "hub.json"), turnAudience: journal, subscriptions: () => [sub], backend: () => ({} as never),
    decorateFinal: (_sub, text) => withIDEEntry(text, url) });
  t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.managedTurnStarted(sub, "turn"); await hub.managedCompletion(sub, "turn", "result"); await new Promise(resolve => setImmediate(resolve));
  assert.ok(finals.some(text => text.includes(url))); assert.deepEqual(notices, [withIDEEntry("result", url)]);
});

test("authorized browser enters the usable IDE directly while degraded-profile warnings stay in management status", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-profile-warning-")), transport = new FakeTransport();
  const originalLaunch = transport.launch.bind(transport);
  transport.launch = async input => {
    input.onProfile?.({ phase: "error", requested: ["tuttieee.emacs-mcx"], installed: [], missing: ["tuttieee.emacs-mcx"], warning: "extensions-unavailable" });
    return originalLaunch(input);
  };
  const manager = new WorkspaceIDEManager({ root, transport, resolve: () => ({ owner: "owner", sessionId: "s", hostId: "local", workspace: "/project", projectName: "project" }) });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  manager.configStore.save(config(manager.configStore, port));
  const access = new IDEAccessServer(manager); access.setManagementOrigin("http://127.0.0.1:18788"); await access.reload();
  t.after(async () => { await access.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const entry = manager.entry("a", "s")!, grant = await access.grant(entry.id);
  const login = await fetch(`${origin}/authorize`, { method: "POST", redirect: "manual", headers: { Origin: "http://127.0.0.1:18788" }, body: new URLSearchParams({ entryId: entry.id, token: grant.token }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const landing = await (await fetch(entry.url + "?auth_check=1", { headers: { Cookie: cookie } })).text(), csrf = /name="csrf" value="([^"]+)"/.exec(landing)![1];
  const opened = await fetch(`${origin}/open/${entry.id}`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ csrf }), redirect: "manual" });
  assert.equal(opened.status, 303); assert.match(opened.headers.get("location")!, /^\/ide\//);
  assert.equal(manager.list()[0].profile?.warning, "extensions-unavailable");
  assert.equal(manager.list()[0].status, "running"); assert.ok(manager.endpoint(entry.id));
  assert.equal((await fetch(`${origin}/ide/${entry.id}/`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${origin}/ide/${entry.id}/`, { redirect: "manual" })).status, 303);
});
