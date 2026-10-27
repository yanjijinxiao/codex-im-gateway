import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test, { type TestContext } from "node:test";
import { sessionExecutionScope } from "../src/bridge/session-execution.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths, accountStatePaths } from "../src/state/paths.js";
import { IDEAuthorization } from "../src/ide/authorization.js";
import { workspaceAuthorizationScope, legacyWorkspaceScope } from "../src/ide/workspace-scope.js";
import { TaskboardLifecycle } from "../src/taskboard/lifecycle.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { presentAssistantText } from "../src/channels/assistant-presentation.js";
import { parseActionBlocks } from "../src/bridge/actions.js";
import { normalizeDingTalkCardContent, dingTalkPlainText } from "../src/channels/dingtalk-markdown.js";
import { userFacingMessageHandlingError } from "../src/bridge/errors.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
// @ts-ignore Standalone release script.
import { grantFingerprint } from "../scripts/release-local.mjs";

function directory(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-boundaries3-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test("execution scope ignores human activity but rejects reset, switch-away/back and detach/rebind ABA", t => {
  const root = directory(t), store = new RuntimeStateStore(accountStatePaths(resolveStatePaths(root), "a"));
  const session = store.createSession("chat", root, "Original"); store.setSessionThread(session.id, "thread");
  let lease = sessionExecutionScope(store, store.getSession(session.id)!);
  store.recordBindingHumanActivity("chat"); assert.equal(lease.current(), true);
  store.activateSession(session.id); assert.equal(lease.current(), true);
  store.resetSession(session.id); store.setSessionThread(session.id, "thread"); assert.equal(lease.current(), false);
  lease = sessionExecutionScope(store, store.getSession(session.id)!);
  store.createSession("chat", root, "Other"); store.activateSession(session.id); assert.equal(lease.current(), false);
  lease = sessionExecutionScope(store, store.getSession(session.id)!);
  store.detachSessionSelection("chat"); store.activateSession(session.id); assert.equal(lease.current(), false);
  lease = sessionExecutionScope(store, store.getSession(session.id)!);
  assert.equal(lease.acceptThread("replacement"), true); assert.equal(lease.current(), true);
  store.recordBindingHumanActivity("chat"); assert.equal(lease.current(), true);
});

test("legacy browser grants migrate additively, retain exact credentials and scope, and fail closed for expansion/revocation", t => {
  const root = directory(t), file = path.join(root, "auth.json");
  let target = { owner: "owner", sessionId: "alias", hostId: "local", projectId: "p", projectName: "Original", workspace: "/work", rootPaths: ["/work", "/other"] };
  const subject = { principal: { accountId: "a", channel: "dingtalk" as const, providerId: "bot", actorId: "alice" }, basis: "im-personal" as const, epoch: 0 };
  let allowed = true;
  const old = new IDEAuthorization(Date.now, file, "origin", () => allowed), legacy = legacyWorkspaceScope(target);
  const request = old.request("entry", undefined, legacy); old.approve(request.request.id, "entry", legacy, true, "/work", target.rootPaths, subject);
  const browser = old.exchangeRequest(request.request.id, request.proof, "entry", legacy)!;
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  const current = () => workspaceAuthorizationScope(target);
  const create = () => new IDEAuthorization(Date.now, file, "origin", () => allowed, () => ({ current: current(), legacy: legacyWorkspaceScope(target) }));
  let auth = create(); const migrated = auth.authenticate(browser.token, "entry", current())!; assert.ok(migrated);
  assert.deepEqual({ ...migrated, securityScope: undefined }, { ...browser.session, securityScope: undefined });
  assert.equal(grantFingerprint(before.sessions[0]), grantFingerprint(JSON.parse(fs.readFileSync(file, "utf8")).sessions[0]));
  target = { ...target, projectName: "Renamed", sessionId: "another-alias", rootPaths: ["/other", "/work"] };
  auth = create(); assert.ok(auth.authenticate(browser.token, "entry", current()));
  target = { ...target, rootPaths: ["/work", "/other", "/extra"] };
  assert.equal(auth.authenticate(browser.token, "entry", current()), undefined);
  target = { ...target, rootPaths: ["/work", "/other"] }; allowed = false;
  assert.equal(auth.authenticate(browser.token, "entry", current()), undefined); assert.equal(auth.active(migrated), false);
  for (const field of ["scope", "csrf", "expiresAt", "subject", "trustedDirectory", "trustedRootPaths"]) {
    const changed = structuredClone(before.sessions[0]); changed.session[field] = null;
    assert.notEqual(grantFingerprint(changed), grantFingerprint(before.sessions[0]), field);
  }
  assert.throws(() => grantFingerprint({ ...before.sessions[0], session: { ...before.sessions[0].session, securityScope: "invalid" } }));
});

test("unverifiable legacy grants are not upgraded or renewed", t => {
  const file = path.join(directory(t), "auth.json"), auth = new IDEAuthorization(Date.now, file, "origin");
  const browser = auth.consume(auth.grant("entry", "old-unverifiable-scope"), "entry", "old-unverifiable-scope")!;
  const before = fs.readFileSync(file, "utf8");
  const restarted = new IDEAuthorization(Date.now, file, "origin", () => true, () => ({ current: "v2:" + "a".repeat(64), legacy: "different" }));
  assert.equal(restarted.authenticate(browser.token, "entry", "v2:" + "a".repeat(64)), undefined);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("Taskboard start failure preserves a different-port service and restores a same-port service", async () => {
  let calls = 0, closes = 0; const starts: number[] = [];
  const lifecycle = new TaskboardLifecycle("/tmp/unused", async options => {
    calls++; starts.push(options.port);
    if (calls === 2 || calls === 3) throw Error("start failed");
    return { url: "http://127.0.0.1:" + options.port, async close() { closes++; } };
  });
  const config = { taskboardEnabled: true, taskboardUrl: "http://127.0.0.1:4876", codexBin: "codex" };
  await lifecycle.apply(config);
  await assert.rejects(lifecycle.apply({ ...config, taskboardUrl: "http://127.0.0.1:4877" }), /start failed/); assert.equal(closes, 0);
  await assert.rejects(lifecycle.apply({ ...config, codexBin: "other-codex" }), /start failed/);
  assert.equal(closes, 1); assert.deepEqual(starts, [4876, 4877, 4876, 4876]);
  await lifecycle.apply(config); assert.equal(calls, 4, "old launch identity remains usable after rollback");
  await lifecycle.close(); assert.equal(closes, 2);
});

test("native write guard survives a real app-server initialization wait", { timeout: 5000 }, async t => {
  const root = directory(t), marker = path.join(root, "entered"), release = path.join(root, "release"), trace = path.join(root, "trace");
  const fixture = path.join(root, "server.mjs");
  fs.writeFileSync(fixture, `import fs from 'node:fs'; import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', async line=>{const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(trace)},m.method+'\\n');
if(m.method==='initialize'){fs.writeFileSync(${JSON.stringify(marker)},'1');const wait=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return; clearInterval(wait);process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');},5);}
});`);
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 1000, transport: { command: process.execPath, args: [fixture] } });
  t.after(() => runner.close()); let allowed = true;
  const pending = runner.run({ prompt: "never execute", cwd: root, assertCurrent() { if (!allowed) throw Error("revoked"); } });
  const rejected = assert.rejects(pending, /revoked/);
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(fs.existsSync(marker)); allowed = false; fs.writeFileSync(release, "1"); await rejected;
  assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n").filter(x => x !== "initialized"), ["initialize"]);
  await runner.close();
});

const web = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
const streamSource = web.slice(web.indexOf("async function streamApi("), web.indexOf("\nfunction emptyState("));
for (const scenario of ["truncated", "malformed", "no-body", "invalid-json", "done"] as const) test(`Web receipt state for ${scenario} responses`, async () => {
  let reads = 0;
  const context: any = { state: {}, TextDecoder, Uint8Array, async fetch() {
    if (scenario === "invalid-json") return { ok: true, headers: { get: () => "text/html" }, json: async () => { throw Error("bad json"); } };
    return { ok: true, status: 200, headers: { get: () => "application/x-ndjson" }, body: scenario === "no-body" ? null : { getReader: () => ({ async read() {
      if (reads++) throw Error("must not wait after terminal receipt");
      const text = scenario === "malformed" ? "{broken\n" : scenario === "done" ? '{"type":"done","result":{"ok":true}}\n' : '{"type":"progress","message":"working"}\n';
      return { done: scenario !== "done", value: new TextEncoder().encode(text) };
    } }) } };
  } };
  vm.createContext(context); vm.runInContext(streamSource, context);
  if (scenario === "done") assert.equal((await context.streamApi("/messages", {}, () => {})).ok, true);
  else await assert.rejects(context.streamApi("/messages", {}, () => {}), (error: any) => error.submission === "unconfirmed");
});

test("review presentation protects literal code, escaped quotes and braces; inert findings reach card and plain text", () => {
  const body = 'Check `Map<String, String>` and {braces}, "quotes".';
  const directive = '::code-comment{title="[P1] finding" body=' + JSON.stringify(body) + ' file="/very/long/project/src/Source.java" start=12 end=13 priority=1}';
  for (const literal of ['\n```text\n'+directive+'\n\n\n\n```\n', '> '+directive, '`'+directive+'`']) assert.equal(presentAssistantText(literal), literal);
  const projected = presentAssistantText("Review\n\n" + directive + "\n" + directive);
  assert.equal(projected.includes("::code-comment{"), false); assert.equal(projected.match(/\[P1\] finding/g)?.length, 1);
  assert.ok(projected.includes(body)); assert.ok(projected.includes("src/Source.java:12"));
  assert.equal(projected.includes("/very/long"), false);
  for (const render of [normalizeDingTalkCardContent, dingTalkPlainText]) {
    const text = render(projected); assert.ok(text.includes("finding")); assert.ok(text.includes("braces")); assert.ok(!text.includes("::code-comment{"));
  }
  const malformed = presentAssistantText('::code-comment{title="unterminated\nKeep this following paragraph.');
  assert.ok(malformed.includes("格式不完整")); assert.ok(malformed.includes("Keep this following paragraph."));
  const code = '```ts\nconst x = "[source](/work/source.ts)";\n```'; assert.equal(parseActionBlocks(code).visibleText, code);
  assert.deepEqual(parseActionBlocks(directive).actions, { send: [], control: [], remember: [] });
});

test("preflight timeout names the failed read without suggesting successful queueing or adding a large optional command block", () => {
  const text = userFacingMessageHandlingError(new CodexCommunicationError("preflight", "thread/read", "thread", undefined, Error("timed out")));
  assert.match(text, /状态读取超时/); assert.match(text, /未提交、未入队/); assert.ok(!text.includes("```"));
});
