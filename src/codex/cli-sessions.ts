import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { canonicalCliWorkspace, cliProjectId, listJsonlFiles, readSessionMeta } from "./cli-projects.js";
import { rolloutIdentity } from "./rollout-identity.js";
import type { CodexHistoryPage, CodexHistoryPageInput, CodexThreadListInput, CodexThreadSnapshot, CodexThreadState } from "./backend.js";
/** Local, read-only rollout adapter. Never loads Desktop or starts app-server. */
export class CliSessionStore {
  constructor(readonly codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) { }
  private catalog() {
    const entries = new Map<string, {
      file: string;
      state: CodexThreadState;
    }>();
    for(const archived of [true, false]) {
      for(const file of listJsonlFiles(path.join(this.codexHome, archived ? "archived_sessions" : "sessions"))) {
        const meta = readSessionMeta(file.path);
        const identity = rolloutIdentity(meta?.payload ?? {});
        if(!identity.threadId || identity.internal)
          continue;
        const workspace = typeof meta?.payload?.cwd === "string" ? meta.payload.cwd : undefined;
        entries.set(identity.threadId, {
          file: file.path, state: {
            threadId: identity.threadId, persistence: archived ? "archived" : "active",
            // Disk records cannot prove whether a different CLI process is alive.
            runtimeStatus: "unknown", activeFlags: [], cwd: workspace,
            ...(workspace && path.isAbsolute(workspace) ? { workspaceProjectId: cliProjectId(workspace) } : {}),
            updatedAt: new Date(file.modifiedAt).toISOString()
          }
        });
      }
    }
    return entries;
  }
  private async titles(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const index = path.join(this.codexHome, "session_index.jsonl");
    if(fs.existsSync(index))
      for await(const line of readline.createInterface({ input: fs.createReadStream(index), crlfDelay: Infinity })) {
        try {
          const x = JSON.parse(line);
          if(typeof x.id === "string" && typeof x.thread_name === "string")
            names.set(x.id, x.thread_name);
        }
        catch { /* incomplete index line */ }
      }
    return names;
  }
  async list(input: CodexThreadListInput = {}): Promise<CodexThreadState[]> {
    const names = await this.titles();
    // CLI has no native project registry. Its workspace catalog is a derived view.
    return [...this.catalog().values()].map(({ state }) => ({ ...state, title: names.get(state.threadId) }))
      .filter(x => (!input.cwd || Boolean(x.cwd && canonicalCliWorkspace(x.cwd) === canonicalCliWorkspace(input.cwd)))
        && (!input.projectId || Boolean(x.cwd && cliProjectId(x.cwd) === input.projectId))
        && (!input.persistence || input.persistence === "all" || x.persistence === input.persistence))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.threadId.localeCompare(b.threadId))
      .slice(0, input.limit ?? Infinity);
  }
  async inspect(threadId: string): Promise<CodexThreadState> {
    const state = this.catalog().get(threadId)?.state;
    return state ? { ...state, title: (await this.titles()).get(threadId) }
      : { threadId, persistence: "missing", runtimeStatus: "unknown", activeFlags: [] };
  }
  async snapshot(threadId: string): Promise<CodexThreadSnapshot> {
    const entry = this.catalog().get(threadId);
    if(!entry)
      return { state: await this.inspect(threadId), turns: [] };
    const turns: CodexThreadSnapshot["turns"] = [];
    let turn: CodexThreadSnapshot["turns"][number] | undefined;
    let sequence = 0;
    const add = (role: "user" | "assistant", text: unknown, timestamp: string | undefined, progress = false) => {
      if(typeof text !== "string" || !text.trim())
        return;
      turn ??= { id: `stored-${turns.length}`, status: "completed", messages: [] };
      if(!turns.includes(turn))
        turns.push(turn);
      if(turn.messages.some(m => m.role === role && m.text === text))
        return;
      turn.messages.push({ id: `${turn.id}:${sequence++}`, role, text, createdAt: timestamp, ...(progress ? { kind: "progress" as const } : {}) });
    };
    for await(const line of readline.createInterface({ input: fs.createReadStream(entry.file), crlfDelay: Infinity })) {
      let record;
      try {
        record = JSON.parse(line);
      }
      catch {
        continue;
      }
      const p = record.payload ?? {};
      if(record.type === "event_msg") {
        if(p.type === "task_started" && typeof p.turn_id === "string") {
          turn = { id: p.turn_id, status: "inProgress", messages: [] };
          turns.push(turn);
        }
        else if((p.type === "task_complete" || p.type === "turn_aborted") && turn && (!p.turn_id || p.turn_id === turn.id)) {
          if(p.type === "task_complete")
            add("assistant", p.last_agent_message, record.timestamp);
          turn.status = p.type === "task_complete" ? "completed" : "interrupted";
        }
        else if(p.type === "user_message")
          add("user", p.message, record.timestamp);
        else if(p.type === "agent_message" && (p.phase === "commentary" || p.phase === "final_answer"))
          add("assistant", p.message, record.timestamp, p.phase === "commentary");
      }
      else if(record.type === "response_item" && p.type === "message"
        && (p.role === "user" || (p.role === "assistant" && (!p.phase || p.phase === "commentary" || p.phase === "final_answer")))) {
        // Tool results, developer prompts and private reasoning are never history messages.
        const content = Array.isArray(p.content) ? p.content.filter((c: {
          type?: string;
        }) => c.type === "input_text" || c.type === "output_text") : [];
        add(p.role, content.map((c: {
          text?: string;
        }) => c.text ?? "").join("\n"), record.timestamp, p.phase === "commentary");
      }
    }
    const last = turns.at(-1);
    return {
      state: {
        ...entry.state, latestTurnStatus: last?.status,
        ...(last?.status === "inProgress" ? { activeTurnId: last.id } : {})
      }, turns
    };
  }
  async historyPage(threadId: string, input: CodexHistoryPageInput = {}): Promise<CodexHistoryPage> {
    const snapshot = await this.snapshot(threadId);
    const messages = snapshot.turns.flatMap(t => t.messages);
    const direction = input.sortDirection ?? "desc";
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const fingerprint = crypto.createHash("sha256").update(`${this.codexHome}\0${threadId}\0${direction}`).digest("hex");
    let position = direction === "desc" ? messages.length : 0;
    if(input.cursor) {
      let cursor;
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      }
      catch {
        throw new Error("Invalid CLI history cursor");
      }
      if(cursor.key !== fingerprint || !Number.isSafeInteger(cursor.position) || cursor.position < 0 || cursor.position > messages.length)
        throw new Error("Invalid CLI history cursor");
      position = cursor.position;
    }
    const start = direction === "desc" ? Math.max(0, position - limit) : position;
    const end = direction === "desc" ? position : Math.min(messages.length, position + limit);
    const next = direction === "desc" ? start : end;
    const more = direction === "desc" ? next > 0 : next < messages.length;
    return { messages: messages.slice(start, end), ...(more ? { nextCursor: Buffer.from(JSON.stringify({ key: fingerprint, position: next })).toString("base64url") } : {}) };
  }
}
