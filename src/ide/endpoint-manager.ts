import crypto from "node:crypto";
import path from "node:path";
import { IDEAccessServer, type IDEAccessContext } from "./access-server.js";
import { ideConfigSchema, type IDEConfig } from "./config.js";
import { IDETLSManager, loadIDETLS, localIDEAddresses } from "./tls.js";
import type { WorkspaceIDEManager } from "./manager.js";
import { RemoteIDEIngress, type IDEIngressIO, type IDEIngressState } from "./remote-ingress.js";
import type { IDEApprovalCopyPort } from "./approval-service.js";
import type { IDEAccessAuthority, IDEAccessSubject } from "./access-subject.js";
import { entrances, LOCAL_DIRECT_ENDPOINT, publicationKey, runtimeChanges, type IDEEntrance } from "./reconfiguration.js";
import { resolveLocalIDEAccess } from "./local-address.js";

export type IDEEndpointStatus = { hostId: string; publicOrigin: string; shared?: boolean; localDirect?: boolean; interfaceName?: string; state: "starting" | "ready" | "error" | "connecting" | "reconnecting";
  error?: string };
type Endpoint = { server: IDEAccessServer; context: IDEAccessContext; config: IDEConfig; fingerprint: string;
  status: IDEEndpointStatus; ingress?: RemoteIDEIngress };

/** Desired-state coordinator. Listeners/relays, project processes and browser
 * grants are separate resources: adding a backend never restarts the ingress. */
export class IDEEndpointManager {
  readonly tls: IDETLSManager;
  private readonly endpoints = new Map<string | symbol, Endpoint>();
  private applied?: IDEConfig;
  private transition: Promise<void> = Promise.resolve();
  private managementOrigin?: string;
  private approvalCopies?: IDEApprovalCopyPort;
  private accessAuthority?: IDEAccessAuthority;
  private networkTimer?: ReturnType<typeof setInterval>;
  private networkQueued = false;
  private stopped = false;
  error?: string;
  constructor(private readonly manager: WorkspaceIDEManager, private readonly options: { ingressIO?: IDEIngressIO; ingressTiming?: { retryMs: number; probeMs: number };
    localAddresses?: typeof localIDEAddresses; networkPollMs?: number } = {}) {
    this.tls = new IDETLSManager(path.join(path.dirname(manager.configStore.filePath), "tls"));
    manager.accessAvailable = false;
    manager.accessOrigin = hostId => {
      const config = manager.config();
      const endpoint = this.endpoints.get(publicationKey(config, hostId));
      return endpoint && this.endpointStatus(endpoint).state === "ready" && endpoint.server.running() ? endpoint.status.publicOrigin : undefined;
    };
    manager.onStop = id => { for (const endpoint of this.endpoints.values()) endpoint.context.onStop?.(id); };
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.transition.catch(() => {}).then(work); this.transition = next; return next;
  }
  reload(revoke = false): Promise<void> { return this.enqueue(() => {
    this.stopped = false;
    return this.applyDesired(this.manager.config(), revoke);
  }); }
  /** Validate, revoke affected scopes, persist and reconcile in one queue.
   * Concurrent HTTP saves cannot overwrite the config a previous apply uses.
   * Failed durable revocation prevents the new policy from being committed. */
  configure(input: IDEConfig): Promise<void> {
    const config = ideConfigSchema.parse(input);
    return this.enqueue(async () => {
      this.stopped = false;
      const desired = this.resolveConfig(config);
      await this.validateConfig(desired);
      await this.apply(desired, false, () => this.manager.configStore.save(desired));
    });
  }
  private resolveConfig(config: IDEConfig): IDEConfig {
    if (!config.localAccess?.interfaceName) return config;
    try { return ideConfigSchema.parse({ ...config, localAccess: resolveLocalIDEAccess(config.localAccess, this.addresses()) }); }
    catch { return config; } // Existing offline interfaces must not block other hosts.
  }
  private addresses() { return (this.options.localAddresses ?? localIDEAddresses)(); }
  private applyDesired(config: IDEConfig, revoke: boolean): Promise<void> {
    const desired = this.resolveConfig(config);
    return this.apply(desired, revoke, JSON.stringify(desired) !== JSON.stringify(config) ? () => this.manager.configStore.save(desired) : undefined);
  }
  /** Serialized with config saves/close. The timer never overlaps itself or
   * rewrites a newer user policy captured before an asynchronous transition. */
  refreshLocalAddress(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      const config = this.manager.config();
      if (!config.enabled || !config.localAccess?.interfaceName || !config.hosts.some(h => h.hostId === "local" && h.enabled)) return;
      const desired = this.resolveConfig(config), endpoint = this.endpoints.get(LOCAL_DIRECT_ENDPOINT);
      if (JSON.stringify(desired) !== JSON.stringify(config) || !endpoint || this.endpointStatus(endpoint).state !== "ready")
        await this.applyDesired(config, false);
    });
  }
  private watchNetwork(config: IDEConfig): void {
    if (this.networkTimer) clearInterval(this.networkTimer);
    this.networkTimer = undefined;
    if (this.stopped || !config.enabled || !config.localAccess?.interfaceName || !config.hosts.some(h => h.hostId === "local" && h.enabled)) return;
    this.networkTimer = setInterval(() => {
      if (this.networkQueued) return;
      this.networkQueued = true;
      void this.refreshLocalAddress().catch(() => {
        const endpoint = this.endpoints.get(LOCAL_DIRECT_ENDPOINT);
        if (endpoint) endpoint.status = { ...endpoint.status, state: "error", error: "本机网卡地址更新失败，后台继续重试。" };
      }).finally(() => { this.networkQueued = false; });
    }, this.options.networkPollMs ?? 3000);
    this.networkTimer.unref();
  }
  async validateConfig(config: IDEConfig): Promise<void> {
    if (config.enabled && config.hosts.some(h => h.hostId === "local" && h.enabled) && config.localAccess) {
      // An offline existing local address must not block unrelated remote
      // hot-adds. A new/changed binding is always validated before commit.
      if (JSON.stringify(config.localAccess) !== JSON.stringify(this.applied?.localAccess)) this.requireLocalBinding(config);
      await this.tls.prepare(config.localAccess.bindAddress);
    }
    if (config.tls) {
      if (this.tls.owns(config.tls)) await this.tls.prepare(config.tls.certificateAddress ?? config.tls.bindAddress);
      loadIDETLS(config.tls, config.publicOrigin);
    }
    if (config.routing === "per-host") for (const host of config.hosts.filter(h => h.enabled && h.access))
      await this.tls.prepare(new URL(host.access!.publicOrigin).hostname.replace(/^\[|\]$/g, ""));
  }
  async prepareTLS(address: string) {
    this.requireLocalAddress(address);
    return this.tls.prepare(address);
  }
  private requireLocalAddress(address: string): void {
    if (!this.addresses().some(item => item.address === address))
      throw new Error("所选本机 IP 当前未分配；请在管理页重新选择内网/VPN 地址，不会自动回退到其他入口");
  }
  private requireLocalBinding(config: IDEConfig): void {
    const access = config.localAccess!;
    if (access.interfaceName && resolveLocalIDEAccess(access, this.addresses()).bindAddress !== access.bindAddress)
      throw new Error(`网卡 ${access.interfaceName} 的 IPv4 地址已变化，正在自动更新入口。`);
    this.requireLocalAddress(access.bindAddress);
  }
  private endpointStatus(record: Endpoint): IDEEndpointStatus {
    if (record.status.localDirect) {
      const interfaceName = record.config.localAccess?.interfaceName;
      try { this.requireLocalBinding(record.config); }
      catch (error) { return { ...record.status, interfaceName, state: "error", error: interfaceName ? (error as Error).message : "本机直连 IP 当前已离线或发生变化；请重新选择地址。旧 IP 链接无法自动恢复，不会改发回环或远程入口。" }; }
      return { ...record.status, interfaceName };
    }
    return { ...record.status };
  }
  private async apply(config: IDEConfig, revoke: boolean, commit?: () => void): Promise<void> {
    const desired = new Map(entrances(config).map(spec => [spec.key, spec]));
    const { stopHosts } = runtimeChanges(this.applied, config);
    // Synchronous pre-commit phase: no late approval can restore a revoked
    // request, including async canonical-directory lookups already in flight.
    for (const [key, record] of this.endpoints) {
      const spec = desired.get(key);
      record.server.revokeEntries(id => {
        if (revoke || !spec || spec.fingerprint !== record.fingerprint) return true;
        try {
          const target = this.manager.resolve(id);
          return stopHosts.has(target.hostId) || !spec.config.hosts.some(h => h.enabled && h.hostId === target.hostId);
        } catch { return true; }
      });
    }
    commit?.();
    const previous = this.applied; this.error = undefined;
    this.manager.resume();
    const processes = this.manager.reconfigure(previous, config);
    const closing: Promise<void>[] = [];
    for (const [key, record] of this.endpoints) {
      const spec = desired.get(key);
      if (spec?.fingerprint === record.fingerprint && record.server.running() && !record.server.error
        && (!record.status.localDirect || this.endpointStatus(record).state !== "error")) {
        // A retained listener reads this mutable desired policy, not a closure
        // over its startup host list. TLS identity and port remain unchanged.
        record.config = { ...spec.config, tls: record.config.tls };
        record.status.shared = Boolean(spec.hostId && config.sharedIngressHostId === spec.hostId) || undefined;
      } else {
        this.endpoints.delete(key); closing.push(this.closeEndpoint(record));
      }
    }
    await Promise.all([processes, ...closing]);
    if (!config.enabled) { this.manager.accessAvailable = false; this.applied = config; this.watchNetwork(config); return; }
    await Promise.all([...desired.values()].filter(spec => !this.endpoints.has(spec.key)).map(spec => this.startEndpoint(spec)));
    this.applied = config;
    this.watchNetwork(config);
  }
  private async startEndpoint(spec: IDEEntrance): Promise<void> {
    const hostId = spec.hostId, record = {} as Endpoint;
    Object.assign(record, { fingerprint: spec.fingerprint, config: spec.config,
      status: { hostId: hostId ?? "local", publicOrigin: spec.config.publicOrigin,
        ...(spec.localDirect ? { localDirect: true } : {}),
        ...(hostId && spec.config.sharedIngressHostId === hostId ? { shared: true } : {}), state: "starting" } });
    const resolve = (id: string) => {
      const target = this.manager.resolve(id), current = this.manager.config();
      if (!current.enabled || !current.hosts.some(h => h.hostId === target.hostId && h.enabled)
        || !record.config.hosts.some(h => h.hostId === target.hostId && h.enabled)) throw new Error("项目不属于此入口的已启用主机");
      return target;
    };
    record.context = {
      configStore: this.manager.configStore, config: () => record.config, resolve,
      refresh: async id => { resolve(id); await this.manager.refresh(id); return resolve(id); },
      authorizationFile: () => spec.localDirect ? path.join(path.dirname(this.manager.authorizationFile()), "authorization-local-direct.json")
        : hostId ? path.join(path.dirname(this.manager.authorizationFile()), `authorization-${hostKey(hostId)}.json`) : this.manager.authorizationFile(),
      canonicalForTrust: id => { resolve(id); return this.manager.canonicalForTrust(id); },
      open: (id, trust, directory, roots) => { resolve(id); return this.manager.open(id, trust, directory, roots); },
      endpoint: (id, trust) => { resolve(id); return this.manager.endpoint(id, trust); },
      resume: () => this.manager.resume(), close: async () => {}
    };
    record.server = new IDEAccessServer(record.context);
    if (this.accessAuthority) record.server.setAccessAuthority(this.accessAuthority);
    record.server.setApprovalCopies(this.approvalCopies);
    if (this.managementOrigin) record.server.setManagementOrigin(this.managementOrigin);
    this.endpoints.set(spec.key, record);
    try {
      record.server.revokeEntries(id => { try { resolve(id); return false; } catch { return true; } });
      if (spec.localDirect) {
        this.requireLocalBinding(record.config);
        const files = await this.tls.prepare(record.config.localAccess!.bindAddress);
        record.config = { ...record.config, tls: files };
      } else if (hostId && hostId !== "local") {
        const certificateAddress = new URL(record.config.publicOrigin).hostname.replace(/^\[|\]$/g, "");
        const files = await this.tls.prepare(certificateAddress);
        record.config = { ...record.config, tls: { ...files, bindAddress: "127.0.0.1", certificateAddress } };
      }
      await record.server.reload(false);
      if (record.server.error) throw new Error("Endpoint authorization or listener unavailable");
      if (!hostId || hostId === "local") record.status.state = "ready";
      else {
        const host = spec.config.hosts.find(h => h.hostId === hostId)!;
        record.ingress = new RemoteIDEIngress({ installation: path.dirname(this.manager.configStore.filePath), hostId,
          access: host.access!, localPort: record.server.port()!, ca: this.tls.caCertificate() }, (state: IDEIngressState) => {
            if (this.endpoints.get(spec.key) === record) record.status = { ...record.status, ...state };
          }, this.options.ingressIO, this.options.ingressTiming);
        record.ingress.start();
      }
    } catch {
      record.status = { ...record.status, state: "error", error: "此入口启动失败；请检查证书、监听端口及本机目录权限，其他入口不受影响。" };
      if (!hostId) this.error = record.server.error ?? record.status.error;
    }
  }
  running(): boolean { return [...this.endpoints.values()].some(e => this.endpointStatus(e).state === "ready" && e.server.running()); }
  statuses(): IDEEndpointStatus[] { return this.applied?.routing === "per-host" ? [...this.endpoints.values()].map(e => this.endpointStatus(e)) : []; }
  certificate() {
    const config = this.manager.config();
    const tls = config.tls ?? [...this.endpoints.values()].find(e => e.config.tls)?.config.tls;
    return this.tls.details(tls);
  }
  setManagementOrigin(origin: string): void {
    this.managementOrigin = origin;
    for (const endpoint of this.endpoints.values()) endpoint.server.setManagementOrigin(origin);
  }
  setApprovalCopies(port: IDEApprovalCopyPort | undefined): void {
    this.approvalCopies = port;
    for (const endpoint of this.endpoints.values()) endpoint.server.setApprovalCopies(port);
  }
  setAccessAuthority(authority: IDEAccessAuthority): void {
    this.accessAuthority = authority;
    for (const endpoint of this.endpoints.values()) endpoint.server.setAccessAuthority(authority);
  }
  reconcileAccess(): void {
    const errors: unknown[] = [];
    for (const endpoint of this.endpoints.values()) try { endpoint.server.reconcileAccess(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "部分 IDE 授权撤销记录写入失败；访问已拒绝，请重试");
  }
  private serverFor(id: string): IDEAccessServer {
    const target = this.manager.resolve(id), config = this.manager.config();
    const endpoint = this.endpoints.get(publicationKey(config, target.hostId));
    if (!endpoint || this.endpointStatus(endpoint).state !== "ready") throw new Error("此项目的浏览器入口尚未就绪；请查看 Web IDE 入口状态，后台正在重连。不会改用其他地址。");
    return endpoint.server;
  }
  grant(id: string, trustWorkspace = false, expectedScope?: string) { return this.serverFor(id).grant(id, trustWorkspace, expectedScope); }
  private requestServer(requestId: string, id: string): IDEAccessServer {
    const matches = [...this.endpoints.values()].filter(({ server }) => server.pendingAccess().some(request => request.id === requestId && request.entryId === id));
    if (matches.length !== 1) throw new Error("浏览器申请已失效或不唯一，请刷新后重新申请");
    return matches[0].server;
  }
  async approveAccess(requestId: string, id: string, trustWorkspace = false, beforeCommit?: () => void, subject?: IDEAccessSubject) { return this.requestServer(requestId, id).approveAccess(requestId, id, trustWorkspace, beforeCommit, subject); }
  rejectAccess(requestId: string, id: string) { this.requestServer(requestId, id).rejectAccess(requestId, id); }
  pendingAccess() {
    return [...this.endpoints.values()].flatMap(e => e.server.pendingAccess()).flatMap(request => {
      try { return [{ ...request, accountId: this.manager.accountForEntry(request.entryId) }]; } catch { return []; }
    });
  }
  revoke(): void { for (const endpoint of this.endpoints.values()) endpoint.server.revoke(); }
  close(): Promise<void> {
    this.stopped = true;
    if (this.networkTimer) clearInterval(this.networkTimer);
    this.networkTimer = undefined;
    return this.enqueue(async () => {
      this.manager.accessAvailable = false;
      const records = [...this.endpoints.values()]; this.endpoints.clear();
      await Promise.all(records.map(record => this.closeEndpoint(record)));
      await this.manager.close(); this.applied = undefined;
    });
  }
  private async closeEndpoint(record: Endpoint): Promise<void> { try { await record.ingress?.close(); } finally { await record.server.close(); } }
}
function hostKey(hostId: string): string { return crypto.createHash("sha256").update(hostId).digest("hex").slice(0, 24); }
