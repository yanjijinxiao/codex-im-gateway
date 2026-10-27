import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { resolveStatePaths } from "../src/state/paths.js";

const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
const apiSource = source.slice(source.indexOf("async function api("), source.indexOf("\nfunction emptyState("));
const rejection = () => new Response(JSON.stringify({ code: "request-token-invalid", submission: "not-submitted" }), { status: 403 });
const old = "a".repeat(32), fresh = "b".repeat(32);
function browser(fetch: typeof globalThis.fetch) {
  const context = vm.createContext({ state: { requestToken: old }, fetch, FormData, Uint8Array, TextDecoder });
  vm.runInContext(apiSource, context); return context;
}

test("real HTTP rejects stale page credentials before authorization, then the same click executes once with a fresh handshake", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-token-http-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed: unknown[] = []; let reads = 0;
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), port: 0, accountManager: { allowSender(account: string, actor: string) { allowed.push([account, actor]); } } as never });
  t.after(() => server.close());
  const url = "/api/accounts/channel/senders/person-only/allow";
  const denied = await fetch(server.url + url, { method: "POST", headers: { Origin: server.url, "X-Codex-IM-Gateway-Token": old } });
  assert.equal(denied.status, 403); const error = await denied.json() as any;
  assert.equal(error.code, "request-token-invalid"); assert.equal(error.submission, "not-submitted"); assert.deepEqual(allowed, []);
  const ui = browser((async (input, init) => { if (input === "/api/request-context") reads++;
    return fetch(server.url + input, { ...init, headers: { ...init?.headers, Origin: server.url } }); }) as typeof fetch);
  const result = await ui.api(url, { method: "POST" }); assert.equal(result.ok, true); assert.equal(reads, 1);
  assert.deepEqual(allowed, [["channel", "person-only"]]); assert.equal(ui.state.requestToken, server.requestToken);
  const evil = await fetch(server.url + "/api/request-context", { headers: { Origin: "https://evil.invalid" } }); assert.equal(evil.status, 403);
  const context = await fetch(server.url + "/api/request-context"); assert.equal(context.headers.get("cache-control"), "no-store");
});

test("parallel stale clicks share one credential refresh and retain their distinct targets", async () => {
  let reads = 0; const posts: string[] = [], headers: string[] = [];
  const ui = browser((async (url, init) => {
    if (url === "/api/request-context") { reads++; await new Promise(resolve => setImmediate(resolve)); return Response.json({ requestToken: fresh }); }
    const token = (init?.headers as any)["X-Codex-IM-Gateway-Token"];
    if (token === old) return rejection();
    posts.push(String(url)); headers.push(token); return Response.json({ ok: true });
  }) as typeof fetch);
  await Promise.all([ui.api("/allow/alice", { method: "POST" }), ui.api("/allow/bob", { method: "POST" })]);
  assert.equal(reads, 1); assert.deepEqual(posts.sort(), ["/allow/alice", "/allow/bob"]); assert.deepEqual(headers, [fresh, fresh]);
});

for (const kind of ["network", "other-403", "server-500", "second-rejection", "refresh-failed"] as const) test(`credential recovery never replays an ambiguous or unauthorized operation: ${kind}`, async () => {
  let posts = 0, reads = 0;
  const ui = browser((async url => {
    if (url === "/api/request-context") { reads++; if (kind === "refresh-failed") throw Error("offline"); return Response.json({ requestToken: fresh }); }
    posts++;
    if (kind === "network") throw Error("response lost");
    if (kind === "other-403") return Response.json({ error: "Forbidden" }, { status: 403 });
    if (kind === "server-500") return Response.json({ error: "Failed after write" }, { status: 500 });
    return rejection();
  }) as typeof fetch);
  await assert.rejects(ui.api("/allow/alice", { method: "POST" }));
  assert.equal(posts, kind === "second-rejection" ? 2 : 1);
  assert.equal(reads, ["second-rejection", "refresh-failed"].includes(kind) ? 1 : 0);
});

test("stream recovery preserves the exact FormData instance and source request ID", async () => {
  const body = new FormData(); body.append("text", "synthetic task"); body.append("requestId", "source-identity");
  let posts = 0; const ui = browser((async (url, init) => {
    if (url === "/api/request-context") return Response.json({ requestToken: fresh });
    assert.equal(init?.body, body); posts++; if (posts === 1) return rejection();
    assert.equal((init?.body as FormData).get("requestId"), "source-identity");
    return new Response('{"type":"done","result":{"ok":true}}\n', { headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch);
  assert.equal((await ui.streamApi("/messages", { method: "POST", body }, () => {})).ok, true); assert.equal(posts, 2);
});
