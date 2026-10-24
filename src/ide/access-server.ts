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
import { IDE_APPROVAL_CHOICES, ideConfirmationCommand } from "./approval-presentation.js";

type BrowserSession = IDEBrowserSession;
export type IDEAccessContext = Pick<WorkspaceIDEManager, "configStore" | "config" | "resolve" | "authorizationFile" | "canonicalForTrust" | "open" | "endpoint" | "resume" | "close" | "onStop" | "accessAvailable">;
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
  private managementOrigin?: string;
  private approvalCopies?: IDEApprovalCopyPort;
  private transition: Promise<void> = Promise.resolve();
  error?: string;
  constructor(private readonly manager: IDEAccessContext) {
    this.tls = new IDETLSManager(path.join(path.dirname(manager.configStore.filePath), "tls"));
    try { this.authorization = new IDEAuthorization(Date.now, manager.authorizationFile(), new URL(manager.config().publicOrigin).origin); }
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
      try { this.upgrade(req, socket, head); } catch { socket.destroy(); }
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
  async grant(entryId: string, trustWorkspace = false): Promise<{ action: string; entryId: string; token: string }> {
    this.assertEntry(entryId);
    const decision = { entryId, invalidated: false }; this.decisions.add(decision);
    try {
      const scope = this.scope(entryId), directory = trustWorkspace ? await this.manager.canonicalForTrust(entryId) : undefined;
      this.assertEntry(entryId); if (scope !== this.scope(entryId)) throw new Error("项目已改变，未签发授权");
      if (decision.invalidated) throw new Error("项目授权配置已改变，未签发授权");
      return { action: `${new URL(this.manager.config().publicOrigin).origin}/authorize`, entryId, token: this.authorization.grant(entryId, scope, trustWorkspace, directory) };
    } finally { this.decisions.delete(decision); }
  }
  pendingAccess() {
    return this.authorization.pending().flatMap(request => {
      try { const target = this.manager.resolve(request.entryId); return [{ ...request, hostId: target.hostId, projectName: target.projectName, workspace: target.workspace, scope: this.scope(request.entryId), url: new URL(`/workspace/${request.entryId}`, this.manager.config().publicOrigin).href }]; }
      catch { return []; }
    });
  }
  async approveAccess(requestId: string, entryId: string, trustWorkspace = false, beforeCommit?: () => void): Promise<void> {
    const decision = { entryId, invalidated: false }; this.decisions.add(decision);
    try {
      this.assertEntry(entryId); const scope = this.scope(entryId), directory = trustWorkspace ? await this.manager.canonicalForTrust(entryId) : undefined;
      this.assertEntry(entryId); if (scope !== this.scope(entryId)) throw new Error("项目已改变，未批准授权");
      if (decision.invalidated) throw new Error("项目授权配置已改变，未批准授权");
      beforeCommit?.();
      this.authorization.approve(requestId, entryId, scope, trustWorkspace, directory);
    } finally { this.decisions.delete(decision); }
  }
  rejectAccess(requestId: string, entryId: string): void {
    this.assertEntry(entryId); this.authorization.reject(requestId, entryId, this.scope(entryId));
  }
  private scope(entryId: string): string { return crypto.createHash("sha256").update(JSON.stringify(this.manager.resolve(entryId))).digest("hex"); }
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
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // no-referrer serializes form navigation Origin as "null" in Chromium,
    // which would (correctly) fail the strict Origin check below.
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!this.validHost(req)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url ?? "/", this.manager.config().publicOrigin);
    const entryId = /^\/(?:workspace|open|ide|logout)\/([a-f0-9]{32})(?:\/|$)/.exec(url.pathname)?.[1] ?? "";
    if (entryId) { try { this.manager.resolve(entryId); } catch { res.writeHead(404).end(); return; } }
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
        this.page(res, 410, "确认复制面板已失效", "申请已过期、已处理或已重新核对。请回到原浏览器获取当前命令，再在机器人私聊发送 /ide auth 识别码。没有批准任何浏览器。"); return;
      }
      try { this.assertEntry(preview.request.entryId); } catch { res.writeHead(410).end(); return; }
      const r = preview.request;
      this.page(res, 200, "二次确认 · 复制命令", "核对项目后，复制一种选择，回到刚才已登记的机器人私聊发送。此页只复制，不批准浏览器；转发本页不能取得审批资格。",
        `<p>浏览器识别码：<strong>${escape(r.code)}</strong><br>项目：${escape(r.projectName)}<br>主机：${escape(r.hostId)}<br>目录：${escape(r.workspace)}</p><p>IDE 具备运行用户的开发权限，不是文件系统沙箱。仅批准你本人发起的申请；批准后授权 15 天，可撤销。申请截止时间：<time datetime="${new Date(r.expiresAt).toISOString()}">${escape(new Date(r.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))}（北京时间）</time>。申请到期后命令不可再用，本页不会自动刷新打断复制。</p>${IDE_APPROVAL_CHOICES.map(c => `<section><h2>${escape(c.label)}</h2><p>${escape(c.detail)}</p>${copyField(`「${c.label}」命令`, ideConfirmationCommand(preview.shortCode, c.choice), 2)}</section>`).join("")}`); return;
    }
    // A one-use grant is posted from the local Gateway UI, never placed in a
    // URL or forwarded to code-server. No other cross-origin mutation is allowed.
    if (method === "POST" && url.pathname === "/authorize") {
      const authority = this.managementOrigin && new URL(this.managementOrigin);
      const allowed = authority && [this.managementOrigin, `http://localhost:${authority.port}`];
      if (!allowed || !allowed.includes(req.headers.origin)) { res.writeHead(403).end(); return; }
      const form = new URLSearchParams(await readBody(req)), id = form.get("entryId") ?? "";
      try { this.manager.resolve(id); } catch { res.writeHead(404).end(); return; }
      this.assertEntry(id);
      const access = this.authorization.consume(form.get("token") ?? "", id, this.scope(id));
      if (!access) { this.page(res, 401, "授权已失效", "请从 Gateway 管理页重新打开；授权只能使用一次。"); return; }
      this.setCookie(res, COOKIE + id, access.token, IDE_SESSION_TTL_MS / 1000);
      this.page(res, 200, "Gateway 已授权", `无需额外密码。本次授权仅用于当前项目，${IDE_SESSION_DAYS} 天内有效，Gateway 重启后仍保留；可在管理页随时撤销。${access.session.trustWorkspace ? "已一并允许当前目录的任务、调试及扩展运行。" : "本次只批准访问，未自动信任目录代码。"}`,
        `<a href="/workspace/${id}">进入项目 Web IDE</a>`); return;
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
        const pairCookie = this.cookie(req, `cig_request_${id}`)?.split(".");
        const approved = pairCookie?.length === 2 && this.authorization.exchangeRequest(pairCookie[0], pairCookie[1], id, this.scope(id));
        if (approved) { this.setCookie(res, COOKIE + id, approved.token, IDE_SESSION_TTL_MS / 1000); this.redirect(res, `/workspace/${id}`); return; }
        const pending = this.authorization.request(id, pairCookie?.length === 2 ? { id: pairCookie[0], proof: pairCookie[1] } : undefined, this.scope(id));
        this.setCookie(res, `cig_request_${id}`, `${pending.request.id}.${pending.proof}`, 300);
        const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(this.manager.config().publicOrigin).hostname);
        const offer = this.approvalCopies?.offer(pending.request.id, id);
        const choiceControls = offer
          ? `<p>项目：<strong>${escape(offer.request.projectName)}</strong><br>主机：${escape(offer.request.hostId)}<br>目录：${escape(offer.request.workspace)}</p><p>IDE 允许项目编辑和终端访问，具备运行用户的开发权限，不是文件系统沙箱。请选择一种权限，复制对应命令并在本人的机器人私聊发送一次；不会再要求第二条确认命令。</p>${IDE_APPROVAL_CHOICES.map(c => `<section><h2>${escape(c.label)}</h2><p>${escape(c.detail)}</p>${copyField(`「${c.label}」命令`, ideConfirmationCommand(offer.shortCode, c.choice), 2)}</section>`).join("")}`
          : `<p>一次确认命令暂未就绪，可使用兼容流程在机器人私聊核对申请。</p>${copyField("兼容流程：先核对申请", `/ide auth ${pending.request.code}`)}`;
        this.page(res, 200, "等待 Gateway 授权", "当前浏览器尚未授权，不代表管理员登记丢失。核对下方项目、主机、目录和权限，再复制所选命令发给对应机器人。无需 Web IDE 密码。",
          `<section data-ide-wait>${choiceControls}${copyField("浏览器识别码（仅核对用，无需单独发送）", pending.request.code)}</section><p>只批准你本人发起的申请。复制不会发送命令或批准访问；剪贴板受限时，可长按短命令复制或直接输入。</p><p>本次浏览器申请有效期为 5 分钟；批准后，浏览器访问授权有效期为 ${IDE_SESSION_DAYS} 天。管理员登记独立持久保存，不因 Gateway 重启失效，也不受这两个期限影响。</p><p>批准后本页会自动继续；复制操作期间暂缓刷新。</p><a href="/workspace/${id}">批准后继续</a><details data-ide-registration-help><summary>首次使用：如何登记审批管理员</summary><p>仅未登记的个人身份需要首次设置；已登记者无需重复操作。本页尚未验证你的钉钉身份，不判断你是否已登记。请在机器人私聊发送下方命令，查看本人真实登记状态。</p>${copyField("查询本人登记状态的命令", "/ide identity")}<p>命令确认未登记时，再到运行 Gateway 的电脑管理页「Web IDE → 授权管理员」登记个人 ID，不要填写群 ID。群白名单和 session 权限不等于 IDE 审批资格。</p>${this.managementOrigin && local ? `<p><a href="${escape(this.managementOrigin)}/#ide">打开本机 Gateway 管理页（仅运行 Gateway 的电脑）</a></p>` : ""}</details>`); return;
      }
      const target = this.manager.resolve(id);
      this.page(res, 200, target.projectName, `${target.hostId} · ${target.workspace}`,
        `<p>工作区目录：<code>${escape(target.workspace)}</code>。打开后左侧 Explorer 应显示此目录；单文件夹工作区不需要额外创建 .code-workspace 文件。</p><p>${session.trustWorkspace ? "Gateway 已授权并信任当前目录：此专属 IDE 实例允许任务、调试和扩展运行，不再弹出 VS Code 的二次信任确认。不会修改其他实例或全局 VS Code 设置。" : "本次仅批准访问，未信任目录代码；可在 Gateway 管理页选择「批准并信任此目录」后重新进入。"}</p><p>文件、终端和语言服务均在项目所在主机运行。打开 IDE 不会向 Codex 发新消息。此 IDE 具备运行用户的开发权限，不是文件系统沙箱。</p><form method="post" action="/open/${id}"><input type="hidden" name="csrf" value="${session.csrf}"><button>打开 Web IDE</button></form><form method="post" action="/logout/${id}"><input type="hidden" name="csrf" value="${session.csrf}"><button>退出授权</button></form>`); return;
    }
    const open = /^\/open\/([a-f0-9]{32})$/.exec(url.pathname);
    if (method === "POST" && open && session) {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("csrf") !== session.csrf) { res.writeHead(403).end(); return; }
      let instance;
      try { instance = await this.manager.open(open[1], session.trustWorkspace === true, session.trustedDirectory); }
      catch (error) {
        if (!(error instanceof IDEInstallPendingError)) throw error;
        this.page(res, 202, "正在准备 code-server", error.message, `<p><a href="/workspace/${open[1]}">准备完成后重试打开</a></p>`); return;
      }
      if (!this.authorization.active(session)) { res.writeHead(401).end(); return; }
      const destination = `/ide/${open[1]}/?folder=${encodeURIComponent(instance.workspace)}`;
      if (instance.profile?.warning) {
        this.page(res, 200, "IDE 已启动，配置需要处理", instance.profile.warning === "settings-unmodified"
          ? "原 settings.json 无法安全补充，已保留原文件；请在 IDE 设置中检查。"
          : "所选扩展未准备完成，编辑器仍可使用。请在 Gateway 管理页查看未就绪项，检查 Open VSX 网络、扩展兼容性及目录权限，停止该 IDE 后重试准备扩展。",
        `<p>不会重新执行 Codex 任务或改变绑定。</p><a href="${escape(destination)}">仍然进入 Web IDE</a>`); return;
      }
      this.redirect(res, destination); return;
    }
    const ide = /^\/ide\/([a-f0-9]{32})(\/.*)$/.exec(url.pathname);
    if (ide) {
      if (!session) { this.redirect(res, `/workspace/${ide[1]}`); return; }
      const endpoint = this.manager.endpoint(ide[1], session.trustWorkspace === true);
      if (!endpoint) { this.redirect(res, `/workspace/${ide[1]}`); return; }
      if (session.trustWorkspace && ide[2] === "/") {
        const folders = url.searchParams.getAll("folder");
        if (url.searchParams.has("workspace") || url.searchParams.has("ew") || folders.length > 1 || (folders.length === 1 && folders[0] !== endpoint.workspace)) {
          this.page(res, 403, "目录未获本次授权", "此授权仅用于当前项目目录；请从 Gateway 中打开其他项目。"); return;
        }
        if (!folders.length) { this.redirect(res, `${url.pathname}?folder=${encodeURIComponent(endpoint.workspace)}`); return; }
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
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", this.manager.config().publicOrigin), match = /^\/ide\/([a-f0-9]{32})(\/.*)$/.exec(url.pathname);
    if (!match) { socket.destroy(); return; }
    const session = this.authenticate(req, match[1]);
    if (!this.validHost(req) || !this.validOrigin(req) || !session) { socket.destroy(); return; }
    const endpoint = this.manager.endpoint(match[1], session.trustWorkspace === true); if (!endpoint) { socket.destroy(); return; }
    this.track(socket, session, endpoint.instanceId);
    const upstream = http.request({ socketPath: endpoint.socketPath, path: match[2] + url.search, headers: this.proxyHeaders(req) });
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.on("upgrade", (res, remote, remoteHead) => {
      remote.setTimeout(0);
      if (!this.authorization.active(session)) { remote.destroy(); socket.destroy(); return; }
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
    const verify = () => {
      try {
        if (!this.authorization.active(session) || session.scope !== this.scope(session.entryId)) { socket.destroy(); return; }
        const entry = this.connections.get(socket); if (!entry) return;
        entry.timer = setTimeout(verify, Math.max(1, Math.min(30_000, session.expiresAt - Date.now()))); entry.timer.unref();
      } catch { socket.destroy(); }
    };
    const timer = setTimeout(verify, Math.max(1, Math.min(30_000, session.expiresAt - Date.now()))); timer.unref();
    this.connections.set(socket, { session, instanceId, timer });
    if (!previous) socket.once("close", () => { const entry = this.connections.get(socket); if (entry) clearTimeout(entry.timer); this.connections.delete(socket); });
  }
  private redirect(res: ServerResponse, location: string): void { res.writeHead(303, { Location: location }).end(); }
  private page(res: ServerResponse, status: number, title: string, text: string, body = ""): void {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const nonce = crypto.randomBytes(16).toString("base64");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    res.writeHead(status).end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:10vh auto;max-width:620px;padding:24px;color:#25342d;background:#f6f8f5;font:17px Georgia,serif}h1{font-size:30px}p{line-height:1.7;overflow-wrap:anywhere}label{display:grid;gap:8px}input,button{font:inherit;padding:12px;margin:12px 0}button{background:#214f3a;color:white;border:0;border-radius:6px;cursor:pointer}input{border:1px solid #aab7af}${COPY_STYLE}</style><h1>${escape(title)}</h1><p>${escape(text)}</p>${body}<script nonce="${nonce}">${COPY_SCRIPT}</script></html>`);
  }
}
async function readBody(req: IncomingMessage): Promise<string> {
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { length += chunk.length; if (length > 4096) throw new Error("请求过大"); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString("utf8");
}
