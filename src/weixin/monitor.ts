import { WeixinApiClient } from "./api.js";
import { normalizeWeixinMessage, type NormalizedWeixinMessage, type WeixinRawMessage } from "./messages.js";

export type MonitorOptions = {
  onStatus?: import("../channels/types.js").ChannelMonitorOptions["onStatus"];
  client: WeixinApiClient;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxPollRetryMs?: number;
  initialSyncKey?: string;
  onSyncKey?: (syncKey: string) => Promise<void> | void;
  claimMessage?: (message: NormalizedWeixinMessage) => boolean;
  onMessage: (message: NormalizedWeixinMessage) => Promise<void>;
  onMessageError?: (error: unknown, message: NormalizedWeixinMessage) => Promise<void> | void;
};

export class PollRetryBackoff {
  private readonly initialMs: number;
  private readonly maxMs: number;
  private currentMs: number;

  constructor(initialMs: number, maxMs: number) {
    this.initialMs = Math.max(0, initialMs);
    this.maxMs = Math.max(this.initialMs, maxMs);
    this.currentMs = this.initialMs;
  }

  next(): number {
    const delayMs = this.currentMs;
    this.currentMs = Math.min(this.maxMs, this.currentMs === 0 ? 0 : this.currentMs * 2);
    return delayMs;
  }

  reset(): void {
    this.currentMs = this.initialMs;
  }
}

export async function monitorWeixin(options: MonitorOptions): Promise<void> {
  let syncKey = options.initialSyncKey;
  const handling = new Map<string, Promise<void>>();
  const checkpoints: Array<{ key: string; ready: boolean }> = [];
  let flushing: Promise<void> | undefined;
  let committing: typeof checkpoints[number] | undefined;
  const flushCheckpoints = (): Promise<void> => {
    if (flushing) return flushing;
    let failed = false;
    flushing = (async () => {
      while (checkpoints[0]?.ready) {
        const checkpoint = checkpoints[0];
        committing = checkpoint;
        try { await options.onSyncKey?.(checkpoint.key); }
        catch { failed = true; console.error("[codex-im-gateway] checkpoint persistence failed; cursor retained for retry"); return; }
        finally { committing = undefined; }
        if (checkpoints[0] === checkpoint) checkpoints.shift();
      }
    })().finally(() => {
      flushing = undefined;
      if (!failed && checkpoints[0]?.ready) void flushCheckpoints();
    });
    return flushing;
  };
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const retryBackoff = new PollRetryBackoff(pollIntervalMs, options.maxPollRetryMs ?? 30_000);
  while (!options.signal?.aborted) {
    void flushCheckpoints();
    let batch: { syncKey?: string; messages: WeixinRawMessage[] };
    try {
      batch = parseUpdateBatch(await options.client.getUpdates(syncKey, options.signal));
      options.onStatus?.({ state: "connected" });
    } catch (error) {
      if (options.signal?.aborted) break;
      options.onStatus?.({ state: "reconnecting", detail: "Polling failed; retrying" });
      const retryMs = retryBackoff.next();
      console.error(`[codex-im-gateway] monitor poll failed; retrying in ${retryMs}ms: ${errorDetail(error)}`);
      await delay(retryMs, options.signal);
      continue;
    }
    retryBackoff.reset();
    const { messages } = batch;
    if (messages.length) {
      console.log(`[codex-im-gateway] received ${messages.length} update(s)`);
    }
    const work: Promise<void>[] = [];
    let claimFailed = false;
    for (const raw of messages) {
      let normalized: NormalizedWeixinMessage | undefined;
      try {
        normalized = normalizeWeixinMessage(raw);
      } catch (error) {
        console.error(`[codex-im-gateway] failed to normalize message: ${errorDetail(error)}`);
        continue;
      }
      if (!normalized) {
        continue;
      }
      const existing = handling.get(normalized.id);
      if (existing) { work.push(existing); continue; }
      try {
        if (options.claimMessage && !options.claimMessage(normalized)) {
          console.log(`[codex-im-gateway] skipped duplicate message ${normalized.id}`);
          continue;
        }
      } catch {
        claimFailed = true;
        console.error("[codex-im-gateway] inbound receipt persistence failed; source cursor retained");
        break;
      }
      const message = normalized;
      console.log(`[codex-im-gateway] handling message ${message.id} from ${message.senderId}`);
      const pending = Promise.resolve().then(() => options.onMessage(message)).then(() => {
        console.log(`[codex-im-gateway] handled message ${message.id} from ${message.senderId}`);
      }).catch(async (error) => {
        console.error(`[codex-im-gateway] message handling failed for ${message.senderId}: ${errorDetail(error)}`);
        try { await options.onMessageError?.(error, message); }
        catch (reportError) {
          console.error(`[codex-im-gateway] failed to report message error for ${message.senderId}: ${errorDetail(reportError)}`);
        }
      }).finally(() => { if (handling.get(message.id) === pending) handling.delete(message.id); });
      handling.set(message.id, pending);
      work.push(pending);
    }
    if (!claimFailed && batch.syncKey && batch.syncKey !== syncKey) {
      syncKey = batch.syncKey; // Volatile poll cursor; never an execution queue.
      const checkpoint = { key: syncKey, ready: work.length === 0 };
      checkpoints.push(checkpoint);
      // Coalesce adjacent finished cursors behind a pending batch. This stores
      // neither payloads nor native work and cannot re-submit anything.
      void Promise.all(work).then(() => {
        checkpoint.ready = true;
        for (let i = checkpoints.length - 2; i >= 0; i--) {
          if (checkpoints[i] !== committing && checkpoints[i].ready && checkpoints[i + 1].ready) checkpoints.splice(i, 1);
        }
        return flushCheckpoints();
      });
    }
    if (claimFailed) await delay(retryBackoff.next(), options.signal);
    await Promise.resolve();
    if (!messages.length) {
      await delay(pollIntervalMs, options.signal);
    }
  }
  // Let already-resolved handlers settle; never wait for outstanding work.
  await new Promise<void>(resolve => setImmediate(resolve));
  await flushCheckpoints();
}

function parseUpdateBatch(value: unknown): { syncKey?: string; messages: WeixinRawMessage[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("getUpdates response must be an object");
  }
  const response = value as Record<string, unknown>;
  const messages = response.msgs ?? response.message_list ?? response.messages ?? [];
  if (!Array.isArray(messages)) {
    throw new Error("getUpdates response messages must be an array");
  }
  const syncKey = [response.get_updates_buf, response.next_sync_key, response.sync_key]
    .find((candidate): candidate is string => typeof candidate === "string");
  return { syncKey, messages: messages as WeixinRawMessage[] };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
