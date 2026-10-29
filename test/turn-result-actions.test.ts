import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TurnResultActions } from "../src/bridge/turn-result-actions.js";
import { AccountManager } from "../src/server/account-manager.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";

function directory(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-result-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const output = "answer\n```codex-im-gateway-actions\n" + JSON.stringify({
  remember: [{ kind: "preference", scope: "project", title: "Synthetic preference", content: "Synthetic durable content" }],
  send: [{ type: "file", path: "/synthetic/result.txt" }]
}) + "\n```";

test("restart and concurrent output recovery apply each exact result action once", async t => {
  const file = path.join(directory(t), "actions.json"), scope = ["account", "session", "host", "thread", "turn"];
  const journal = new TurnResultActions(file), effects: string[] = [];
  const effect = async (action: { kind: string }) => { effects.push(action.kind); await new Promise(r => setImmediate(r)); };
  assert.deepEqual(await Promise.all([journal.apply(scope, output, () => {}, effect), journal.apply(scope, output, () => {}, effect)]), [true, true]);
  assert.equal(await new TurnResultActions(file).apply(scope, output, () => {}, effect), true);
  assert.deepEqual(effects, ["remember", "send"]);
  const saved = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(saved, /result\.txt|Synthetic durable content/, "only hashed action identities are persisted");
  await journal.apply([...scope.slice(0, -1), "different-turn"], output, () => {}, effect);
  assert.equal(effects.length, 4);
});

test("an ambiguous external send is disclosed and never automatically resent after restart", async t => {
  const file = path.join(directory(t), "actions.json"), scope = ["scope"];
  let effects = 0;
  const effect = async () => { if (++effects === 2) throw Error("acknowledgement lost after delivery"); };
  assert.equal(await new TurnResultActions(file).apply(scope, output, () => {}, effect), false);
  assert.equal(await new TurnResultActions(file).apply(scope, output, () => {}, effect), false);
  assert.equal(effects, 2);
});

test("a changed binding is checked before every new effect and is never claimed or applied", async t => {
  const journal = new TurnResultActions(path.join(directory(t), "actions.json")); let effects = 0, current = true;
  const check = () => { if (!current) throw Error("binding changed"); };
  await assert.rejects(journal.apply(["scope"], output, check, async () => { effects++; current = false; }), /binding changed/);
  assert.equal(effects, 1); current = true;
  assert.equal(await journal.apply(["scope"], output, check, async () => { effects++; }), true);
  assert.equal(effects, 2);
});

test("a journal write failure prevents external effects and malformed journals are preserved", async t => {
  const root = directory(t), file = path.join(root, "actions.json"), journal = new TurnResultActions(file); let effects = 0;
  fs.mkdirSync(file);
  await assert.rejects(journal.apply(["scope"], output, () => {}, async () => { effects++; }));
  assert.equal(effects, 0); fs.rmdirSync(file);
  fs.writeFileSync(file, '{"version":1,"records":[]}');
  assert.throws(() => new TurnResultActions(file), /Invalid/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"version":1,"records":[]}');
});

for (const web of [false, true]) test(`${web ? "Web" : "IM"} results require an exact source receipt and retain effects across recovery`, async t => {
  const root = directory(t), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "one", userId: "actor", token: "synthetic", baseUrl: "https://example.invalid", enabled: false });
  const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: false }) }), inner = manager as any;
  t.after(async () => { inner.entries.clear(); await manager.stopAll(); });
  const session = manager.createSession("one", "chat", root, "Synthetic result"), store = inner.storeFor("one");
  store.setSessionThread(session.id, "thread"); let sends = 0;
  inner.entries.set("one", { status: "running", service: { async applyRecoveredAction() { sends++; } } });
  const sub = { key: JSON.stringify(["one", session.id]), hostId: "local", threadId: "thread", recipientId: "chat", managed: false, client: {} };
  await inner.applyNativeResult(sub, "turn", output); assert.equal(store.listKnowledge().length, 0); assert.equal(sends, 0);
  const receipts = inner.receiptsFor("one");
  await receipts.handle({ id: "source", senderId: web ? "web-admin" : "actor", replyTargetId: "chat" }, async () => {
    receipts.submitting({ sessionId: session.id, hostId: "local", threadId: "thread" }); receipts.accepted("thread", "turn");
  });
  for (const bad of [{ ...sub, hostId: "foreign" }, { ...sub, recipientId: "elsewhere" }]) await inner.applyNativeResult(bad, "turn", output);
  assert.equal(store.listKnowledge().length, 0);
  await inner.applyNativeResult(sub, "turn", output); await inner.applyNativeResult(sub, "turn", output);
  assert.equal(store.listKnowledge().length, 1); assert.equal(sends, web ? 0 : 1);
  inner.runner = { hasRestartBlockingWork: () => false, isIndependentObservation: () => true, close() {} };
  const id = crypto.randomUUID(); manager.prepareRelease(id);
  await assert.rejects(inner.applyNativeResult(sub, "turn", output.replace("result.txt", "new-result.txt")), /发布/);
  assert.equal(sends, web ? 0 : 1, "release admission prevents every new output effect");
  manager.cancelRelease(id);
  if (!web) {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    inner.entries.get("one").service.applyRecoveredAction = async () => { entered.resolve(); await release.promise; sends++; };
    const pending = inner.applyNativeResult(sub, "turn", output.replace("result.txt", "settling.txt"));
    await entered.promise;
    assert.throws(() => manager.prepareRelease(crypto.randomUUID()), /正在处理|繁忙|运行|busy|活动/i);
    release.resolve(); await pending;
    manager.prepareRelease(id); manager.cancelRelease(id);
  }
});

test("a paused observer defers completion and actions until release cancellation, without interrupting native work", async t => {
  const root = directory(t), sent: string[] = []; let actions = 0;
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
    client: { async sendText(input) { sent.push(input.text); return { messageId: "sent" }; } } };
  const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), subscriptions: () => [sub],
    backend: () => ({}), applyResult: async () => { actions++; return "effect notice"; } }); t.after(() => hub.stop());
  hub.pauseForRestart(); await hub.completion("local", "thread", "turn", output);
  assert.equal(sent.length, 0); assert.equal(actions, 0);
  hub.resumeAfterCancelledRestart(); await hub.completion("local", "thread", "turn", output);
  assert.equal(actions, 1); assert.match(sent.at(-1) ?? "", /answer\n\neffect notice/);
  assert.doesNotMatch(sent.at(-1) ?? "", /codex-im-gateway-actions/);
  await hub.completion("local", "thread", "turn", output); assert.equal(actions, 1);
});
