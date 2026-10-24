import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(300).regex(/^[^\s\x00-\x1f\x7f]+$/);
export const ideApproverSchema = z.object({ accountId: identifier,
  channel: z.enum(["dingtalk", "feishu", "wecom", "weixin"]), providerId: identifier, actorId: identifier }).strict();
export type IDEApprover = z.infer<typeof ideApproverSchema>;
export type IDEApprovalRequest = { id: string; entryId: string; code: string; expiresAt: number; approved: boolean;
  accountId: string; hostId: string; projectName: string; workspace: string; scope: string; url?: string };
export type IDEApprovalCopyPort = Pick<IDEApprovalService, "copyPreview" | "offer">;
export type IDEApprovalPort = {
  pendingAccess(): IDEApprovalRequest[];
  approveAccess(requestId: string, entryId: string, trustWorkspace: boolean, beforeCommit?: () => void): Promise<void>;
  rejectAccess(requestId: string, entryId: string): void;
};
type Decision = { request: IDEApprovalRequest; revision: number; pending: boolean };
type Confirmation = Decision & { principal: string; owner: IDEApprover; shortCode: string };
type Offer = Decision & { account: { accountId: string; channel: string; providerId: string } };
const key = (principal: IDEApprover) => JSON.stringify([principal.accountId, principal.channel, principal.providerId, principal.actorId]);
const fingerprint = (request: IDEApprovalRequest) => JSON.stringify(request);

/** One authority for owner decisions, independent of chat ACLs, session roles,
 * model output and transports. A decision never contains a browser credential. */
export class IDEApprovalService {
  private readonly file: string;
  private owners: IDEApprover[] = [];
  private revision = 0;
  private port?: IDEApprovalPort;
  private readonly confirmations = new Map<string, Confirmation>();
  private readonly offers = new Map<string, Offer>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly decisions = new Map<string, { count: number; until: number }>();
  error?: string;
  constructor(private readonly options: { root: string; accounts: () => { accountId: string; channel: string; providerId: string }[]; now?: () => number }) {
    this.file = path.join(options.root, "ide", "approvers.json");
    try {
      const data = z.object({ version: z.literal(1), owners: z.array(ideApproverSchema).max(50) }).strict()
        .parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      this.owners = data.owners;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = "IDE 授权管理员记录无法读取；IM 审批已关闭，原文件未覆盖，请在本机管理页检查。";
    }
  }
  private now() { return (this.options.now ?? Date.now)(); }
  attach(port: IDEApprovalPort): () => void {
    this.port = port; this.confirmations.clear(); this.offers.clear();
    return () => { if (this.port === port) { this.port = undefined; this.confirmations.clear(); this.offers.clear(); } };
  }
  accounts() { return this.options.accounts().filter(a => ["dingtalk", "feishu", "wecom", "weixin"].includes(a.channel)); }
  list() { return this.owners.map(p => ({ ...p })); }
  private validAccount(principal: IDEApprover) {
    return this.accounts().some(a => a.accountId === principal.accountId && a.channel === principal.channel && a.providerId === principal.providerId);
  }
  /** Reports only the verified caller's own status; never enumerates owners or grants access. */
  registrationStatus(principal: IDEApprover): "registered" | "unregistered" | "unavailable" {
    if (this.error || !this.validAccount(principal)) return "unavailable";
    return this.owners.some(p => key(p) === key(principal)) ? "registered" : "unregistered";
  }
  principal(accountId: string, channel: string, actorId: string, providerId: string): IDEApprover {
    const account = this.accounts().find(a => a.accountId === accountId && a.channel === channel && a.providerId === providerId);
    if (!account) throw new Error("此渠道账号已改变，请重新在本机核对 IDE 管理员身份");
    return ideApproverSchema.parse({ ...account, actorId });
  }
  private assertOwner(principal: IDEApprover) {
    if (this.error || !this.validAccount(principal) || !this.owners.some(p => key(p) === key(principal)))
      throw new Error("当前个人账号不是 IDE 授权管理员。请先在本机 Gateway 的 Web IDE 页登记；群白名单和 session 权限不授予 IDE 审批权限。");
  }
  setOwner(input: IDEApprover, remove = false): void {
    if (this.error) throw new Error(this.error);
    const principal = ideApproverSchema.parse(input);
    if (!remove && !this.validAccount(principal)) throw new Error("只能登记当前已配置渠道账号的个人身份");
    const owners = this.owners.filter(p => key(p) !== key(principal));
    if (!remove) owners.push(principal);
    if (owners.length > 50) throw new Error("IDE 授权管理员数量达到上限");
    const directory = path.dirname(this.file); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, owners }), { mode: 0o600, flag: "wx" });
    try { fs.renameSync(temporary, this.file); } catch (error) { fs.unlinkSync(temporary); throw error; }
    this.owners = owners; this.revision++; this.confirmations.clear(); this.offers.clear();
    this.audit(remove ? "owner-removed" : "owner-added", principal);
  }
  /** Local mutation-token protected API and IM share this commit boundary. */
  async approveLocal(requestId: string, entryId: string, trustWorkspace: boolean) {
    await this.requirePort().approveAccess(requestId, entryId, trustWorkspace);
    this.audit("local-approved", undefined, { entryId, trustWorkspace });
  }
  private requirePort() { if (!this.port) throw new Error("IDE 审批服务尚未就绪，请稍后重试"); return this.port; }
  private prune() {
    const now = this.now();
    for (const decisions of [this.confirmations, this.offers]) for (const [id, item] of decisions) if (item.request.expiresAt <= now) decisions.delete(id);
    for (const attempts of [this.attempts, this.decisions]) for (const [id, item] of attempts) if (item.until <= now) attempts.delete(id);
  }
  private shortCode(): string {
    let code: string;
    do { code = crypto.randomBytes(6).toString("hex"); }
    while (this.offers.has(code) || [...this.confirmations.values()].some(c => c.shortCode === code));
    return code;
  }
  /** The browser renders an explicit permission choice, but gains no authority.
   * Capture its exact request/account snapshot BEFORE the first IM command.
   * Polling retains the same offer and can never rebind it to changed metadata. */
  offer(requestId: string, entryId: string): { shortCode: string; request: IDEApprovalRequest } | undefined {
    this.prune();
    if (this.error || !this.port) return;
    const matches = this.port.pendingAccess().filter(r => r.id === requestId && r.entryId === entryId && !r.approved && r.expiresAt > this.now());
    if (matches.length !== 1) return;
    const request = { ...matches[0] }, accounts = this.accounts().filter(a => a.accountId === request.accountId);
    if (accounts.length !== 1) return;
    const account = accounts[0];
    for (const [shortCode, item] of this.offers) if (item.request.id === requestId && item.request.entryId === entryId) {
      if (item.pending || item.revision !== this.revision || fingerprint(item.request) !== fingerprint(request)
        || JSON.stringify(item.account) !== JSON.stringify(account)) return;
      return { shortCode, request: { ...item.request } };
    }
    if (this.offers.size >= 100) return;
    const shortCode = this.shortCode();
    this.offers.set(shortCode, { request, account: { ...account }, revision: this.revision, pending: false });
    return { shortCode, request: { ...request } };
  }
  preview(principal: IDEApprover, code: string): { token: string; shortCode: string; request: IDEApprovalRequest } {
    this.assertOwner(principal); this.prune();
    if (!/^\d{6}$/.test(code)) throw new Error("用法：/ide auth 六位识别码");
    const identity = key(principal), attempt = this.attempts.get(identity) ?? { count: 0, until: this.now() + 60_000 };
    if (++attempt.count > 10) throw new Error("查找申请过于频繁，请一分钟后重试");
    this.attempts.set(identity, attempt);
    const matches = this.requirePort().pendingAccess().filter(r => r.accountId === principal.accountId && r.code === code && !r.approved && r.expiresAt > this.now());
    if (matches.length !== 1) throw new Error("未找到唯一有效的浏览器申请；请在原浏览器刷新后核对新识别码。未批准任何浏览器。");
    const request = { ...matches[0] };
    for (const [id, item] of this.confirmations) if (item.principal === identity && item.request.id === request.id && !item.pending) this.confirmations.delete(id);
    if (this.confirmations.size >= 100) throw new Error("待确认的 IDE 审批过多，请稍后重试");
    const token = crypto.randomBytes(16).toString("hex");
    const shortCode = this.shortCode();
    this.confirmations.set(token, { principal: identity, owner: { ...principal }, shortCode, request, revision: this.revision, pending: false });
    return { token, shortCode, request };
  }
  /** Read-only presentation capability, not browser authorization. The 128-bit
   * link can be forwarded, but cannot decide, enroll or exchange a browser proof. */
  copyPreview(token: string): { shortCode: string; request: IDEApprovalRequest } | undefined {
    this.prune();
    const item = /^[a-f0-9]{32}$/.test(token) ? this.confirmations.get(token) : undefined;
    if (!item || item.pending || item.revision !== this.revision) return;
    try {
      this.assertOwner(item.owner);
      if (!this.requirePort().pendingAccess().some(r => fingerprint(r) === fingerprint(item.request))) return;
      return { shortCode: item.shortCode, request: { ...item.request } };
    } catch { return; }
  }
  async decide(principal: IDEApprover, token: string, choice: "trust" | "access" | "deny"): Promise<void> {
    this.assertOwner(principal); this.prune();
    if (!["trust", "access", "deny"].includes(choice)) throw new Error("无效的 IDE 审批选项，未批准浏览器。");
    const identity = key(principal), attempt = this.decisions.get(identity) ?? { count: 0, until: this.now() + 60_000 };
    this.decisions.set(identity, attempt);
    if (++attempt.count > 20) throw new Error("确认尝试过于频繁，请一分钟后重试；未批准浏览器。");
    // Browser offers require an explicitly registered owner of the captured
    // provider/account. Legacy previews additionally bind the original actor.
    // Neither uses a public pairing code or an implicit "latest request".
    const offered = this.offers.get(token);
    if (!offered && /^[a-f0-9]{12}$/.test(token)) token = [...this.confirmations].find(([, c]) => c.principal === identity && c.shortCode === token)?.[0] ?? "";
    const confirmation = this.confirmations.get(token), port = this.requirePort();
    const decision = offered ?? confirmation, store = offered ? this.offers : this.confirmations;
    if (!decision || decision.pending || (offered
      ? offered.account.accountId !== principal.accountId || offered.account.channel !== principal.channel || offered.account.providerId !== principal.providerId
      : confirmation?.principal !== identity))
      throw new Error("此确认已失效、正在处理或不属于当前个人账号；请回原浏览器复制当前命令，或重新发送 /ide auth 识别码。");
    decision.pending = true;
    const guard = () => {
      this.assertOwner(principal);
      if (this.port !== port || this.revision !== decision.revision || store.get(token) !== decision
        || decision.request.expiresAt <= this.now()
        || !port.pendingAccess().some(r => fingerprint(r) === fingerprint(decision.request)))
        throw new Error("申请、管理员或项目目录已改变，请重新核对，未批准浏览器。");
    };
    try {
      guard();
      if (choice === "deny") port.rejectAccess(decision.request.id, decision.request.entryId);
      else await port.approveAccess(decision.request.id, decision.request.entryId, choice === "trust", guard);
      this.audit(choice === "deny" ? "denied" : "approved", principal, { entryId: decision.request.entryId, trustWorkspace: choice === "trust" });
    } finally { store.delete(token); }
  }
  private audit(action: string, principal?: IDEApprover, details: Record<string, unknown> = {}) {
    // No pairing code, confirmation command, browser proof, cookie or full path.
    console.info("[codex-im-gateway] IDE approval", JSON.stringify({ action, ...(principal ?? {}), ...details }));
  }
}
