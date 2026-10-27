import crypto from "node:crypto";
import { writeJsonFile } from "../state/json-store.js";
import fs from "node:fs";
import path from "node:path";
import { ideAccessSubjectSchema, type IDEAccessSubject } from "./access-subject.js";

const REQUEST_TTL = 5 * 60_000;
/** New browser grants last about three months. Persisted grants retain their
 * exact approved deadline; a restart or policy increase never renews them. */
export const IDE_SESSION_DAYS = 90;
export const IDE_SESSION_TTL_MS = IDE_SESSION_DAYS * 24 * 60 * 60_000;
type WorkspaceTrust = { trustWorkspace?: boolean; trustedDirectory?: string; trustedRootPaths?: readonly string[]; subject?: IDEAccessSubject };
export type IDEBrowserSession = WorkspaceTrust & { entryId: string; scope: string; expiresAt: number; csrf: string };
export type IDEAccessRequest = { id: string; entryId: string; code: string; expiresAt: number; approved: boolean };
type Pending = IDEAccessRequest & WorkspaceTrust & { proof: string; scope: string };
const random = () => crypto.randomBytes(32).toString("base64url");
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** The local, mutation-protected Gateway API is the authority. IM URLs and
 * visible pairing codes are identifiers, never bearer credentials. */
export class IDEAuthorization {
  private readonly grants = new Map<string, WorkspaceTrust & { entryId: string; scope: string; expiresAt: number }>();
  private readonly requests = new Map<string, Pending>();
  private readonly sessions = new Map<string, IDEBrowserSession>();
  private persistenceDirty = false;
  private persistenceVersion: 1 | 2 = 1;
  constructor(private readonly now: () => number = Date.now, private readonly filePath?: string, private audience = "",
    private readonly subjectAllowed: (subject: IDEAccessSubject) => boolean = () => false) {
    if (!filePath) return;
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("IDE 授权文件无法读取；未覆盖原记录，请在管理页检查。"); }
    const data = value as { version?: unknown; audience?: unknown; sessions?: unknown };
    if ((data?.version !== 1 && data?.version !== 2) || !Array.isArray(data.sessions) || data.sessions.length > 100) throw new Error("IDE 授权文件无效；未覆盖原记录。");
    this.persistenceVersion = data.version;
    if (data.audience !== audience) return; // A different public origin cannot inherit grants.
    for (const record of data.sessions) {
      if (!record || !/^[a-f0-9]{64}$/.test(record.hash) || !record.session || typeof record.session.entryId !== "string"
        || typeof record.session.scope !== "string" || typeof record.session.csrf !== "string"
        || !Number.isFinite(record.session.expiresAt) || (record.session.trustWorkspace !== undefined && typeof record.session.trustWorkspace !== "boolean")
        || (record.session.trustWorkspace && (typeof record.session.trustedDirectory !== "string" || !path.posix.isAbsolute(record.session.trustedDirectory)))
        || (record.session.trustedRootPaths !== undefined && !validRoots(record.session.trustedRootPaths, record.session.trustedDirectory))
        || (record.session.subject !== undefined && (data.version !== 2 || !ideAccessSubjectSchema.safeParse(record.session.subject).success))) throw new Error("IDE 授权记录无效；未覆盖原记录。");
      if (record.session.expiresAt > now() && record.session.expiresAt <= now() + IDE_SESSION_TTL_MS) this.sessions.set(record.hash, record.session);
    }
  }
  private persist(): void {
    if (!this.filePath) return;
    this.persistenceDirty = true;
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
    // Old binaries must fail closed instead of ignoring the new personal ACL.
    // Never downgrade a file, even after all tagged sessions were revoked.
    if ([...this.sessions.values()].some(session => session.subject)) this.persistenceVersion = 2;
    const data = { version: this.persistenceVersion, audience: this.audience,
      sessions: [...this.sessions].filter(([, session]) => session.expiresAt > this.now()).map(([hash, session]) => ({ hash, session })) };
    writeJsonFile(this.filePath, data, { durable: true });
    this.persistenceDirty = false;
  }
  setAudience(audience: string): void { if (this.audience !== audience) { this.audience = audience; this.revoke(); } }
  private prune(): void {
    const now = this.now();
    for (const map of [this.grants, this.requests, this.sessions]) {
      for (const [id, value] of map) if (value.expiresAt <= now) map.delete(id);
    }
  }
  grant(entryId: string, scope = entryId, trustWorkspace = false, trustedDirectory?: string, trustedRootPaths?: readonly string[]): string {
    this.prune();
    if (this.grants.size >= 100) throw new Error("待使用的 IDE 授权过多，请稍后重试");
    const token = random(); this.grants.set(hash(token), { entryId, scope, expiresAt: this.now() + 60_000, trustWorkspace, trustedDirectory,
      ...(trustedRootPaths ? { trustedRootPaths: [...trustedRootPaths] } : {}) }); return token;
  }
  consume(token: string, entryId: string, scope = entryId): { token: string; session: IDEBrowserSession } | undefined {
    this.prune(); const key = hash(token), grant = this.grants.get(key);
    if (!grant || grant.entryId !== entryId || grant.scope !== scope) return;
    if (!this.allowed(grant)) return;
    this.grants.delete(key); return this.createSession(entryId, scope, grant.trustWorkspace, grant.trustedDirectory, grant.trustedRootPaths, grant.subject);
  }
  request(entryId: string, existing?: { id: string; proof: string }, scope = entryId): { request: IDEAccessRequest; proof: string } {
    this.prune(); const previous = existing && this.requests.get(existing.id);
    if (previous && previous.entryId === entryId && previous.scope === scope && previous.proof === hash(existing!.proof)) return { request: this.public(previous), proof: existing!.proof };
    if (this.requests.size >= 100) throw new Error("待授权浏览器过多，请稍后重试");
    let code: string;
    do { code = crypto.randomInt(100_000, 1_000_000).toString(); } while ([...this.requests.values()].some(r => r.code === code));
    const proof = random(), request = { id: random(), entryId, scope, code,
      proof: hash(proof), expiresAt: this.now() + REQUEST_TTL, approved: false };
    this.requests.set(request.id, request); return { request: this.public(request), proof };
  }
  pending(): IDEAccessRequest[] { this.prune(); return [...this.requests.values()].filter(r => !r.approved).map(r => this.public(r)); }
  approve(id: string, entryId: string, scope = entryId, trustWorkspace = false, trustedDirectory?: string, trustedRootPaths?: readonly string[], subject?: IDEAccessSubject): void {
    this.prune(); const request = this.requests.get(id);
    if (!request || request.approved || request.entryId !== entryId || request.scope !== scope) throw new Error("浏览器申请已过期、已处理或项目不匹配，请刷新");
    const parsed = subject ? ideAccessSubjectSchema.parse(subject) : undefined;
    if (parsed && !this.subjectAllowed(parsed)) throw new Error("个人准入已撤销，未批准浏览器");
    request.subject = parsed;
    request.approved = true; request.trustWorkspace = trustWorkspace; request.trustedDirectory = trustedDirectory;
    request.trustedRootPaths = trustedRootPaths ? [...trustedRootPaths] : undefined;
  }
  reject(id: string, entryId: string, scope = entryId): void {
    this.prune(); const request = this.requests.get(id);
    if (!request || request.approved || request.entryId !== entryId || request.scope !== scope) throw new Error("浏览器申请已失效或项目不匹配");
    this.requests.delete(id);
  }
  exchangeRequest(id: string, proof: string, entryId: string, scope = entryId): { token: string; session: IDEBrowserSession } | undefined {
    this.prune(); const request = this.requests.get(id);
    if (!request?.approved || request.entryId !== entryId || request.scope !== scope || request.proof !== hash(proof) || !this.allowed(request)) return;
    this.requests.delete(id); return this.createSession(entryId, scope, request.trustWorkspace, request.trustedDirectory, request.trustedRootPaths, request.subject);
  }
  authenticate(token: string | undefined, entryId: string, scope = entryId): IDEBrowserSession | undefined {
    this.prune(); const session = token && this.sessions.get(hash(token));
    return session && session.entryId === entryId && session.scope === scope && this.allowed(session) ? session : undefined;
  }
  active(session: IDEBrowserSession): boolean { this.prune(); return [...this.sessions.values()].includes(session) && this.allowed(session); }
  private allowed(value: WorkspaceTrust): boolean {
    try { return !value.subject || this.subjectAllowed(value.subject); } catch { return false; }
  }
  logout(session: IDEBrowserSession): void { for (const [id, value] of this.sessions) if (value === session) this.sessions.delete(id); this.persist(); }
  revoke(): void { this.grants.clear(); this.requests.clear(); this.sessions.clear(); this.persist(); }
  revokeEntries(matches: (entryId: string) => boolean): void {
    let persisted = false;
    for (const map of [this.grants, this.requests, this.sessions]) for (const [id, value] of map) {
      if (matches(value.entryId)) { map.delete(id); if (map === this.sessions) persisted = true; }
    }
    // A no-op reconciliation must not rewrite or extend durable grants.
    if (persisted || this.persistenceDirty) this.persist();
  }
  reconcileAccess(): void {
    let persisted = false;
    for (const map of [this.grants, this.requests, this.sessions]) for (const [id, value] of map) {
      if (!this.allowed(value)) { map.delete(id); if (map === this.sessions) persisted = true; }
    }
    if (persisted || this.persistenceDirty) this.persist();
  }
  private createSession(entryId: string, scope: string, trustWorkspace = false, trustedDirectory?: string, trustedRootPaths?: readonly string[], subject?: IDEAccessSubject) {
    if (trustWorkspace && (!trustedDirectory || !path.posix.isAbsolute(trustedDirectory))) throw new Error("未核对可信目录，未签发授权");
    if (trustedRootPaths !== undefined && !validRoots(trustedRootPaths, trustedDirectory)) throw new Error("未核对完整目录，未签发授权");
    this.prune(); if (this.sessions.size >= 100) throw new Error("IDE 浏览器会话达到上限，请撤销不用的授权");
    const token = random(), session = { entryId, scope, expiresAt: this.now() + IDE_SESSION_TTL_MS, csrf: random(), trustWorkspace, trustedDirectory,
      ...(trustedRootPaths ? { trustedRootPaths: [...trustedRootPaths] } : {}), ...(subject ? { subject } : {}) };
    this.sessions.set(hash(token), session);
    try { this.persist(); } catch (error) { this.sessions.delete(hash(token)); throw error; }
    return { token, session };
  }
  private public({ proof: _, scope: __, trustWorkspace: ___, trustedDirectory: ____, trustedRootPaths: _____, subject: ______, ...request }: Pending): IDEAccessRequest { return request; }
}
function validRoots(value: unknown, directory: string | undefined): value is string[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 32 && value.includes(directory)
    && new Set(value).size === value.length && value.every(root => typeof root === "string" && path.posix.isAbsolute(root) && !/[\r\n\0]/.test(root));
}
