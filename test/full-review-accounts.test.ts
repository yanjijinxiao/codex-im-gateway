import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAccounts, loadAccount, publicAccount, saveAccount } from "../src/weixin/accounts.js";
import { resolveStatePaths } from "../src/state/paths.js";
const account = (accountId = "valid") => ({ accountId, token: "synthetic", baseUrl: "https://example.test", cdnBaseUrl: "https://cdn.example.test", enabled: true, savedAt: "" });
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-account-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); const paths = resolveStatePaths(root); saveAccount(paths, account()); return paths;
}
test("one corrupted account cannot prevent listing healthy accounts", t => {
  const paths = fixture(t); fs.writeFileSync(path.join(paths.accountsDir, "broken.json"), "{");
  assert.deepEqual(listAccounts(paths).map(account => account.accountId), ["valid"]);
  assert.equal(fs.readFileSync(path.join(paths.accountsDir, "broken.json"), "utf8"), "{");
});
test("unknown channel and credential shapes cannot become enabled account records", t => {
  const paths = fixture(t); fs.writeFileSync(path.join(paths.accountsDir, "invalid.json"), JSON.stringify({ accountId: "invalid", channel: "unknown", token: 123 }));
  assert.deepEqual(listAccounts(paths).map(account => account.accountId), ["valid"]);
});
test("normalization collisions cannot overwrite or select a different raw account identity", t => {
  const paths = fixture(t); saveAccount(paths, account("bot/one"));
  assert.throws(() => saveAccount(paths, account("bot?one")), /identity|冲突/);
  assert.throws(() => loadAccount(paths, "bot-one"), /not found/);
  assert.equal(loadAccount(paths, "bot/one").accountId, "bot/one");
});
test("unexpected credential fields from account JSON cannot leak through public summaries", t => {
  const paths = fixture(t); const file = path.join(paths.accountsDir, "valid.json");
  fs.writeFileSync(file, JSON.stringify({ ...account(), clientSecret: "unexpected-secret", appSecret: "unexpected-secret" }));
  const summary = publicAccount(loadAccount(paths, "valid"));
  assert.equal(JSON.stringify(summary).includes("unexpected-secret"), false);
});
