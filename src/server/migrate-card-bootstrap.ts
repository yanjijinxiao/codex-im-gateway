import fs from "node:fs";
import path from "node:path";
import { accountChannel, loadAccount } from "../weixin/accounts.js";
import type { StatePaths } from "../state/paths.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { ChannelStreamBootstrap } from "../channels/stream-bootstrap.js";
import type { ChannelStreamCheckpoint } from "../channels/progress.js";

/** Upgrade only orphan handles supported by explicit old, structured receipts.
 * Runs before the hub starts; never issues an API call or changes a binding.
 */
export function migrateCardBootstrap(paths: StatePaths): void {
  const filePath = path.join(paths.runtimeDir, "thread-subscriptions.json");
  if (!fs.existsSync(filePath)) return;
  const states = readJsonFile<Record<string, { checkpoint?: ChannelStreamCheckpoint;
    pendingTerminals?: Record<string, { checkpoint?: ChannelStreamCheckpoint }> }>>(filePath, {});
  const candidates: Array<{ checkpoint: ChannelStreamCheckpoint; recipientId: string }> = [];
  for (const [key, state] of Object.entries(states)) {
    let identity: unknown;
    try { identity = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(identity) || identity.length !== 2 || !identity.every(v => typeof v === "string")) continue;
    const [accountId, sessionId] = identity;
    try {
      const account = loadAccount(paths, accountId);
      if (account.accountId !== accountId || accountChannel(account) !== "dingtalk") continue;
      const accountState = readJsonFile<{ sessions?: Array<{ id: string; senderId: string }> }>(path.join(paths.runtimeDir, accountId, "state.json"), {});
      const session = accountState.sessions?.find(item => item.id === sessionId);
      if (!session?.senderId) continue;
      for (const checkpoint of [state.checkpoint, ...Object.values(state.pendingTerminals ?? {}).map(item => item.checkpoint)]) {
        if (checkpoint?.creationAttempted && !checkpoint.messageId && !checkpoint.bootstrap && checkpoint.streamId
          && /^codex_bridge_[A-Za-z0-9_]{1,100}$/.test(checkpoint.streamId)) candidates.push({ checkpoint, recipientId: session.senderId });
      }
    } catch { /* Missing/removed accounts are not guessed. */ }
  }
  if (!candidates.length) return;
  const logPath = path.join(paths.root, "service.log");
  if (!fs.existsSync(logPath)) return;
  const ids = new Set(candidates.map(c => c.checkpoint.streamId!));
  const receipts = new Map<string, "created" | "delivered">();
  // Bounded upgrade scan; a missing old receipt stays unknown rather than
  // loading an unbounded, potentially multi-year service log at startup.
  const fd = fs.openSync(logPath, "r");
  let tail: string;
  try {
    const size = fs.fstatSync(fd).size, offset = Math.max(0, size - 16 * 1024 * 1024);
    const bytes = Buffer.alloc(size - offset); fs.readSync(fd, bytes, 0, bytes.length, offset);
    const value = bytes.toString("utf8"); tail = offset ? value.slice(value.indexOf("\n") + 1) : value;
  } finally { fs.closeSync(fd); }
  for (const line of tail.split("\n")) {
    if (!line.startsWith("[codex-im-gateway] DingTalk AI Card {")) continue;
    try {
      const value = JSON.parse(line.slice(line.indexOf("{")));
      if (value.event !== "api_acknowledged" || value.httpStatus !== 200 || !ids.has(value.outTrackId)) continue;
      if (value.operation === "deliver") receipts.set(value.outTrackId, "delivered");
      if (value.operation === "create" && !receipts.has(value.outTrackId)) receipts.set(value.outTrackId, "created");
    } catch { /* Do not interpret old unstructured messages or provider bodies. */ }
  }
  let changed = 0;
  for (const { checkpoint, recipientId } of candidates) {
    const receipt = receipts.get(checkpoint.streamId!);
    if (!receipt) continue;
    checkpoint.bootstrap = { version: 1, instanceId: checkpoint.streamId!, recipientId,
      stage: receipt === "delivered" ? "delivered" : "delivery-unconfirmed" } satisfies ChannelStreamBootstrap;
    if (receipt === "delivered") { checkpoint.messageId = checkpoint.streamId; checkpoint.bootstrap.messageId = checkpoint.streamId; }
    changed++;
  }
  if (changed) { writeJsonFile(filePath, states); console.info(`[codex-im-gateway] restored ${changed} legacy card bootstrap identities; no redelivery attempted`); }
}
