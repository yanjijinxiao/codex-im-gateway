import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IDEAuthorization, IDE_SESSION_DAYS } from "../src/ide/authorization.js";
import type { IDEAccessSubject } from "../src/ide/access-subject.js";

test("IM provenance persists, is private, and is checked for exchange, HTTP authentication, active connections and restart", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-personal-auth-")), file = path.join(root, "auth.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const subject: IDEAccessSubject = { principal: { accountId: "account", channel: "dingtalk", providerId: "bot", actorId: "alice" }, basis: "im-personal", epoch: 0 };
  let allowed = true;
  const create = () => new IDEAuthorization(Date.now, file, "origin", s => allowed && s.principal.actorId === "alice");
  const auth = create(), pending = auth.request("a"), second = auth.request("a");
  auth.approve(pending.request.id, "a", "a", false, undefined, undefined, subject);
  auth.approve(second.request.id, "a", "a", false, undefined, undefined, subject);
  const browser = auth.exchangeRequest(pending.request.id, pending.proof, "a")!;
  const local = auth.consume(auth.grant("a"), "a")!;
  assert.deepEqual(browser.session.subject, subject);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2, "old binaries must reject the personal-policy format, not ignore provenance");
  assert.equal(JSON.stringify(auth.pending()).includes("alice"), false);
  assert.ok(create().authenticate(browser.token, "a"));
  assert.equal(new IDEAuthorization(Date.now, file, "origin").authenticate(browser.token, "a"), undefined, "missing policy cannot authorize a tagged grant");
  assert.equal(fs.readFileSync(file, "utf8").includes(browser.token), false);
  allowed = false;
  assert.equal(auth.active(browser.session), false);
  assert.equal(auth.authenticate(browser.token, "a"), undefined);
  assert.equal(auth.exchangeRequest(second.request.id, second.proof, "a"), undefined);
  assert.equal(create().authenticate(browser.token, "a"), undefined);
  assert.ok(auth.authenticate(local.token, "a"), "legacy/local authorizations without provenance are preserved, not guessed or rebound");
  auth.reconcileAccess(); allowed = true;
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2, "never downgrade after removing the last tagged session");
  assert.equal(create().authenticate(browser.token, "a"), undefined, "durable revocation cannot be undone by a later allow");
  assert.ok(create().authenticate(local.token, "a"));
});

test("malformed principal provenance in durable grants fails closed without rewriting the file", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-invalid-subject-")), file = path.join(root, "auth.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const auth = new IDEAuthorization(Date.now, file, "origin"); auth.consume(auth.grant("a"), "a");
  const data = JSON.parse(fs.readFileSync(file, "utf8")); data.sessions[0].session.subject = { basis: "group", principal: {} };
  fs.writeFileSync(file, JSON.stringify(data)); const original = fs.readFileSync(file);
  assert.throws(() => new IDEAuthorization(Date.now, file, "origin"), /授权记录无效/);
  assert.deepEqual(fs.readFileSync(file), original);
});

test("Gateway grants are one-use, project scoped, expiring and revocable", () => {
  let now = 1000; const auth = new IDEAuthorization(() => now);
  const token = auth.grant("a");
  assert.equal(auth.consume(token, "b"), undefined);
  const granted = auth.consume(token, "a")!; assert.ok(granted);
  assert.equal(auth.consume(token, "a"), undefined);
  assert.equal(auth.authenticate(granted.token, "b"), undefined);
  assert.equal(auth.authenticate(granted.token, "a"), granted.session);
  const stale = auth.grant("a"); now += 60_001; assert.equal(auth.consume(stale, "a"), undefined);
  auth.revoke(); assert.equal(auth.active(granted.session), false);
  const next = auth.consume(auth.grant("a"), "a")!;
  assert.equal(IDE_SESSION_DAYS, 90);
  assert.equal(next.session.expiresAt - now, 90 * 24 * 60 * 60_000);
  now += 8 * 60 * 60_000; assert.ok(auth.authenticate(next.token, "a"));
  now = next.session.expiresAt;
  assert.equal(auth.authenticate(next.token, "a"), undefined);
});

test("pairing approval binds the original browser proof and cannot authorize a copied URL/code", () => {
  let now = 1000; const auth = new IDEAuthorization(() => now);
  const pair = auth.request("project-a");
  assert.equal("proof" in auth.pending()[0], false);
  assert.equal(auth.exchangeRequest(pair.request.id, pair.proof, "project-a"), undefined);
  assert.throws(() => auth.approve(pair.request.id, "project-b"), /不匹配/);
  auth.approve(pair.request.id, "project-a");
  assert.equal(auth.exchangeRequest(pair.request.id, "copied-code", "project-a"), undefined);
  assert.equal(auth.exchangeRequest(pair.request.id, pair.proof, "project-b"), undefined);
  assert.ok(auth.exchangeRequest(pair.request.id, pair.proof, "project-a"));
  assert.equal(auth.exchangeRequest(pair.request.id, pair.proof, "project-a"), undefined);
  const expired = auth.request("project-a"); now += 5 * 60_000;
  assert.throws(() => auth.approve(expired.request.id, "project-a"), /过期/);
});

test("pending browser requests are deduplicated and bounded", () => {
  const auth = new IDEAuthorization(), pair = auth.request("a");
  assert.equal(auth.request("a", { id: pair.request.id, proof: pair.proof }).request.id, pair.request.id);
  for (let i = 1; i < 100; i++) auth.request("a");
  assert.throws(() => auth.request("a"), /过多/);
  auth.revoke(); assert.equal(auth.pending().length, 0);
});

test("approved browser access and exact trust survive restart without extending expiry", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-persistent-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "private/authorization.json"); let now = 1000;
  const auth = new IDEAuthorization(() => now, file, "https://ide.example.com");
  const grant = auth.consume(auth.grant("entry", "scope", true, "/exact/project"), "entry", "scope")!;
  const disk = fs.readFileSync(file, "utf8"); assert.equal(disk.includes(grant.token), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  now += 14 * 24 * 60 * 60_000;
  const restarted = new IDEAuthorization(() => now, file, "https://ide.example.com");
  const restored = restarted.authenticate(grant.token, "entry", "scope")!;
  assert.equal(restored.trustWorkspace, true); assert.equal(restored.trustedDirectory, "/exact/project");
  assert.equal(restored.expiresAt, grant.session.expiresAt);
  assert.equal(restarted.authenticate(grant.token, "entry", "different-scope"), undefined);
  assert.equal(new IDEAuthorization(() => now, file, "https://other.example.com").authenticate(grant.token, "entry", "scope"), undefined);
  now = grant.session.expiresAt;
  assert.equal(new IDEAuthorization(() => now, file, "https://ide.example.com").authenticate(grant.token, "entry", "scope"), undefined);
});

test("90-day grants survive repeated restarts past day 15 without rotating the token or extending expiry", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-90-day-auth-")), file = path.join(root, "authorization.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const day = 24 * 60 * 60_000, start = 1_800_000_000_000;
  let now = start;
  const create = () => new IDEAuthorization(() => now, file, "https://ide.example.com");
  const auth = create(), browser = auth.consume(auth.grant("project", "scope", true, "/project"), "project", "scope")!;
  const original = fs.readFileSync(file);
  for (const elapsed of [1, 16, 30, 60, 89]) {
    now = start + elapsed * day;
    const restored = create().authenticate(browser.token, "project", "scope")!;
    assert.ok(restored); assert.equal(restored.expiresAt, start + 90 * day);
    assert.equal(restored.trustWorkspace, true); assert.equal(restored.trustedDirectory, "/project");
    assert.deepEqual(fs.readFileSync(file), original, "ordinary restart must not clear or renew persisted grants");
  }
  now = start + 90 * day;
  assert.equal(create().authenticate(browser.token, "project", "scope"), undefined);
});

test("a lifetime-policy increase preserves existing 15-day authorizations and their original expiry", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-old-15-day-auth-")), file = path.join(root, "authorization.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const day = 24 * 60 * 60_000, start = 1_800_000_000_000;
  let now = start;
  const auth = new IDEAuthorization(() => now, file, "https://ide.example.com");
  const browser = auth.consume(auth.grant("old", "scope"), "old", "scope")!;
  const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
  legacy.sessions[0].session.expiresAt = start + 15 * day;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const original = fs.readFileSync(file);
  now = start + day;
  const upgraded = new IDEAuthorization(() => now, file, "https://ide.example.com");
  assert.equal(upgraded.authenticate(browser.token, "old", "scope")!.expiresAt, start + 15 * day);
  assert.deepEqual(fs.readFileSync(file), original);
  const newer = upgraded.consume(upgraded.grant("new", "other"), "new", "other")!;
  assert.equal(newer.session.expiresAt, now + 90 * day);
  assert.equal(upgraded.authenticate(browser.token, "old", "scope")!.expiresAt, start + 15 * day);
});

test("logout and explicit revocation persist; malformed records are not overwritten", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-revoke-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "authorization.json"), create = () => new IDEAuthorization(Date.now, file, "origin");
  const auth = create(), first = auth.consume(auth.grant("a"), "a")!;
  auth.logout(first.session); assert.equal(create().authenticate(first.token, "a"), undefined);
  const second = auth.consume(auth.grant("a"), "a")!; create().revoke();
  assert.equal(create().authenticate(second.token, "a"), undefined);
  fs.writeFileSync(file, "invalid"); assert.throws(create, /授权文件/); assert.equal(fs.readFileSync(file, "utf8"), "invalid");
});

test("entry-scoped revocation removes every credential phase, persists across restart and does not rewrite unrelated sessions", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-scoped-auth-")), file = path.join(root, "auth.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const auth = new IDEAuthorization(Date.now, file, "origin");
  const a = auth.consume(auth.grant("a"), "a")!, b = auth.consume(auth.grant("b"), "b")!;
  const pendingA = auth.request("a"), approvedA = auth.request("a"), pendingB = auth.request("b"), unusedA = auth.grant("a"), unusedB = auth.grant("b");
  auth.approve(approvedA.request.id, "a"); const before = fs.readFileSync(file);
  auth.revokeEntries(id => id === "unrelated"); assert.deepEqual(fs.readFileSync(file), before);
  auth.revokeEntries(id => id === "a");
  assert.equal(auth.authenticate(a.token, "a"), undefined); assert.equal(auth.consume(unusedA, "a"), undefined);
  assert.equal(auth.pending().some(request => request.id === pendingA.request.id), false);
  assert.equal(auth.exchangeRequest(approvedA.request.id, approvedA.proof, "a"), undefined);
  assert.equal(auth.active(b.session), true); assert.ok(auth.consume(unusedB, "b"));
  assert.ok(auth.pending().some(request => request.id === pendingB.request.id));
  const restarted = new IDEAuthorization(Date.now, file, "origin");
  assert.equal(restarted.authenticate(a.token, "a"), undefined); assert.equal(restarted.authenticate(b.token, "b")?.expiresAt, b.session.expiresAt);
});

test("failed stable-scope migration preserves durable grants and fails closed until storage works", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-auth-migrate-failure-")), file = path.join(root, "auth.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = new IDEAuthorization(Date.now, file, "origin"), grant = old.consume(old.grant("entry", "old"), "entry", "old")!;
  const before = fs.readFileSync(file, "utf8"), scope = "v2:" + "f".repeat(64);
  const original = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => { if (to === file) throw Error("injected migration storage failure"); original(from, to); }) as typeof fs.renameSync);
  assert.throws(() => new IDEAuthorization(Date.now, file, "origin", () => true, () => ({ current: scope, legacy: "old" })), /storage failure/);
  assert.equal(fs.readFileSync(file, "utf8"), before); mock.mock.restore();
  const restarted = new IDEAuthorization(Date.now, file, "origin", () => true, () => ({ current: scope, legacy: "old" }));
  assert.ok(restarted.authenticate(grant.token, "entry", scope)); assert.equal(restarted.authenticate(grant.token, "entry", "different"), undefined);
});
