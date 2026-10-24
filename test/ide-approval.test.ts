import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { IDEApprovalService, type IDEApprovalRequest, type IDEApprover } from "../src/ide/approval-service.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { parseChannelActionValue } from "../src/channels/action-card.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import { startLocalHttpServer } from "../src/server/http-server.js";

const owner: IDEApprover = { accountId: "account", channel: "dingtalk", providerId: "client", actorId: "owner" };
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync("/private/tmp/cig-approval-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1000;
  const accounts = [{ accountId: "account", channel: "dingtalk", providerId: "client" }, { accountId: "other", channel: "dingtalk", providerId: "client-other" }];
  const options = { root, accounts: () => accounts, now: () => now };
  const service = new IDEApprovalService(options);
  const requests: IDEApprovalRequest[] = [{ id: "request", entryId: "entry", code: "123456", expiresAt: now + 300_000,
    accountId: "account", hostId: "remote:test", projectName: "project", workspace: "/exact/project", scope: "scope", approved: false }];
  const decisions: unknown[] = [];
  service.attach({ pendingAccess: () => requests.filter(r => !r.approved),
    approveAccess: async (id, entryId, trust, guard) => { guard?.(); const r = requests.find(r => r.id === id)!; r.approved = true; decisions.push({ id, entryId, trust }); },
    rejectAccess: (id, entryId) => { decisions.push({ id, entryId, deny: true }); requests.splice(requests.findIndex(r => r.id === id), 1); } });
  return { root, service, accounts, options, requests, decisions, tick: (ms: number) => now += ms };
}

test("IDE approvers persist independently of chat ACL, bind provider/account/actor, and fail closed on corruption", t => {
  const f = fixture(t);
  assert.throws(() => f.service.preview(owner, "123456"), /不是 IDE/);
  f.service.setOwner(owner);
  assert.deepEqual(new IDEApprovalService(f.options).list(), [owner]);
  assert.equal(fs.statSync(path.join(f.root, "ide/approvers.json")).mode & 0o777, 0o600);
  assert.throws(() => f.service.preview({ ...owner, actorId: "room" }, "123456"), /不是 IDE/);
  assert.throws(() => f.service.preview({ ...owner, accountId: "other" }, "123456"), /不是 IDE/);
  f.accounts[0].providerId = "replaced-bot";
  assert.throws(() => f.service.preview(owner, "123456"), /不是 IDE/);
  assert.throws(() => f.service.principal("account", "dingtalk", "owner", "client"), /已改变/);
  assert.throws(() => f.service.preview(f.service.principal("account", "dingtalk", "owner", "replaced-bot"), "123456"), /不是 IDE/);
  const file = path.join(f.root, "ide/approvers.json"); fs.writeFileSync(file, "malformed");
  const broken = new IDEApprovalService(f.options); assert.match(broken.error!, /未覆盖/);
  assert.throws(() => broken.setOwner(owner), /未覆盖/); assert.equal(fs.readFileSync(file, "utf8"), "malformed");
});

test("confirmation binds exact actor, account, request snapshot and original expiry; duplicates do not grant twice", async t => {
  const f = fixture(t); f.service.setOwner(owner); f.service.setOwner({ ...owner, actorId: "second" });
  const first = f.service.preview(owner, "123456");
  await assert.rejects(f.service.decide({ ...owner, actorId: "second" }, first.token, "trust"), /不属于/);
  f.requests[0].workspace = "/changed/project";
  await assert.rejects(f.service.decide(owner, first.token, "trust"), /已改变/); assert.deepEqual(f.decisions, []);
  const next = f.service.preview(owner, "123456");
  await f.service.decide(owner, next.token, "access");
  await assert.rejects(f.service.decide(owner, next.token, "trust"), /已失效/);
  assert.deepEqual(f.decisions, [{ id: "request", entryId: "entry", trust: false }]);
});

test("expired, ambiguous or other-account pairing codes and guessing never approve", t => {
  const f = fixture(t); f.service.setOwner(owner);
  f.requests.push({ ...f.requests[0], id: "collision" });
  assert.throws(() => f.service.preview(owner, "123456"), /唯一/); f.requests.pop();
  f.requests[0].accountId = "other"; assert.throws(() => f.service.preview(owner, "123456"), /唯一/);
  f.requests[0].accountId = "account";
  for (let i = 0; i < 8; i++) assert.throws(() => f.service.preview(owner, "999999"), /唯一/);
  assert.throws(() => f.service.preview(owner, "123456"), /过于频繁/);
  f.tick(60_001); const valid = f.service.preview(owner, "123456"); assert.ok(valid.token);
  f.tick(300_000); assert.throws(() => f.service.preview(owner, "123456"), /唯一/); assert.deepEqual(f.decisions, []);
});

test("owner removal, endpoint detach, native changes and concurrent confirmation are rechecked after async trust lookup", async t => {
  const f = fixture(t); f.service.setOwner(owner);
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => release = resolve);
  f.service.attach({ pendingAccess: () => f.requests,
    approveAccess: async (_id, _entry, _trust, guard) => { await gate; guard?.(); calls++; }, rejectAccess() {} });
  const preview = f.service.preview(owner, "123456"), pending = f.service.decide(owner, preview.token, "trust");
  await assert.rejects(f.service.decide(owner, preview.token, "trust"), /正在处理/);
  f.service.setOwner(owner, true); release(); await assert.rejects(pending, /不是 IDE/); assert.equal(calls, 0);
  f.service.setOwner(owner); const next = f.service.preview(owner, "123456");
  f.requests[0].scope = "new-native-thread";
  await assert.rejects(f.service.decide(owner, next.token, "trust"), /已改变/);
  const third = f.service.preview(owner, "123456");
  const detach = f.service.attach({ pendingAccess: () => f.requests, async approveAccess() {}, rejectAccess() {} }); detach();
  await assert.rejects(f.service.decide(owner, third.token, "access"), /未就绪/);
});

test("deny consumes the request; local web and private IM use the same approval port without issuing a credential to IM", async t => {
  const f = fixture(t); f.service.setOwner(owner);
  const denied = f.service.preview(owner, "123456"); await f.service.decide(owner, denied.token, "deny");
  assert.equal(f.requests.length, 0); assert.equal(JSON.stringify(denied).includes("proof"), false);
  f.requests.push({ ...denied.request, id: "local-request" });
  await f.service.approveLocal("local-request", "entry", true);
  assert.deepEqual(f.decisions.at(-1), { id: "local-request", entryId: "entry", trust: true });
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, "ide/approvers.json"), "utf8"), /123456|expiresAt|scope/);
});

function bridgeFixture(t: test.TestContext, f: ReturnType<typeof fixture>, actions = true) {
  const texts: string[] = [], cards: any[] = [], mutations: string[] = [];
  const store = new RuntimeStateStore(resolveStatePaths(path.join(f.root, "bridge")));
  const channel = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, ...(actions ? { actions: "available" as const } : {}) }, {
    async sendText(input) { texts.push(input.text); return { messageId: "text" }; },
    async sendActionCard(input) { cards.push(input.card); return { messageId: "card" }; }
  });
  const bridge = new BridgeService({ accountId: "account", ideProviderId: "client", ideApprovals: f.service, stateStore: store,
    config: { ...defaultConfig(f.root), allowedSenderIds: ["group"] }, channel,
    runner: { async run() { mutations.push("run"); }, async steer() { mutations.push("steer"); }, async addQueuedSubmission() { mutations.push("queue"); } } as never });
  t.after(() => bridge.suspendUserInputs());
  let id = 0;
  const send = (text: string, actor = "owner", conversationKind: "direct" | "group" | undefined = "direct", target = "dm-conversation") => bridge.handleMessage({
    id: String(++id), senderId: actor, replyTargetId: target, conversationKind, text, attachments: [], raw: {} });
  return { bridge, store, texts, cards, mutations, send };
}

test("unbound private approval uses original human and provider DM metadata before generic ACL, never run/steer/queue or binding", async t => {
  const f = fixture(t), b = bridgeFixture(t, f); f.service.setOwner(owner);
  const before = JSON.stringify(b.store.snapshot);
  await b.send("/ide auth 123456"); assert.equal(b.cards.length, 1);
  assert.match(b.cards[0].fallbackText, /精确|exact\/project/);
  assert.equal([...b.cards[0].fallbackText.matchAll(/```text\n\/ide (trust|access|deny) [a-f0-9]{12}\n```/g)].length,3,"short commands keep the permission choice visible before the identifier");
  const action = b.cards[0].actionGroups[0][0].value;
  assert.ok(parseChannelActionValue(action)); assert.equal(action.command, "ide");
  await b.send(`/ide ${action.arg}`); assert.match(b.texts.at(-1)!, /15 天/);
  assert.deepEqual(f.decisions, [{ id: "request", entryId: "entry", trust: true }]);
  assert.deepEqual(b.mutations, []); assert.equal(JSON.stringify(b.store.snapshot), before);
});

test("short confirmation aliases are owner-bound, bounded, fresh per preview and consumed with the long token", async t => {
  const f=fixture(t); f.service.setOwner(owner); f.service.setOwner({...owner,actorId:"second"});
  const first=f.service.preview(owner,"123456");assert.match(first.shortCode,/^[a-f0-9]{12}$/);
  assert.equal(f.service.copyPreview(first.token)?.shortCode,first.shortCode);
  assert.equal(f.service.copyPreview(first.shortCode),undefined,"short commands cannot enumerate copy panels");
  await assert.rejects(f.service.decide({...owner,actorId:"second"},first.shortCode,"trust"),/已失效/);
  const second=f.service.preview(owner,"123456");assert.notEqual(first.shortCode,second.shortCode);
  assert.equal(f.service.copyPreview(first.token),undefined);
  await assert.rejects(f.service.decide(owner,first.shortCode,"trust"),/已失效/);
  await f.service.decide(owner,second.shortCode,"access");
  assert.equal(f.service.copyPreview(second.token),undefined);
  await assert.rejects(f.service.decide(owner,second.token,"trust"),/已失效/);
  assert.deepEqual(f.decisions,[{id:"request",entryId:"entry",trust:false}]);
});

test("DingTalk's text-only choice fallback sends one labelled copy-panel link and usable short commands, not fake native buttons", async t => {
  const f=fixture(t),b=bridgeFixture(t,f,false);f.service.setOwner(owner);
  f.requests[0].url="https://203.0.113.10:20015/workspace/"+"a".repeat(32);
  await b.send("/ide auth 123456");assert.equal(b.cards.length,0);assert.equal(b.texts.length,1);
  const reply=b.texts[0];assert.match(reply,/\[打开确认复制面板\]\(https:\/\/203\.0\.113\.10:20015\/approval\/[a-f0-9]{32}\)/);
  assert.doesNotMatch(reply,/\/ide confirm|点击.*批准/);
  const commands=[...reply.matchAll(/```text\n(\/ide (trust|access|deny) [a-f0-9]{12})\n```/g)];
  assert.equal(commands.length,3);assert.ok(commands.every(c=>c[1].length<=24));
  await b.send(commands.find(c=>c[2]==="access")![1]);
  assert.deepEqual(f.decisions,[{id:"request",entryId:"entry",trust:false}]);assert.deepEqual(b.mutations,[]);
});

test("copy panels expire on owner, provider, request, port or clock changes and never execute a decision", t => {
  const f=fixture(t);f.service.setOwner(owner);
  const first=f.service.preview(owner,"123456");
  const copy=f.service.copyPreview(first.token)!;copy.request.workspace="/forged";
  assert.equal(f.service.copyPreview(first.token)?.request.workspace,"/exact/project");
  f.requests[0].workspace="/changed";assert.equal(f.service.copyPreview(first.token),undefined);
  const second=f.service.preview(owner,"123456");
  f.accounts[0].providerId="changed";assert.equal(f.service.copyPreview(second.token),undefined);f.accounts[0].providerId="client";
  f.tick(300_000);assert.equal(f.service.copyPreview(second.token),undefined);
  assert.deepEqual(f.decisions,[]);
  assert.equal(new IDEApprovalService(f.options).copyPreview(first.token),undefined,"restart cannot revive a pending confirmation");
});

test("short confirmation guessing has a per-principal limit; invalid choices cannot grant", async t => {
  const f=fixture(t);f.service.setOwner(owner);const preview=f.service.preview(owner,"123456");
  await assert.rejects(f.service.decide(owner,preview.shortCode,"invalid" as never),/无效/);
  for(let i=0;i<20;i++)await assert.rejects(f.service.decide(owner,"not-a-token","trust"),/已失效/);
  await assert.rejects(f.service.decide(owner,preview.shortCode,"trust"),/过于频繁/);
  assert.deepEqual(f.decisions,[]);f.tick(60_001);await f.service.decide(owner,preview.shortCode,"deny");
  assert.deepEqual(f.decisions,[{id:"request",entryId:"entry",deny:true}]);
});

test("group ACL, same-ID groups, unknown context, another human and unregistered DMs cannot approve or see project metadata", async t => {
  const f = fixture(t), b = bridgeFixture(t, f); f.service.setOwner(owner);
  await b.send("/ide auth 123456", "owner", "group", "group"); assert.match(b.texts.at(-1)!, /仅支持/);
  await b.send("/ide identity", "group", "group", "group"); assert.match(b.texts.at(-1)!, /仅支持/);
  await b.bridge.handleMessage({ id: "unknown", senderId: "owner", text: "/ide auth 123456", attachments: [], raw: {} });
  assert.match(b.texts.at(-1)!, /仅支持/);
  await b.send("/ide auth 123456", "stranger"); assert.match(b.texts.at(-1)!, /不是 IDE/);
  assert.equal(b.cards.length, 0); assert.doesNotMatch(b.texts.join(""), /exact\/project/); assert.deepEqual(f.decisions, []);
  await b.send("/ide identity", "stranger"); assert.match(b.texts.at(-1)!, /```text\nstranger\n```/); assert.deepEqual(f.service.list(), [owner]);
});

test("preview and confirmation both require explicit commands; quoted commands never bypass normal ACL", async t => {
  const f = fixture(t), b = bridgeFixture(t, f); f.service.setOwner(owner);
  await b.send("/ide auth 123456 extra"); assert.match(b.texts.at(-1)!, /用法/);
  await b.bridge.handleMessage({ id: "quoted", senderId: "owner", replyTargetId: "dm", conversationKind: "direct", text: "看看引用", attachments: [],
    references: [{ type: "text", text: "/ide auth 123456", attachments: [], availability: "available" }], raw: {} });
  assert.equal(b.cards.length, 0); assert.deepEqual(f.decisions, []); assert.deepEqual(b.mutations, []);
});

test("a still-running old bot connection cannot borrow a replacement bot's registered owner identity", async t => {
  const f = fixture(t), b = bridgeFixture(t, f);
  f.accounts[0].providerId = "replacement-bot";
  f.service.setOwner({ ...owner, providerId: "replacement-bot" });
  await b.send("/ide auth 123456"); assert.match(b.texts.at(-1)!, /账号已改变/);
  assert.equal(b.cards.length, 0); assert.deepEqual(f.decisions, []);
});

test("identity reports the caller's actual persisted registration without registering, granting, or repeating first-time instructions", async t => {
  const f=fixture(t),b=bridgeFixture(t,f);
  await b.send("/ide identity");assert.match(b.texts.at(-1)!,/当前个人身份未登记/);assert.deepEqual(f.service.list(),[]);
  f.service.setOwner(owner);
  await b.send("/ide identity");assert.match(b.texts.at(-1)!,/已登记为 IDE 审批管理员/);assert.doesNotMatch(b.texts.at(-1)!,/首次请|当前个人身份未登记/);
  assert.match(b.texts.at(-1)!,/新浏览器仍需/);assert.equal(new IDEApprovalService(f.options).registrationStatus(owner),"registered");
  assert.equal(f.service.registrationStatus({...owner,actorId:"stranger"}),"unregistered");
  assert.equal(f.service.registrationStatus({...owner,providerId:"other-bot"}),"unavailable");
  f.service.error="unreadable";
  await b.send("/ide identity");assert.match(b.texts.at(-1)!,/暂时无法核验/);assert.doesNotMatch(b.texts.at(-1)!,/审批资格：当前个人身份未登记/);
  assert.deepEqual(f.decisions,[]);assert.deepEqual(b.mutations,[]);
});

async function freePort() {
  const s = net.createServer(); await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port; await new Promise<void>(r => s.close(() => r())); return port;
}
test("real HTTP browser pairing + token-protected owner setup + private IM confirmation persists browser access across restart", async t => {
  const fetch = (input: string, init: RequestInit = {}) => globalThis.fetch(input, { ...init, headers: { Connection: "close", ...init.headers } });
  const f = fixture(t), b = bridgeFixture(t, f), port = await freePort();
  // Real wall clock, because IDE browser authorization is independently clocked.
  const approvals = new IDEApprovalService({ root: f.root, accounts: f.options.accounts });
  const ide = new WorkspaceIDEManager({ root: f.root, resolve: (_account, sessionId) => ({ owner: "owner", sessionId,
    hostId: "local", projectName: "real-browser <script>globalThis.bad=1</script>", workspace: f.root }), transport: { canonicalDirectory: async () => f.root,
      async launch() { throw new Error("pairing does not launch a task or editor"); } } });
  ide.configStore.save({ ...ide.config(), enabled: true, port, publicOrigin: `http://127.0.0.1:${port}`, hosts: [{ hostId: "local", enabled: true, binary: "code-server" }] });
  const manager = { ide, ideApprovals: approvals, listProjects: () => [] } as never;
  let http = await startLocalHttpServer({ paths: resolveStatePaths(f.root), port: 0, accountManager: manager });
  t.after(() => http.close()); const entry = ide.entry("account", "session")!;
  const copyJS=await fetch(http.url+"/copyable.js"),copyCSS=await fetch(http.url+"/copyable.css");
  assert.equal(copyJS.status,200);assert.match(copyJS.headers.get("content-type")!,/javascript/);assert.match(await copyJS.text(),/window\.gatewayCopy/);
  assert.equal(copyCSS.status,200);assert.match(copyCSS.headers.get("content-type")!,/text\/css/);assert.match(await copyCSS.text(),/\.gateway-copy/);
  const initial = await fetch(entry.url + "?auth_check=1"), page = await initial.text(), proofCookie = initial.headers.get("set-cookie")!.split(";")[0];
  const code = page.match(/<textarea[^>]*>(\d{6})<\/textarea>/)![1];
  const body = JSON.stringify({ principal: owner });
  assert.equal((await fetch(http.url + "/api/ide/approvers", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403);
  const headers = { "Content-Type": "application/json", "x-codex-im-gateway-token": http.requestToken, Origin: http.url };
  assert.equal((await fetch(http.url + "/api/ide/approvers", { method: "POST", headers: { ...headers, Origin: "https://foreign.test" }, body })).status, 403);
  assert.equal((await fetch(http.url + "/api/ide/approvers", { method: "POST", headers, body })).status, 200);
  // Run the same real bridge with the authority attached to the HTTP endpoints.
  const unitDetach = f.service.attach({ pendingAccess: () => [], async approveAccess() {}, rejectAccess() {} }); unitDetach();
  const { ideApprovalCommand } = await import("../src/bridge/ide-approval.js");
  const message = { id: "private", senderId: "owner", replyTargetId: "different-dm-id", conversationKind: "direct" as const, text: "", attachments: [], raw: {} };
  const card = await ideApprovalCommand({ service: approvals, accountId: "account", providerId: "client", channel: "dingtalk", message, arg: `auth ${code}` });
  assert.notEqual(typeof card, "string"); if (typeof card === "string") throw new Error(card);
  const panelURL=card.fallbackText.match(/\[打开确认复制面板\]\(([^)]+)\)/)![1];
  assert.equal(new URL(panelURL).origin,new URL(entry.url).origin,"copy panel uses the exact originating browser entrance");
  const panel=await fetch(panelURL),panelHTML=await panel.text();
  assert.equal(panel.status,200);assert.equal(panel.headers.get("set-cookie"),null);
  assert.equal(panel.headers.get("referrer-policy"),"no-referrer");assert.equal(panel.headers.get("cache-control"),"no-store");
  const markup=panelHTML.split('<script nonce=')[0];
  assert.equal((markup.match(/<button[^>]*data-copy-button/g)||[]).length,3);
  assert.match(markup,/&lt;script&gt;globalThis.bad=1&lt;\/script&gt;/);assert.doesNotMatch(markup,/<script>globalThis.bad/);
  assert.match(markup,/只复制，不批准浏览器/);assert.match(markup,/rows="2"/);assert.doesNotMatch(markup,/<form|data-ide-wait/);
  for(const choice of ["trust","access","deny"])assert.match(markup,new RegExp(`/ide ${choice} [a-f0-9]{12}`));
  assert.equal((await fetch(panelURL,{method:"POST",headers:{Origin:new URL(entry.url).origin},body:"choice=trust"})).status,405);
  assert.equal((await fetch(panelURL,{method:"HEAD"})).status,405);
  assert.equal((await fetch(panelURL.replace(/[^/]+$/,"0".repeat(32)))).status,410);
  const beforeDecision=await fetch(entry.url + "?auth_check=1",{headers:{Cookie:proofCookie},redirect:"manual"});
  assert.equal(beforeDecision.status,200);assert.match(await beforeDecision.text(),/等待 Gateway/);
  const confirmation = await ideApprovalCommand({ service: approvals, accountId: "account", providerId: "client", channel: "dingtalk", message, arg: card.actionGroups[0][0].value.arg });
  assert.match(String(confirmation), /已批准/);
  const expiredPanel=await fetch(panelURL);assert.equal(expiredPanel.status,410);assert.doesNotMatch((await expiredPanel.text()).split('<script nonce=')[0],/\/ide trust [a-f0-9]{12}/);
  const copied = await fetch(entry.url + "?auth_check=1", { redirect: "manual" }); assert.equal(copied.status, 200); assert.match(await copied.text(), /等待 Gateway/);
  const exchange = await fetch(entry.url + "?auth_check=1", { headers: { Cookie: proofCookie }, redirect: "manual" }); assert.equal(exchange.status, 303);
  const sessionCookie = exchange.headers.get("set-cookie")!.split(";")[0];
  const authorized = await fetch(entry.url + "?auth_check=1", { headers: { Cookie: sessionCookie } }); assert.match(await authorized.text(), /已授权并信任当前目录/);
  await http.close();
  http = await startLocalHttpServer({ paths: resolveStatePaths(f.root), port: 0, accountManager: manager });
  const restored = await fetch(entry.url + "?auth_check=1", { headers: { Cookie: sessionCookie } }); assert.match(await restored.text(), /已授权并信任当前目录/);
  assert.deepEqual(new IDEApprovalService({ root: f.root, accounts: f.options.accounts }).list(), [owner]); assert.deepEqual(b.mutations, []);
});

for (const choice of ["trust", "access", "deny"] as const) test(`single-command ${choice} uses a stable browser snapshot and requires a registered owner, not a pairing code`, async t => {
  const f=fixture(t);f.service.setOwner(owner);
  const offered=f.service.offer("request","entry")!;
  assert.match(offered.shortCode,/^[a-f0-9]{12}$/);assert.deepEqual(f.service.offer("request","entry"),offered);
  assert.equal(JSON.stringify(offered).includes("proof"),false);assert.deepEqual(f.decisions,[]);
  await assert.rejects(f.service.decide({...owner,actorId:"stranger"},offered.shortCode,choice),/不是 IDE/);
  await assert.rejects(f.service.decide(owner,"123456",choice),/已失效/);
  await f.service.decide(owner,offered.shortCode,choice);
  assert.deepEqual(f.decisions,[choice==="deny"?{id:"request",entryId:"entry",deny:true}:{id:"request",entryId:"entry",trust:choice==="trust"}]);
  await assert.rejects(f.service.decide(owner,offered.shortCode,choice),/已失效/);
  assert.equal(f.service.offer("request","entry"),undefined);
});

test("one-pass commands cannot cross accounts or silently rebind a browser snapshot during polling", async t => {
  const f=fixture(t);f.service.setOwner(owner);const other={...owner,accountId:"other",providerId:"client-other"};f.service.setOwner(other);
  const offered=f.service.offer("request","entry")!;
  offered.request.workspace="/tampered-return-value";
  assert.equal(f.service.offer("request","entry")!.request.workspace,"/exact/project");
  await assert.rejects(f.service.decide(other,offered.shortCode,"trust"),/不属于/);
  assert.equal(f.service.offer("request","wrong-entry"),undefined);
  f.requests[0].workspace="/different";
  assert.equal(f.service.offer("request","entry"),undefined,"polling must not mint a replacement for changed metadata under the same request");
  await assert.rejects(f.service.decide(owner,offered.shortCode,"trust"),/已改变/);assert.deepEqual(f.decisions,[]);
});

for (const change of ["directory", "owner", "provider", "expiry", "port"] as const) test(`one-pass async commit rechecks ${change}, rejects concurrent clicks and preserves all authority checks`, async t => {
  const f=fixture(t);f.service.setOwner(owner);let release!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>release=resolve);
  const detach=f.service.attach({pendingAccess:()=>f.requests,approveAccess:async(_id,_entry,_trust,guard)=>{await gate;guard?.();calls++;},rejectAccess(){}});
  const offered=f.service.offer("request","entry")!,pending=f.service.decide(owner,offered.shortCode,"trust");
  await assert.rejects(f.service.decide(owner,offered.shortCode,"access"),/正在处理/);
  assert.equal(f.service.offer("request","entry"),undefined,"a pending decision cannot be replaced during polling");
  if(change==="directory")f.requests[0].workspace="/changed";
  if(change==="owner")f.service.setOwner(owner,true);
  if(change==="provider")f.accounts[0].providerId="different-bot";
  if(change==="expiry")f.tick(300_001);
  if(change==="port")detach();
  release();await assert.rejects(pending,/已改变|不是 IDE/);assert.equal(calls,0);
});

test("two browser offers keep exact request IDs separate and a restart cannot revive copied commands", async t => {
  const f=fixture(t);f.service.setOwner(owner);f.requests.push({...f.requests[0],id:"second-browser"});
  const first=f.service.offer("request","entry")!,second=f.service.offer("second-browser","entry")!;
  assert.notEqual(first.shortCode,second.shortCode);
  await f.service.decide(owner,second.shortCode,"access");assert.deepEqual(f.decisions,[{id:"second-browser",entryId:"entry",trust:false}]);
  assert.equal(f.service.offer("request","entry")!.shortCode,first.shortCode);
  const restarted=new IDEApprovalService(f.options);restarted.attach({pendingAccess:()=>f.requests,async approveAccess(){throw Error("must not commit");},rejectAccess(){}});
  await assert.rejects(restarted.decide(owner,first.shortCode,"trust"),/已失效/);
});

test("a pre-registered replacement bot owner cannot reuse a browser command issued for the previous provider", async t => {
  const f=fixture(t),replacement={...owner,providerId:"replacement"};f.service.setOwner(owner);
  // Simulate a legitimate registry containing previously registered providers;
  // switching the running account must still invalidate the old offer snapshot.
  fs.writeFileSync(path.join(f.root,"ide/approvers.json"),JSON.stringify({version:1,owners:[owner,replacement]}));
  const service=new IDEApprovalService(f.options);service.attach({pendingAccess:()=>f.requests,async approveAccess(){throw Error("must not commit");},rejectAccess(){}});
  const offered=service.offer("request","entry")!;f.accounts[0].providerId="replacement";
  assert.equal(service.registrationStatus(replacement),"registered");
  assert.equal(service.offer("request","entry"),undefined);
  await assert.rejects(service.decide(replacement,offered.shortCode,"trust"),/不属于/);
});

for (const choice of ["trust", "access", "deny"] as const) test(`real HTTP + one private ${choice} command needs no auth preview, does not run Codex and only authorizes the original browser`, async t => {
  const fetch=(input:string,init:RequestInit={})=>globalThis.fetch(input,{...init,headers:{Connection:"close",...init.headers}});
  const f=fixture(t),port=await freePort();
  const approvals=new IDEApprovalService({root:f.root,accounts:f.options.accounts});approvals.setOwner(owner);
  const b=bridgeFixture(t,{...f,service:approvals},false),stateBefore=JSON.stringify(b.store.snapshot);
  const ide=new WorkspaceIDEManager({root:f.root,resolve:(_account,sessionId)=>({owner:"owner",sessionId,hostId:"local",projectName:"single <script>bad</script>",workspace:f.root}),
    transport:{canonicalDirectory:async()=>f.root,async launch(){throw Error("approval must not launch an editor");}}});
  ide.configStore.save({...ide.config(),enabled:true,port,publicOrigin:`http://127.0.0.1:${port}`,hosts:[{hostId:"local",enabled:true,binary:"code-server"}]});
  const http=await startLocalHttpServer({paths:resolveStatePaths(f.root),port:0,accountManager:{ide,ideApprovals:approvals,listProjects:()=>[]} as never});t.after(()=>http.close());
  const entry=ide.entry("account","single")!,initial=await fetch(entry.url + "?auth_check=1"),html=await initial.text(),proof=initial.headers.get("set-cookie")!.split(";")[0];
  const primary=html.split("<details")[0];assert.match(primary,/发送一次/);assert.match(primary,/不会再要求第二条/);
  assert.match(primary,/项目：/);assert.match(primary,/主机：local/);assert.match(primary,/目录：/);
  assert.match(primary,/&lt;script&gt;bad&lt;\/script&gt;/);assert.doesNotMatch(primary,/\/ide auth/);
  assert.equal((primary.match(/<button[^>]*data-copy-button/g)||[]).length,4);
  const command=new RegExp(`/ide ${choice} [a-f0-9]{12}`).exec(primary)![0];
  const reloaded=await fetch(entry.url + "?auth_check=1",{headers:{Cookie:proof}});assert.ok((await reloaded.text()).includes(command),"polling preserves the displayed command");
  assert.match(await(await fetch(entry.url + "?auth_check=1",{headers:{Cookie:proof}})).text(),/等待 Gateway/);
  assert.equal(b.cards.length,0);await b.send(command);assert.equal(b.cards.length,0,"no second confirmation card");
  assert.match(b.texts.at(-1)!,choice==="deny"?/已拒绝/:/已批准/);
  const original=await fetch(entry.url + "?auth_check=1",{headers:{Cookie:proof},redirect:"manual"});
  if(choice==="deny"){assert.equal(original.status,200);assert.match(await original.text(),/等待 Gateway/);assert.doesNotMatch(original.headers.get("set-cookie")??"",/cig_ide_/);}
  else {
    assert.equal(original.status,303);const cookie=original.headers.get("set-cookie")!.split(";")[0];
    assert.match(original.headers.get("set-cookie")!,/Max-Age=1296000/);
    const granted=await fetch(entry.url + "?auth_check=1",{headers:{Cookie:cookie}});assert.match(await granted.text(),choice==="trust"?/已授权并信任当前目录/:/本次仅批准访问/);
    assert.match(await(await fetch(entry.url + "?auth_check=1")).text(),/等待 Gateway/,"copied URL does not authenticate a different browser");
  }
  await b.send(command);assert.match(b.texts.at(-1)!,/已失效/);
  assert.deepEqual(b.mutations,[]);assert.equal(JSON.stringify(b.store.snapshot),stateBefore);
});
