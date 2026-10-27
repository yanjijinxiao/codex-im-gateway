import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdmissionService, admissionPrincipal } from "../src/bridge/admission.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { parseChannelActionValue } from "../src/channels/action-card.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import type { IDEPrincipal } from "../src/ide/access-subject.js";
import type { ChannelMessage } from "../src/channels/message.js";

const owner: IDEPrincipal = { accountId: "account", channel: "dingtalk", providerId: "robot", actorId: "owner" };
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-admission-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1_000, failGrant = false;
  const accounts = [{ accountId: "account", channel: "dingtalk", providerId: "robot" }, { accountId: "other", channel: "dingtalk", providerId: "robot2" }];
  const grants: string[][] = [], allowed = new Set<string>();
  const options = { root, accounts: () => accounts, now: () => now,
    allowed: (account: string, actor: string, conversation: string) => allowed.has(`${account}:${actor}`) || allowed.has(`${account}:${conversation}`),
    allow: (account: string, target: string) => { if (failGrant) throw Error("grant write failed"); grants.push([account, target]); allowed.add(`${account}:${target}`); } };
  const service = new AdmissionService(options);
  const enroll = () => { const r = service.observe(owner, "dm-owner", "direct"); service.setAdmin(r.id, r.version); return r; };
  const applicant = (actorId = "applicant", conversation = "room") => service.observe({ ...owner, actorId }, conversation, conversation === actorId ? "direct" : "group");
  return { root, service, options, accounts, grants, allowed, enroll, applicant, tick: (ms: number) => now += ms, fail: () => { failGrant = true; } };
}

test("only explicit local enrollment makes a verified human an admission admin; personal, room and session permissions never do", t => {
  const f = fixture(t); f.allowed.add("account:owner"); f.allowed.add("account:room");
  assert.equal(f.service.isAdmin(owner), false);
  const r = f.applicant("new-person", "other-room");
  assert.throws(() => f.service.decideRemote(owner, r.id, r.version, "actor"), /管理员/);
  f.enroll(); assert.equal(f.service.isAdmin(owner), true);
  assert.equal(new AdmissionService(f.options).isAdmin(owner), true);
  assert.equal(fs.statSync(path.join(f.root, "admission.json")).mode & 0o777, 0o600);
  f.service.decideRemote(owner, r.id, r.version, "actor");
  assert.deepEqual(f.grants, [["account", "new-person"]]);
  assert.equal(f.service.isAdmin({ ...owner, actorId: "new-person" }), false);
});

test("a decision is exact to provider, account, request, version and selected actor/group scope; stale and duplicate commands fail closed", t => {
  const f = fixture(t); f.enroll(); const r = f.applicant();
  for (const admin of [{ ...owner, accountId: "other", providerId: "robot2" }, { ...owner, actorId: "room" }])
    assert.throws(() => f.service.decideRemote(admin, r.id, r.version, "actor"), /管理员/);
  assert.throws(() => f.service.decideRemote(owner, r.id, "0".repeat(64), "actor"), /过期/);
  const other = f.service.observe({ ...owner, accountId: "other", providerId: "robot2", actorId: "x" }, "x", "direct");
  assert.throws(() => f.service.decideRemote(owner, other.id, other.version, "actor"), /跨渠道/);
  const dm = f.applicant("dm-person", "dm-person");
  assert.throws(() => f.service.decideRemote(owner, dm.id, dm.version, "conversation"), /不是.*群聊/);
  f.service.decideRemote(owner, r.id, r.version, "conversation");
  assert.deepEqual(f.grants, [["account", "room"]]); assert.equal(f.allowed.has("account:applicant"), false);
  assert.throws(() => f.service.decideRemote(owner, r.id, r.version, "actor"), /已处理/);
  assert.throws(() => new AdmissionService(f.options).decideRemote(owner, r.id, r.version, "actor"), /已处理/);
});

test("expiry, denial, revocation, provider replacement and account deletion invalidate old observations without replaying tasks", t => {
  const f = fixture(t); f.enroll(); const r = f.applicant();
  f.service.decideRemote(owner, r.id, r.version, "deny"); assert.deepEqual(f.grants, []);
  const replacement = f.applicant(); assert.notEqual(replacement.id, r.id);
  f.service.removeAdmin(owner); assert.throws(() => f.service.decideRemote(owner, replacement.id, replacement.version, "actor"), /管理员/);
  f.enroll(); f.accounts[0].providerId = "new-robot";
  assert.equal(f.service.isAdmin(owner), false); assert.equal(f.service.snapshot().requests.length, 0);
  f.accounts[0].providerId = "robot"; f.tick(24 * 60 * 60_000);
  assert.throws(() => f.service.decideRemote(owner, replacement.id, replacement.version, "actor"), /过期/);
  f.service.forgetAccount("account"); assert.equal(new AdmissionService(f.options).isAdmin(owner), false);
});

test("durable unconfirmed grants are not retried after failure/restart; corrupt state preserves evidence and disables remote decisions", t => {
  const f = fixture(t); f.enroll(); const r = f.applicant(); f.fail();
  assert.throws(() => f.service.decideRemote(owner, r.id, r.version, "actor"), /结果未确认/);
  const restarted = new AdmissionService(f.options);
  assert.equal(restarted.snapshot().requests.find(x => x.id === r.id)?.phase, "applying");
  assert.throws(() => restarted.decideRemote(owner, r.id, r.version, "actor"), /已处理/); assert.deepEqual(f.grants, []);
  const file = path.join(f.root, "admission.json"); fs.writeFileSync(file, "broken");
  const broken = new AdmissionService(f.options); assert.match(broken.error!, /未覆盖/);
  assert.deepEqual(broken.snapshot().requests, []); assert.throws(() => broken.observe(owner, "owner", "direct"), /无法读取/);
  assert.equal(fs.readFileSync(file, "utf8"), "broken");
});

test("unknown sources cannot assert personal identity and observation is bounded/deduplicated without extending the expiry", t => {
  const f = fixture(t); const message: ChannelMessage = { id: "1", senderId: "person", replyTargetId: "room", text: "/access", attachments: [], raw: {} };
  assert.equal(admissionPrincipal("account", "robot", "dingtalk", message), undefined);
  assert.equal(admissionPrincipal("account", "robot", "dingtalk", { ...message, conversationKind: "group", senderId: "room" }), undefined);
  assert.equal(admissionPrincipal("account", "robot", "dingtalk", { ...message, conversationKind: "group" })?.actorId, "person");
  const r = f.applicant(); f.tick(60_000); assert.deepEqual(f.applicant(), r);
  assert.throws(() => f.service.observe({ ...owner, providerId: "forged" }, "room", "group"), /核验/);
});

test("real Bridge routes unbound IM requests/decisions before session gating, protects other members and never runs the original user task", async t => {
  const f = fixture(t), store = new RuntimeStateStore(resolveStatePaths(path.join(f.root, "bridge")));
  const texts: string[] = [], cards: any[] = [], mutations: string[] = [];
  const channel = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, actions: "available" }, {
    async sendText(input) { texts.push(input.text); return { messageId: "t" }; },
    async sendActionCard(input) { cards.push(input.card); return { messageId: "c" }; }
  });
  const bridge = new BridgeService({ accountId: "account", ideProviderId: "robot", admission: f.service, stateStore: store,
    config: { ...defaultConfig(f.root), allowedSenderIds: [] }, channel,
    runner: { async run() { mutations.push("run"); }, async steer() { mutations.push("steer"); }, async addQueuedSubmission() { mutations.push("queue"); } } as never });
  t.after(() => bridge.suspendUserInputs()); let next = 0;
  const send = (text: string, actor = "owner", kind: "group" | "direct" | undefined = "group", conversation = "room") => bridge.handleMessage({ id: String(++next), senderId: actor, replyTargetId: conversation, conversationKind: kind, text, attachments: [], raw: {} });
  await send("ordinary original task", "new-person"); assert.match(texts.at(-1)!, /申请已登记/);
  const r = f.service.snapshot().requests[0];
  await send(`/access show ${r.id}`); assert.match(texts.at(-1)!, /没有.*管理员/); assert.equal(cards.length, 0);
  await send("/access identity"); const candidate = f.service.snapshot().candidates.find(r => r.principal.actorId === "owner")!;
  f.service.setAdmin(candidate.id, candidate.version);
  await send(`/access show ${r.id}`); assert.equal(cards.length, 1);
  const action = parseChannelActionValue(cards[0].actionGroups[0][0].value)!;
  await send(`/access ${action.arg}`, "stranger"); assert.deepEqual(f.grants, []);
  await send(`/access ${action.arg}`); assert.deepEqual(f.grants, [["account", "new-person"]]);
  assert.equal(store.listSessions().length, 0); assert.deepEqual(mutations, []);
  await bridge.handleMessage({ id: String(++next), senderId: "owner", replyTargetId: "room", text: "/access", attachments: [], raw: {} }); assert.match(texts.at(-1)!, /无法核验/);
});

test("real HTTP and IM share the same ticket/ACL; stale token has no effect and local admin enrollment is mutation protected", async t => {
  const f = fixture(t); const candidate = f.service.observe(owner, "owner", "direct"), r = f.applicant();
  const server = await startLocalHttpServer({ paths: resolveStatePaths(f.root), port: 0, accountManager: { admission: f.service } as never }); t.after(() => server.close());
  const headers = { Origin: server.url, "X-Codex-IM-Gateway-Token": server.requestToken, "Content-Type": "application/json" };
  const post = (url: string, body: unknown, authenticated = true) => fetch(server.url + url, { method: "POST", headers: authenticated ? headers : { Origin: server.url }, body: JSON.stringify(body) });
  const body = { id: candidate.id, version: candidate.version };
  assert.equal((await post("/api/admission/admins", body, false)).status, 403); assert.equal(f.service.isAdmin(owner), false);
  assert.equal((await post("/api/admission/admins", body)).status, 200); assert.equal(f.service.isAdmin(owner), true);
  const rows = await (await fetch(server.url + "/api/admission")).json(); assert.equal(rows.requests.length, 2);
  assert.equal((await post("/api/admission/decision", { id: r.id, version: r.version, choice: "actor" }, false)).status, 403); assert.deepEqual(f.grants, []);
  const result = await post("/api/admission/decision", { id: r.id, version: r.version, choice: "actor" }); assert.equal(result.status, 200);
  assert.throws(() => f.service.command(owner, "room", "group", `actor ${r.id} ${r.version}`), /已处理/);
  assert.equal((await post("/api/admission/decision", { id: r.id, version: r.version, choice: "actor" })).status, 409);
  assert.deepEqual(f.grants, [["account", "applicant"]]);
  assert.equal((await post("/api/admission/admins/remove", { principal: owner })).status, 200); assert.equal(f.service.isAdmin(owner), false);
});

test("an account manager admission decision updates the one existing ACL across cold state and restarts; removing the account removes its admin authority", async t => {
  const { AccountManager } = await import("../src/server/account-manager.js");
  const { saveAccount } = await import("../src/weixin/accounts.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-admission-owner-")), paths = resolveStatePaths(root);
  saveAccount(paths, { channel: "dingtalk", accountId: "account", clientId: "robot", clientSecret: "synthetic", savedAt: new Date().toISOString() });
  const manager = new AccountManager({ paths }); t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const admin = manager.admission.observe(owner, "owner", "direct"); manager.admission.setAdmin(admin.id, admin.version);
  const applicant = { ...owner, actorId: "new-person" };
  const r = manager.admission.observe(applicant, "new-person", "direct");
  manager.admission.decideRemote(owner, r.id, r.version, "actor");
  const store = new RuntimeStateStore((await import("../src/state/paths.js")).accountStatePaths(paths, "account"));
  assert.deepEqual(store.listPairedSenderIds(), ["new-person"]);
  assert.equal(manager.ideApprovals.registrationStatus(applicant), "allowed", "IM admission is the existing IDE personal authority");
  const restarted = new AccountManager({ paths }); t.after(() => restarted.stopAll());
  assert.equal(restarted.admission.isAdmin(owner), true); assert.equal(restarted.ideApprovals.registrationStatus(applicant), "allowed");
  await manager.removeAccount("account");
  saveAccount(paths, { channel: "dingtalk", accountId: "account", clientId: "robot", clientSecret: "synthetic", savedAt: new Date().toISOString() });
  const replacement = new AccountManager({ paths }); t.after(() => replacement.stopAll());
  assert.equal(replacement.admission.isAdmin(owner), false, "same ID/provider must not revive a deleted account's administrative privilege");
});

test("request floods are deduplicated and a single human cannot fill the global queue through many rooms", t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) f.applicant("same-person", `room-${i}`);
  assert.throws(() => f.applicant("same-person", "room-9"), /上限/);
  assert.equal(f.service.snapshot().requests.length, 8);
  f.applicant("another-person", "other-room"); assert.equal(f.service.snapshot().requests.length, 9);
});
