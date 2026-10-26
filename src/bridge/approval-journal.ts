import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const recordSchema = z.object({ id: z.string(), recipientId: z.string(), threadId: z.string(), hostId: z.string(),
  version: z.string(), createdAt: z.number(), updatedAt: z.number(),
  choice: z.string().optional(), label: z.string().optional(),
  phase: z.enum(["pending", "unconfirmed", "confirmed", "failed", "withdrawn"]) }).strict();
type Record = z.infer<typeof recordSchema>;

/** Audit only: no commands, tool arguments, credentials, reusable grants or
 * execution replay. Native Codex/MCP remains the sole permission authority. */
export class ApprovalJournal {
  private records: Record[] = [];
  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) this.records = z.object({ version: z.literal(1), records: z.array(recordSchema).max(1000) })
      .parse(JSON.parse(fs.readFileSync(file, "utf8"))).records;
  }
  add(input: Omit<Record, "phase" | "updatedAt">): void {
    this.commit([...this.records, { ...input, phase: "pending" as const, updatedAt: Date.now() }].slice(-1000));
  }
  update(id: string, change: Pick<Record, "phase"> & Partial<Pick<Record, "choice" | "label">>): void {
    this.commit(this.records.map(record => record.id === id ? { ...record, ...change, updatedAt: Date.now() } : record));
  }
  snapshot(): Record[] { return structuredClone(this.records); }
  private commit(records: Record[]): void {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify({ version: 1, records }), { mode: 0o600 });
        fs.renameSync(temp, this.file);
      } finally { fs.rmSync(temp, { force: true }); }
    }
    this.records = records;
  }
}
