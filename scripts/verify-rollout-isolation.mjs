// Opt-in, local-only replay. No Codex task or IM API is invoked.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { rolloutIdentity } from "../src/codex/rollout-identity.ts";
import { CodexSessionCompletionMonitor } from "../src/server/codex-session-monitor.ts";
import { ThreadEventHub } from "../src/server/thread-event-hub.ts";

if (process.argv[2] !== "--run" || !path.isAbsolute(process.argv[3] ?? "")) {
  console.log("Usage: TMPDIR=/private/tmp node --import tsx scripts/verify-rollout-isolation.mjs --run /absolute/internal-rollout.jsonl");
  process.exit(0);
}
const source = process.argv[3];
assert.ok(fs.statSync(source).size <= 32 * 1024 * 1024, "replay input must be at most 32 MiB");
let metadata;
let reviewTurns = 0;
for await (const line of readline.createInterface({ input: fs.createReadStream(source), crlfDelay: Infinity })) {
  try {
    const record = JSON.parse(line);
    if (record.type === "session_meta") metadata = record.payload;
    if (record.type === "event_msg" && record.payload?.type === "task_complete") reviewTurns++;
  } catch { /* trailing partial records are not events */ }
}
assert.ok(metadata && rolloutIdentity(metadata).internal, "selected file must be an internal rollout");
assert.ok(metadata.session_id && metadata.id !== metadata.session_id, "reproduce the parent-id alias");
assert.ok(reviewTurns > 0);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-rollout-replay-"));
const dir = path.join(root, "sessions");
fs.mkdirSync(dir);
const outputs = [];
let cards = 0;
const threadId = metadata.session_id;
const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"),
  subscriptions: () => [{ key: "test", hostId: "local", threadId, recipientId: "mock-only", managed: false,
    client: {
      async sendText(x) { outputs.push(x.text); return { messageId: "text" }; },
      async startTextStream(x) { cards++; outputs.push(x.text); return { messageId: "card" }; },
      async updateTextStream(x) { outputs.push(x.text); }
    }
  }],
  backend: () => ({ async readThreadSnapshot() {
    return { state: { threadId, persistence: "active", runtimeStatus: "notLoaded", activeFlags: [] }, turns: [] };
  } })
});
const monitor = new CodexSessionCompletionMonitor({ codexHome: root,
  onTaskChanged: (x) => x.status === "running" ? hub.started("local", x.sessionId, x.turnId, x.startedAt) : undefined,
  onActivity: (x) => hub.activity("local", x.sessionId, x.turnId, x.text),
  onCompletion: (x) => hub.completion("local", x.sessionId, x.turnId, x.text),
  onRecoveredCompletion: (x) => hub.recoverCompletion("local", x.sessionId, x.turnId, x.text)
});
const write = (file, records) => fs.appendFileSync(file, records.map((x) => JSON.stringify({ timestamp: new Date().toISOString(), ...x })).join("\n") + "\n");
try {
  monitor.start();
  await monitor.ready();
  const main = path.join(dir, "main.jsonl");
  write(main, [
    { type: "session_meta", payload: { id: threadId, cwd: root, source: "cli" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "main-test-turn" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "MAIN_PROGRESS" } }
  ]);
  await monitor.scanNow();
  const before = outputs.length;
  fs.copyFileSync(source, path.join(dir, "internal.jsonl"));
  await monitor.scanNow();
  assert.equal(outputs.length, before, "internal replay must not update the main card or send messages");
  assert.equal(cards, 1);
  write(main, [{ type: "event_msg", payload: { type: "task_complete", turn_id: "main-test-turn", last_agent_message: "MAIN_FINAL" } }]);
  await monitor.scanNow();
  assert.equal(outputs.at(-1), "MAIN_FINAL");
  console.log(JSON.stringify({ passed: true, reviewTurns, internalDeliveries: 0, mainCards: cards, mainFinalDelivered: true, imNetworkCalls: 0 }));
} finally {
  await monitor.stop();
  await hub.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
