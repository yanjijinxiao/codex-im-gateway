import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { WorkspaceIDEManager } from "./manager.js";
import { IDEAuthorization, IDE_SESSION_DAYS, IDE_SESSION_TTL_MS, type IDEBrowserSession } from "./authorization.js";
import { IDEInstallPendingError } from "./installer.js";
import type { IDEConfig } from "./config.js";
import { IDETLSManager, loadIDETLS, localIDEAddresses } from "./tls.js";
import { copyField, COPY_SCRIPT, COPY_STYLE } from "./copy-controls.js";
import type { IDEApprovalCopyPort } from "./approval-service.js";
import type { IDEAccessAuthority, IDEAccessSubject } from "./access-subject.js";
import { IDE_APPROVAL_CHOICES, ideConfirmationCommand } from "./approval-presentation.js";
import { workspaceAuthorizationScope, legacyWorkspaceScope } from "./workspace-scope.js";

type BrowserSession = IDEBrowserSession;
export type IDEAccessContext = Pick<WorkspaceIDEManager, "configStore" | "config" | "resolve" | "refresh" | "authorizationFile" | "canonicalForTrust" | "open" | "endpoint" | "resume" | "close" | "onStop" | "accessAvailable">;
const COOKIE = "cig_ide_";
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Separate owner-only data plane. No management bootstrap/token/IM API is
 * mounted here. Reverse proxies must send HTTP + WS to this listener only. */
export class IDEAccessServer {
  private server?: http.Server | https.Server;
  readonly tls: IDETLSManager;
  private renewal?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private readonly sockets = new Set<Duplex>();
  private readonly authorization: IDEAuthorization;
  private readonly authorizationError?: string;
  private readonly connections = new Map<Duplex, { session: BrowserSession; instanceId: string; timer: NodeJS.Timeout }>();
  private readonly decisions = new Set<{ entryId: string; invalidated: boolean }>();
  private readonly membershipChecks = new Map<string, Promise<void>>();
  private managementOrigin?: string;
  private approvalCopies?: IDEApprovalCopyPort;
  private accessAuthority?: IDEAccessAuthority;
  private transition: Promise<void> = Promise.resolve();
  error?: string;
  constructor(private readonly manager: IDEAccessContext, private readonly options: { verificationIntervalMs?: number } = {}) {
    this.tls = new IDETLSManager(path.join(path.dirname(manager.configStore.filePath), "tls"));
    try { this.authorization = new IDEAuthorization(Date.now, manager.authorizationFile(), new URL(manager.config().publicOrigin).origin,
      subject => this.accessAuthority?.isSubjectAllowed(subject) === true,
      id => { const target = manager.resolve(id); return { current: workspaceAuthorizationScope(target), legacy: legacyWorkspaceScope(target) }; }); }
    catch { this.authorization = new IDEAuthorization(); this.authorizationError = "IDE 授权记录无法读取；访问已拒绝，原文件未改动。"; }
    manager.accessAvailable = false;
    manager.onStop = id => { for (const [socket, entry] of this.connections) if (entry.instanceId === id) socket.destroy(); };
  }
  reload(revoke = true): Promise<void> {
    const work = this.transition.catch(() => {}).then(() => this.apply(revoke)); this.transition = work; return work;
  }
  async prepareTLS(address: string) {
    if (!localIDEAddresses().some(item => item.address === address)) throw new Error("请选择 Gateway 本机当前已分配的内网/VPN 地址");
    return this.tls.prepare(address);
  }
  async validateConfig(config: IDEConfig): Promise<void> {
    if (!config.tls) return;
    if (this.tls.owns(config.tls)) await this.tls.prepare(config.tls.certificateAddress ?? config.tls.bindAddress);
    loadIDETLS(config.tls, config.publicOrigin);
  }
  refreshCertificate(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const server = this.server, config = this.manager.config();
    if (!server || !config.tls || !this.tls.owns(config.tls)) return Promise.resolve();
    const work = this.tls.prepare(config.tls.certificateAddress ?? config.tls.bindAddress).then(() => {
      if (this.server !== server) return;
      (server as https.Server).setSecureContext(loadIDETLS(config.tls!, config.publicOrigin)); this.error = this.authorizationError;
    }).finally(() => { if (this.refreshing === work) this.refreshing = undefined; });
    this.refreshing = work; return work;
  }
  private async apply(revoke: boolean): Promise<void> {
    await this.shutdown(revoke); this.error = this.authorizationError;
    const config = this.manager.config(); if (!config.enabled) return;
    if (!this.authorizationError) this.authorization.setAudience(new URL(config.publicOrigin).origin);
    const handler = (req: IncomingMessage, res: ServerResponse) => void this.handle(req, res).catch(() => {
      if (!res.headersSent) this.page(res, 503, "IDE 暂不可用", "请在本地 Gateway 管理台检查主机状态。"); else res.destroy();
    });
    let server: http.Server | https.Server;
    try {
      await this.validateConfig(config);
      server = config.tls ? https.createServer({ ...loadIDETLS(config.tls, config.publicOrigin), handshakeTimeout: 10_000 }, handler) : http.createServer(handler);
    } catch (error) { this.error = error instanceof Error ? error.message : "IDE HTTPS 证书无法读取"; throw error; }
    server.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
    server.on("upgrade", (req, socket, head) => {
      void this.upgrade(req, socket, head).catch(() => socket.destroy());
    });
    server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxHeadersCount = 100; server.maxConnections = 256;
    const listenError = "IDE 访问入口启动失败；请检查端口占用及所选 VPN/IP 是否仍在线。";
    server.on("error", () => { this.error = listenError; });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject); server.listen(config.port, config.tls?.bindAddress ?? "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      this.server = server;
      this.manager.resume();
      this.manager.accessAvailable = true;
      if (config.tls && this.tls.owns(config.tls)) {
        this.renewal = setInterval(() => {
          void this.refreshCertificate().catch(() => { if (this.server === server) this.error = "IDE HTTPS 证书续期失败；请在管理台检查证书，IM 与 Codex 不受影响。"; });
        }, 12 * 60 * 60 * 1000); this.renewal.unref();
      }
    } catch (error) { this.error = listenError; throw error; }
  }
  running(): boolean { return Boolean(this.server?.listening); }
  port(): number | undefined { const address = this.server?.address(); return address && typeof address !== "string" ? address.port : undefined; }
  setManagementOrigin(origin: string): void { this.managementOrigin = origin; }
  setApprovalCopies(port: IDEApprovalCopyPort | undefined): void { this.approvalCopies = port; }
  setAccessAuthority(authority: IDEAccessAuthority): void { this.accessAuthority = authority; }
  reconcileAccess(): void {
    try { this.authorization.reconcileAccess(); }
    finally { for (const [socket, { session }] of this.connections) if (!this.authorization.active(session)) socket.destroy(); }
  }
  async grant(entryId: string, trustWorkspace = false, expectedScope?: string): Promise<{ action: string; entryId: string; token: string }> {
    this.assertEntry(entryId);
    const decision = { entryId, invalidated: false }; this.decisions.add(decision);
    try {
      const scope = this.scope(entryId);
      await this.refreshWorkspace(entryId);
      if (expectedScope !== undefined && scope !== expectedScope) throw new Error("项目目录已改变，请重新核对完整目录后授权");
      const directory = trustWorkspace ? await this.manager.canonicalForTrust(entryId) : undefined;
      this.assertEntry(entryId); if (scope !== this.scope(entryId)) throw new Error("项目已改变，未签发授权");
      if (decision.invalidated) throw new Error("项目授权配置已改变，未签发授权");
      return { action: `${new URL(this.manager.config().publicOrigin).origin}/authorize`, entryId, token: this.authorization.grant(entryId, scope, trustWorkspace, directory?.workspace, directory?.rootPaths) };
    } finally { this.decisions.delete(decision); }
  }
  pendingAccess() {
    return this.authorization.pending().flatMap(request => {
      try { const target = this.manager.resolve(request.entryId); return [{ ...request, hostId: target.hostId, projectName: target.projectName, workspace: target.workspace,
        ...(target.rootPaths ? { rootPaths: [...target.rootPaths] } : {}), scope: this.scope(request.entryId), url: new URL(`/workspace/${request.entryId}`, this.manager.config().publicOrigin).href }]; }
      catch { return []; }
    });
  }
  async approveAccess(requestId: string, entryId: string, trustWorkspace = false, beforeCommit?: () => void, subject?: IDEAccessSubject): Promise<void> {
    const decision = { entryId, invalidated: false }; this.decisions.add(decision);
    try {
      await this.refreshWorkspace(entryId);
      this.assertEntry(entryId); const scope = this.scope(entryId), directory = trustWorkspace ? await this.manager.canonicalForTrust(entryId) : undefined;
      this.assertEntry(entryId); if (scope !== this.scope(entryId)) throw new Error("项目已改变，未批准授权");
      if (decision.invalidated) throw new Error("项目授权配置已改变，未批准授权");
      beforeCommit?.();
      this.authorization.approve(requestId, entryId, scope, trustWorkspace, directory?.workspace, directory?.rootPaths, subject);
    } finally { this.decisions.delete(decision); }
  }
  rejectAccess(requestId: string, entryId: string): void {
    this.assertEntry(entryId); this.authorization.reject(requestId, entryId, this.scope(entryId));
  }
  private scope(entryId: string): string { return workspaceAuthorizationScope(this.manager.resolve(entryId)); }
  private assertEntry(entryId: string): void {
    if (this.authorizationError) throw new Error(this.authorizationError);
    if (!this.running()) throw new Error("Web IDE 尚未启用");
    const target = this.manager.resolve(entryId), config = this.manager.config();
    if (!config.enabled || !config.hosts.some(h => h.enabled && h.hostId === target.hostId)) throw new Error("项目主机未获授权");
  }
  revokeEntries(matches: (entryId: string) => boolean): void {
    for (const decision of this.decisions) if (matches(decision.entryId)) decision.invalidated = true;
    try { this.authorization.revokeEntries(matches); }
    finally { for (const [socket, { session }] of this.connections) if (matches(session.entryId)) socket.destroy(); }
  }
  revoke(): void {
    for (const decision of this.decisions) decision.invalidated = true;
    try { this.authorization.revoke(); } finally { for (const socket of this.connections.keys()) socket.destroy(); }
  }
  close(): Promise<void> {
    const work = this.transition.catch(() => {}).then(() => this.shutdown(false)); this.transition = work; return work;
  }
  private async shutdown(revoke: boolean): Promise<void> {
    for (const decision of this.decisions) decision.invalidated = true;
    clearInterval(this.renewal); this.renewal = undefined;
    this.manager.accessAvailable = false;
    if (revoke && !this.authorizationError) this.authorization.revoke();
    for (const socket of this.connections.keys()) socket.destroy();
    const server = this.server; this.server = undefined;
    if (server) {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of this.sockets) socket.destroy();
      server.closeAllConnections(); await closed;
    }
    await this.manager.close();
  }
  private validHost(req: IncomingMessage): boolean {
    return req.headers.host === new URL(this.manager.config().publicOrigin).host;
  }
  private validOrigin(req: IncomingMessage): boolean {
    return req.headers.origin === new URL(this.manager.config().publicOrigin).origin;
  }
  private cookie(req: IncomingMessage, name: string): string | undefined {
    return (req.headers.cookie ?? "").split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  }
  private authenticate(req: IncomingMessage, id: string): BrowserSession | undefined {
    if (!id) return;
    return this.authorization.authenticate(this.cookie(req, COOKIE + id), id, this.scope(id));
  }
  private setCookie(res: ServerResponse, name: string, value: string, maxAge: number): void {
    res.setHeader("Set-Cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.manager.config().publicOrigin.startsWith("https:") ? "; Secure" : ""}`);
  }
  private async refreshEntry(id: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    // Missing/moved/foreign entries are distinct from a backend whose current
    // membership cannot be read. Neither condition may grant or proxy access.
    try { this.manager.resolve(id); } catch { res.writeHead(404).end(); return false; }
    try { await this.refreshWorkspace(id); return true; }
    catch {
      try { this.manager.resolve(id); } catch { res.writeHead(404).end(); return false; }
      res.setHeader("Retry-After", "3");
      const retry = req.method === "GET" && req.url?.startsWith(`/workspace/${id}`);
      this.page(res, 503, "项目状态暂时无法核验", "Gateway 暂时无法读取 Codex 的当前项目归属，尚未开放 IDE。原有浏览器授权已保留；请稍后重试，无需重新配对。",
        `<a href="/workspace/${id}">重新核验并进入</a>`, retry ? "setTimeout(()=>location.reload(),3000);" : undefined);
      return false;
    }
  }
  /** Share only a live check. Every later access observes native state again. */
  private refreshWorkspace(id: string): Promise<void> {
    const existing = this.membershipChecks.get(id); if (existing) return existing;
    const work = Promise.resolve().then(() => this.manager.refresh(id)).then(() => undefined).finally(() => {
      if (this.membershipChecks.get(id) === work) this.membershipChecks.delete(id);
    });
    this.membershipChecks.set(id, work); return work;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // no-referrer serializes form navigation Origin as "null" in Chromium,
    // which would (correctly) fail the strict Origin check below.
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!this.validHost(req)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url ?? "/", this.manager.config().publicOrigin);
    const entryId = /^\/(?:workspace|open|ide|logout)\/([a-f0-9]{32})(?:\/|$)/.exec(url.pathname)?.[1] ?? "";
    if (entryId && !await this.refreshEntry(entryId, req, res)) return;
    const session = this.authenticate(req, entryId), method = req.method ?? "GET";
    const copyPanel = /^\/approval\/([a-f0-9]{32})$/.exec(url.pathname);
    if (copyPanel) {
      // No POST action, cookie, proof exchange or management authority here.
      // A link preview, crawler or copied link cannot approve anything.
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      if (method !== "GET") { res.writeHead(405, { Allow: "GET" }).end(); return; }
      const preview = this.approvalCopies?.copyPreview(copyPanel[1]);
      if (!preview || !preview.request.url || new URL(preview.request.url).origin !== url.origin) {
        this.page(res, 410, "确认复制面板已失效", "申请已过期、已处理或已重新核对。请回到原浏览器获取当前命令，再在机器人私聊或群聊发送 /ide auth 识别码。没有批准任何浏览器。"); return;
      }
      try { this.assertEntry(preview.request.entryId); } catch { res.writeHead(410).end(); return; }
      const r = preview.request;
      this.page(res, 200, "二次确认 · 复制命令", "核对项目后，复制一种选择，由已获个人准入的本人在对应机器人私聊或群聊发送。此页只复制，不批准浏览器；转发本页不能取得配对资格。",
        `<p>浏览器识别码：<strong>${escape(r.code)}</strong><br>项目：${escape(r.projectName)}<br>主机：${escape(r.hostId)}</p>${workspaceScopeHtml(r)}<p>IDE 具备运行用户的开发权限，不是文件系统沙箱。仅批准你本人发起的申请；批准后授权 ${IDE_SESSION_DAYS} 天，可撤销。申请截止时间：<time datetime="${new Date(r.expiresAt).toISOString()}">${escape(new Date(r.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))}（北京时间）</time>。申请到期后命令不可再用，本页不会自动刷新打断复制。</p>${IDE_APPROVAL_CHOICES.map(c => `<section><h2>${escape(c.label)}</h2><p>${escape(c.detail)}</p>${copyField(`「${c.label}」命令`, ideConfirmationCommand(preview.shortCode, c.choice), { purpose: "reply", rows: 2 })}</section>`).join("")}`); return;
    }
    // A one-use grant is posted from the local Gateway UI, never placed in a
    // URL or forwarded to code-server. No other cross-origin mutation is allowed.
    if (method === "POST" && url.pathname === "/authorize") {
      const authority = this.managementOrigin && new URL(this.managementOrigin);
      const allowed = authority && [this.managementOrigin, `http://localhost:${authority.port}`];
      if (!allowed || !allowed.includes(req.headers.origin)) { res.writeHead(403).end(); return; }
      const form = new URLSearchParams(await readBody(req)), id = form.get("entryId") ?? "";
      if (!await this.refreshEntry(id, req, res)) return;
      this.assertEntry(id);
      const access = this.authorization.consume(form.get("token") ?? "", id, this.scope(id));
      if (!access) { this.page(res, 401, "授权已失效", "请从 Gateway 管理页重新打开；授权只能使用一次。"); return; }
      this.setCookie(res, COOKIE + id, access.token, IDE_SESSION_TTL_MS / 1000);
      this.redirect(res, `/workspace/${id}`); return;
    }
    if (method !== "GET" && method !== "HEAD" && !this.validOrigin(req)) { res.writeHead(403).end(); return; }
    const workspace = /^\/workspace\/([a-f0-9]{32})$/.exec(url.pathname);
    if (method === "POST" && url.pathname === `/logout/${entryId}` && session) {
      const form = new URLSearchParams(await readBody(req)); if (form.get("csrf") !== session.csrf) { res.writeHead(403).end(); return; }
      this.authorization.logout(session);
      for (const [socket, value] of this.connections) if (value.session === session) socket.destroy();
      this.setCookie(res, COOKIE + entryId, "", 0); this.redirect(res, `/workspace/${entryId}`); return;
    }
    if (method === "GET" && (workspace || url.pathname === "/")) {
      const id = workspace?.[1] ?? "";
      if (!id) { this.page(res, 200, "项目 Web IDE", "请从 Gateway 管理页或 IM 中的项目链接进入，无需另设密码。"); return; }
      this.assertEntry(id);
      if (!session) {
        // Strict cookies may be omitted on an external link's first request.
        // Commit a same-origin document, then recheck immediately before showing
        // any approval UI. The marker controls presentation only: it never
        // authenticates, creates a grant, trusts a directory or starts an IDE.
        if (url.searchParams.get("auth_check") !== "1") {
          const destination = `/workspace/${id}?auth_check=1`;
          this.page(res, 200, "正在核验已有授权", "正在检查当前浏览器的访问权限，无需重复批准。",
            `<a href="${destination}">未自动继续时，点击核验并进入</a>`,
            `location.replace(${JSON.stringify(destination)});`); return;
        }
        const pairCookie = this.cookie(req, `cig_request_${id}`)?.split(".");
        const approved = pairCookie?.length === 2 && this.authorization.exchangeRequest(pairCookie[0], pairCookie[1], id, this.scope(id));
        if (approved) { this.setCookie(res, COOKIE + id, approved.token, IDE_SESSION_TTL_MS / 1000); this.redirect(res, `/workspace/${id}`); return; }
        const pending = this.authorization.request(id, pairCookie?.length === 2 ? { id: pairCookie[0], proof: pairCookie[1] } : undefined, this.scope(id));
        this.setCookie(res, `cig_request_${id}`, `${pending.request.id}.${pending.proof}`, 300);
        const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(this.manager.config().publicOrigin).hostname);
        const offer = this.approvalCopies?.offer(pending.request.id, id);
        const choiceControls = offer
          ? `<p>项目：<strong>${escape(offer.request.projectName)}</strong><br>主机：${escape(offer.request.hostId)}</p>${workspaceScopeHtml(offer.request)}<p>IDE 允许项目编辑和终端访问，具备运行用户的开发权限，不是文件系统沙箱。请选择一种权限，复制对应命令并在本人的机器人私聊或群聊发送一次；不会再要求第二条确认命令。</p>${IDE_APPROVAL_CHOICES.map(c => `<section><h2>${escape(c.label)}</h2><p>${escape(c.detail)}</p>${copyField(`「${c.label}」命令`, ideConfirmationCommand(offer.shortCode, c.choice), { purpose: "reply", rows: 2 })}</section>`).join("")}`
          : `${workspaceScopeHtml(this.manager.resolve(id))}<p>一次确认命令暂未就绪，可使用兼容流程在机器人私聊或群聊核对申请。</p>${copyField("兼容流程：先核对申请", `/ide auth ${pending.request.code}`, { purpose: "reply" })}`;
        this.page(res, 200, "等待 Gateway 授权", "当前浏览器尚未授权，不代表个人准入丢失。已在 Gateway 获准的个人无需额外登记 IDE 管理员；核对下方项目、主机、目录和权限，再复制所选命令发给对应机器人。无需 Web IDE 密码。",
          `<section data-ide-wait>${choiceControls}<p>浏览器识别码（仅核对用，无需单独发送）：<strong>${escape(pending.request.code)}</strong></p></section><p>只配对你本人发起的申请。复制不会发送命令或批准访问；剪贴板受限时，可长按短命令复制或直接输入。</p><p>本次浏览器申请有效期为 5 分钟；批准后，浏览器访问授权有效期为 ${IDE_SESSION_DAYS} 天，Gateway 重启保留，不自动延期。撤销个人准入会使由该资格签发的浏览器授权失效，重新允许也不会恢复旧登录。</p><p>批准后本页会自动继续；复制操作期间暂缓刷新。</p><a href="/workspace/${id}">批准后继续</a><details data-ide-registration-help><summary>首次使用：如何核对个人准入</summary><p>本页尚未验证你的 IM 身份。请在对应机器人私聊或群聊发送下方命令，查看本人资格；已获个人准入者无需重复设置。</p>${copyField("查询本人准入状态的命令", "/ide identity", { purpose: "reply" })}<p>未获准时，请管理员在运行 Gateway 的电脑管理页聊天授权中「允许此用户」，不要仅允许整个群。群白名单和 session 角色不授予个人 IDE 资格；旧版独立登记的身份仍兼容。</p>${this.managementOrigin && local ? `<p><a href="${escape(this.managementOrigin)}">打开本机 Gateway 管理页（仅运行 Gateway 的电脑）</a></p>` : ""}</details>`); return;
      }
      const endpoint = this.manager.endpoint(id, session.trustWorkspace === true);
      if (endpoint) { this.redirect(res, editorDestination(id, endpoint)); return; }
      // GET remains read-only: a nonce-protected same-origin form performs the
      // existing CSRF-checked POST. Link previews cannot start an IDE or grant
      // workspace trust. With scripts disabled there is an explicit fallback.
      const target = this.manager.resolve(id);
      this.page(res, 200, "正在打开 Web IDE", `${target.projectName} · ${target.hostId} · ${target.workspace}`,
        `<p>当前浏览器已授权，正在自动进入 code-server，无需再次批准。${session.trustWorkspace ? "Gateway 已授权并信任当前目录，沿用既有权限。" : "本次仅批准访问，沿用既有权限，不自动信任目录代码。"}</p><form data-ide-auto-open method="post" action="/open/${id}"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit">未自动继续时，点击进入</button></form>`,
        `document.querySelector('[data-ide-auto-open]').requestSubmit();`); return;
    }
    const open = /^\/open\/([a-f0-9]{32})$/.exec(url.pathname);
    if (method === "POST" && open && session) {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("csrf") !== session.csrf) { res.writeHead(403).end(); return; }
      if (!this.authorization.active(session)) { res.writeHead(401).end(); return; }
      let instance;
      try { instance = await this.manager.open(open[1], session.trustWorkspace === true, session.trustedDirectory, session.trustedRootPaths); }
      catch (error) {
        if (!(error instanceof IDEInstallPendingError)) throw error;
        this.page(res, 202, "正在准备 code-server", error.message, `<p>准备完成后会自动进入，无需再次批准。</p><a data-ide-retry href="/workspace/${open[1]}">立即检查进度</a>`,
          `setTimeout(()=>location.replace(document.querySelector('[data-ide-retry]').href),3000);`); return;
      }
      if (!this.authorization.active(session)) { res.writeHead(401).end(); return; }
      const destination = editorDestination(open[1], instance);
      // Extension preparation warnings remain visible in management status;
      // they must not add another gate in front of an authorized editor.
      this.redirect(res, destination); return;
    }
    const ide = /^\/ide\/([a-f0-9]{32})(\/.*)$/.exec(url.pathname);
    if (ide) {
      if (!session) { this.redirect(res, `/workspace/${ide[1]}`); return; }
      const endpoint = this.manager.endpoint(ide[1], session.trustWorkspace === true);
      if (!endpoint) { this.redirect(res, `/workspace/${ide[1]}`); return; }
      if ((session.trustWorkspace || endpoint.workspaceFile) && ide[2] === "/") {
        const key = endpoint.workspaceFile ? "workspace" : "folder", other = endpoint.workspaceFile ? "folder" : "workspace";
        const values = url.searchParams.getAll(key), expected = endpoint.workspaceFile ?? endpoint.workspace;
        if (url.searchParams.has(other) || url.searchParams.has("ew") || values.length > 1 || (values.length === 1 && values[0] !== expected)) {
          this.page(res, 403, "目录未获本次授权", "此授权仅用于所示项目工作区；请从 Gateway 中打开其他项目。"); return;
        }
        if (!values.length) { this.redirect(res, editorDestination(ide[1], endpoint)); return; }
      }
      const prefix = `/ide/${ide[1]}`;
      this.track(req.socket, session, endpoint.instanceId);
      const upstream = http.request({ socketPath: endpoint.socketPath, method, path: ide[2] + url.search,
        headers: this.proxyHeaders(req) }, result => {
        const headers = { ...result.headers };
        // code-server is private/auth:none. Never let its cookies overwrite the
        // Gateway browser session; credentials never travel to the remote host.
        delete headers["set-cookie"];
        if (headers.location?.startsWith("/")) headers.location = prefix + headers.location;
        res.writeHead(result.statusCode ?? 502, headers); result.pipe(res);
      });
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end("IDE connection unavailable"); else res.destroy(); });
      req.on("aborted", () => upstream.destroy()); res.on("close", () => upstream.destroy()); req.pipe(upstream); return;
    }
    res.writeHead(session ? 404 : 401).end();
  }
  private proxyHeaders(req: IncomingMessage): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: "localhost", origin: "http://localhost" };
    for (const key of Object.keys(headers)) if (["cookie", "authorization", "proxy-authorization", "forwarded"].includes(key) || key.startsWith("x-forwarded-") || key.startsWith("x-codex-")) delete headers[key];
    return headers;
  }
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", this.manager.config().publicOrigin), match = /^\/ide\/([a-f0-9]{32})(\/.*)$/.exec(url.pathname);
    if (!match) { socket.destroy(); return; }
    try { await this.refreshWorkspace(match[1]); } catch { socket.destroy(); return; }
    const session = this.authenticate(req, match[1]);
    if (!this.validHost(req) || !this.validOrigin(req) || !session) { socket.destroy(); return; }
    const endpoint = this.manager.endpoint(match[1], session.trustWorkspace === true); if (!endpoint) { socket.destroy(); return; }
    this.track(socket, session, endpoint.instanceId);
    const upstream = http.request({ socketPath: endpoint.socketPath, path: match[2] + url.search, headers: this.proxyHeaders(req) });
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.on("upgrade", (res, remote, remoteHead) => {
      remote.setTimeout(0);
      try {
        const current = this.manager.endpoint(match[1], session.trustWorkspace === true);
        if (!this.authorization.active(session) || (session.securityScope ?? session.scope) !== this.scope(session.entryId)
          || current?.instanceId !== endpoint.instanceId || current.socketPath !== endpoint.socketPath) {
          remote.destroy(); socket.destroy(); return;
        }
      } catch { remote.destroy(); socket.destroy(); return; }
      const headers = Object.entries(res.headers).filter(([key]) => !["set-cookie", "authorization"].includes(key))
        .flatMap(([key, value]) => Array.isArray(value) ? value.map(v => `${key}: ${v}`) : [`${key}: ${value}`]);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote).pipe(socket); remote.on("error", () => socket.destroy()); socket.on("close", () => remote.destroy());
    });
    upstream.on("response", res => { res.resume(); socket.destroy(); }); upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy()); socket.on("error", () => upstream.destroy()); upstream.end();
  }
  private track(socket: Duplex, session: BrowserSession, instanceId: string): void {
    const previous = this.connections.get(socket); if (previous) clearTimeout(previous.timer);
    const verify = async () => {
      if (this.connections.get(socket) !== entry || socket.destroyed) return;
      try {
        if (!this.authorization.active(session)) { disconnect("authorization-inactive"); return; }
        await this.refreshWorkspace(session.entryId);
        if (this.connections.get(socket) !== entry || socket.destroyed) return;
        if (!this.authorization.active(session) || (session.securityScope ?? session.scope) !== this.scope(session.entryId)) { disconnect("authorization-or-scope-changed"); return; }
        entry.timer = setTimeout(verify, interval()); entry.timer.unref();
      } catch { disconnect("membership-unavailable"); }
    };
    const disconnect = (reason: string) => {
      if (this.connections.get(socket) !== entry || socket.destroyed) return;
      console.warn(`[codex-im-gateway] IDE connection verification ${JSON.stringify({ timestamp: new Date().toISOString(), entryId: session.entryId, reason })}`);
      socket.destroy();
    };
    const interval = () => Math.max(1, Math.min(this.options.verificationIntervalMs ?? 30_000, session.expiresAt - Date.now()));
    const timer = setTimeout(verify, interval()); timer.unref();
    const entry = { session, instanceId, timer };
    this.connections.set(socket, entry);
    if (!previous) socket.once("close", () => { const entry = this.connections.get(socket); if (entry) clearTimeout(entry.timer); this.connections.delete(socket); });
  }
  private redirect(res: ServerResponse, location: string): void { res.writeHead(303, { Location: location }).end(); }
  private page(res: ServerResponse, status: number, title: string, text: string, body = "", script = ""): void {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const nonce = crypto.randomBytes(16).toString("base64");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    res.writeHead(status).end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:10vh auto;max-width:620px;padding:24px;color:#25342d;background:#f6f8f5;font:17px Georgia,serif}h1{font-size:30px}p{line-height:1.7;overflow-wrap:anywhere}label{display:grid;gap:8px}input,button{font:inherit;padding:12px;margin:12px 0}button{background:#214f3a;color:white;border:0;border-radius:6px;cursor:pointer}input{border:1px solid #aab7af}${COPY_STYLE}</style><h1>${escape(title)}</h1><p>${escape(text)}</p>${body}<script nonce="${nonce}">${COPY_SCRIPT}\n${script}</script></html>`);
  }
}
function editorDestination(id: string, endpoint: { workspace: string; workspaceFile?: string }): string {
  return `/ide/${id}/?${endpoint.workspaceFile ? "workspace" : "folder"}=${encodeURIComponent(endpoint.workspaceFile ?? endpoint.workspace)}`;
}
function workspaceScopeHtml(target: { workspace: string; rootPaths?: readonly string[] }): string {
  if (!target.rootPaths) return `<p>目录：${escape(target.workspace)}</p>`;
  return `<section data-ide-project-roots><h2>本次工作区包含 ${target.rootPaths.length} 个目录</h2><p>以下目录将同时打开；批准并信任适用于全部所列目录。目录集合改变后需重新核对授权，不会自动扩大旧授权。</p><ul>${target.rootPaths.map(root => `<li><code style="overflow-wrap:anywhere">${escape(root)}</code></li>`).join("")}</ul></section>`;
}
async function readBody(req: IncomingMessage): Promise<string> {
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { length += chunk.length; if (length > 4096) throw new Error("请求过大"); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString("utf8");
}
