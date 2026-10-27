import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";

test("real IM and Web entry points share remote preparation, settings and exact native source receipts", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-submission-entrypoints-")), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "one", userId: "actor", token: "synthetic", baseUrl: "https://example.invalid", enabled: true });
  const store = new RuntimeStateStore(accountStatePaths(paths, "one"));
  const session = store.createSession("chat", "/remote/work", "Independent plan", undefined, "session", undefined, { standalone: true, hostId: "remote" });
  store.setSessionCollaborationMode(session.id, "plan"); store.setModelOverride("chat", "chosen-model"); store.setEffortOverride("chat", "high");
  const file = path.join(accountStatePaths(paths, "one").inboundDir, "input.txt"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "synthetic");
  const inputs: any[] = [], staged: string[] = []; let monitor: any;
  const backend = {
    backendInfo: () => ({ id: "app-server", capabilities: { ...APP_SERVER_BACKEND_CAPABILITIES, structuredOutput: false } }),
    async warmUp() {}, async listProjects() { return { backend: "app-server", projects: [] }; },
    async inspectThread(threadId: string) { return { threadId, persistence: "active", runtimeStatus: "idle", activeFlags: [], projectMembership: "none" }; },
    async readThreadSnapshot(threadId: string) { return { state: await this.inspectThread(threadId), turns: [], messages: [] }; },
    async stageAttachments(files: any[], options: any) { staged.push(options.scope); return files.map(item => ({ ...item, path: "/remote/attachment" })); },
    async run(input: any) {
      inputs.push(input); const turnId = `turn-${inputs.length}`;
      if (!input.threadId) await input.onThreadCreated?.("native-thread");
      await input.onTurnStarted?.({ threadId: "native-thread", turnId });
      return { threadId: "native-thread", turnId, text: "done", raw: "" };
    }, close() {}
  };
  const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: false, taskboardEnabled: false }),
    runnerFactory: () => backend as any, channelCapabilities: () => [],
    adapterFactory: () => ({ client: createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, inbound: { ...TEXT_CAPABILITIES.inbound, file: "available" } }, {
      async sendText() { return { messageId: "sent" }; }, async resolveAttachments() { return [{ path: file, kind: "file", label: "input.txt" }]; }
    }), async monitor(options) { monitor = options; options.onStatus?.({ state: "connected" }); await new Promise<void>(r => options.signal?.addEventListener("abort", () => r(), { once: true })); } }),
    codexSessionMonitorFactory: () => ({ start() {}, async stop() {} }) as any,
    codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} }) as any });
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  await manager.startAccount("one", false);
  const message = { id: "im-source", senderId: "actor", replyTargetId: "chat", text: "inspect file", attachments: [{ kind: "file", label: "input.txt", item: {} }], raw: {} };
  assert.equal(monitor.claimMessage(message), true); await monitor.onMessage(message);
  await manager.continueSession("one", session.id, "inspect file", [{ name: "input.txt", data: Buffer.from("synthetic") }], undefined, "web-source");
  assert.equal(inputs.length, 2); assert.equal(staged.length, 2); assert.equal(staged[0], staged[1]);
  for (const input of inputs) {
    assert.equal(input.projectBinding, "none"); assert.equal(input.collaborationMode, "plan"); assert.equal(input.hostId, "remote");
    assert.equal(input.model, "chosen-model"); assert.equal(input.effort, "high"); assert.match(input.prompt, /\/remote\/attachment/);
  }
  const receipts = Object.values(new InboundReceiptJournal(path.join(paths.runtimeDir, "one", "inbound-receipts.jsonl")).snapshot());
  assert.deepEqual(receipts.map(r => r.turnId).sort(), ["turn-1", "turn-2"]);
  assert.equal(new Set(receipts.map(r => r.clientUserMessageId)).size, 2);
  assert.equal(monitor.claimMessage(message), false);
});
