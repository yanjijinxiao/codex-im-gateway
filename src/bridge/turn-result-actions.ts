import crypto from "node:crypto";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { SessionControlQueue } from "./session-control.js";
import { parseActionBlocks, type SendAction } from "./actions.js";
import type { KnowledgeInput } from "../state/knowledge.js";

export type TurnResultAction = { kind: "remember"; value: KnowledgeInput } | { kind: "send"; value: SendAction };

/** Output application, never a prompt queue. Claim each external effect before
 * I/O. An ambiguous claim is surfaced, not resent after process restart. */
export class TurnResultActions {
  private readonly queue = new SessionControlQueue();
  private readonly records: Record<string, "started" | "done">;
  constructor(private readonly file: string) {
    const data = readJsonFile<unknown>(file, { version: 1, records: {} }) as any;
    if (data?.version !== 1 || !data.records || typeof data.records !== "object" || Array.isArray(data.records)
      || Object.entries(data.records).some(([key, value]) => !/^[a-f0-9]{64}$/.test(key) || !["started", "done"].includes(String(value))))
      throw Error("Invalid turn result action journal; original file preserved");
    this.records = data.records;
  }
  apply(scope: readonly string[], text: string, assertCurrent: () => void, effect: (action: TurnResultAction) => Promise<void>): Promise<boolean> {
    const { actions } = parseActionBlocks(text, { strict: false });
    const steps: TurnResultAction[] = [...actions.remember.map(value => ({ kind: "remember" as const, value })),
      ...actions.send.map(value => ({ kind: "send" as const, value }))];
    return this.queue.run(JSON.stringify(scope), async () => {
      let confirmed = true;
      for (const [index, action] of steps.entries()) {
        const key = crypto.createHash("sha256").update(JSON.stringify([scope, index, action])).digest("hex");
        if (this.records[key] === "done") continue;
        if (this.records[key] === "started") { confirmed = false; continue; }
        assertCurrent();
        this.records[key] = "started"; this.save();
        try { await effect(action); this.records[key] = "done"; this.save(); }
        catch { confirmed = false; } // Unknown external delivery must never be replayed.
      }
      return confirmed;
    });
  }
  private save(): void { writeJsonFile(this.file, { version: 1, records: this.records }, { durable: true }); }
}
