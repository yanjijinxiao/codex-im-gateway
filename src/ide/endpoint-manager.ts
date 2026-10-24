import crypto from "node:crypto";
import path from "node:path";
import { IDEAccessServer, type IDEAccessContext } from "./access-server.js";
import { ideConfigSchema, type IDEConfig } from "./config.js";
import { IDETLSManager, loadIDETLS, localIDEAddresses } from "./tls.js";
import type { WorkspaceIDEManager } from "./manager.js";
import { RemoteIDEIngress, type IDEIngressIO, type IDEIngressState } from "./remote-ingress.js";
import type { IDEApprovalCopyPort } from "./approval-service.js";
import { entrances, runtimeChanges, type IDEEntrance } from "./reconfiguration.js";

export type IDEEndpointStatus = { hostId: string; publicOrigin: string; shared?: boolean; state: "starting" | "ready" | "error" | "connecting" | "reconnecting";
  error?: string };
type Endpoint = { server: IDEAccessServer; context: IDEAccessContext; config: IDEConfig; fingerprint: string;
  status: IDEEndpointStatus; ingress?: RemoteIDEIngress };

/** Desired-state coordinator. Listeners/relays, project processes and browser
 * grants are separate resources: adding a backend never restarts the ingress. */
export class IDEEndpointManager {
  readonly tls: IDETLSManager;
  private readonly endpoints = new Map<string, Endpoint>();
  private applied?: IDEConfig;
  private transition: Promise<void> = Promise.resolve();
  private managementOrigin?: string;
  private approvalCopies?: IDEApprovalCopyPort;
  error?: string;
  constructor(private readonly manager: WorkspaceIDEManager, private readonly options: { ingressIO?: IDEIngressIO; ingressTiming?: { retryMs: number; probeMs: number } } = {}) {
    this.tls = new IDETLSManager(path.join(path.dirname(manager.configStore.filePath), "tls"));
    manager.accessAvailable = false;
    manager.accessOrigin = hostId => {
      const config = manager.config();
      const endpoint = this.endpoints.get(config.routing === "per-host" ? config.sharedIngressHostId ?? hostId : "legacy");
      return endpoint?.status.state === "ready" && endpoint.server.running() ? endpoint.status.publicOrigin : undefined;
    };
    manager.onStop = id => { for (const endpoint of this.endpoints.values()) endpoint.context.onStop?.(id); };
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.transition.catch(() => {}).then(work); this.transition = next; return next;
  }
  reload(revoke = false): Promise<void> { return this.enqueue(() => this.apply(this.manager.config(), revoke)); }
  /** Validate, revoke affected scopes, persist and reconcile in one queue.
   * Concurrent HTTP saves cannot overwrite the config a previous apply uses.
   * Failed durable revocation prevents the new policy from being committed. */
  configure(input: IDEConfig): Promise<void> {
    const config = ideConfigSchema.parse(input);
    return this.enqueue(async () => {
      await this.validateConfig(config);
      await this.apply(config, false, () => this.manager.configStore.save(config));
    });
  }
  async validateConfig(config: IDEConfig): Promise<void> {
    if (config.tls) {
      if (this.tls.owns(config.tls)) await this.tls.prepare(config.tls.certificateAddress ?? config.tls.bindAddress);
      loadIDETLS(config.tls, config.publicOrigin);
    }
    if (config.routing === "per-host") for (const host of config.hosts.filter(h => h.enabled && h.access))
      await this.tls.prepare(new URL(host.access!.publicOrigin).hostname.replace(/^\[|\]$/g, ""));
  }
  async prepareTLS(address: string) {
    if (!localIDEAddresses().some(item => item.address === address)) throw new Error("请选择 Gateway 本机当前已分配的内网/VPN 地址");
    return this.tls.prepare(address);
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
      if (spec?.fingerprint === record.fingerprint && record.server.running() && !record.server.error) {
        // A retained listener reads this mutable desired policy, not a closure
        // over its startup host list. TLS identity and port remain unchanged.
        record.config = { ...spec.config, tls: record.config.tls };
        record.status.shared = Boolean(spec.hostId && config.sharedIngressHostId === spec.hostId) || undefined;
      } else {
        this.endpoints.delete(key); closing.push(this.closeEndpoint(record));
      }
    }
    await Promise.all([processes, ...closing]);
    if (!config.enabled) { this.manager.accessAvailable = false; this.applied = config; return; }
    await Promise.all([...desired.values()].filter(spec => !this.endpoints.has(spec.key)).map(spec => this.startEndpoint(spec)));
    this.applied = config;
  }
  private async startEndpoint(spec: IDEEntrance): Promise<void> {
    const hostId = spec.hostId, record = {} as Endpoint;
    Object.assign(record, { fingerprint: spec.fingerprint, config: spec.config,
      status: { hostId: hostId ?? "local", publicOrigin: spec.config.publicOrigin,
        ...(hostId && spec.config.sharedIngressHostId === hostId ? { shared: true } : {}), state: "starting" } });
    const resolve = (id: string) => {
      const target = this.manager.resolve(id), current = this.manager.config();
      if (!current.enabled || !current.hosts.some(h => h.hostId === target.hostId && h.enabled)
        || !record.config.hosts.some(h => h.hostId === target.hostId && h.enabled)) throw new Error("项目不属于此入口的已启用主机");
      return target;
    };
    record.context = {
      configStore: this.manager.configStore, config: () => record.config, resolve,
      authorizationFile: () => hostId ? path.join(path.dirname(this.manager.authorizationFile()), `authorization-${hostKey(hostId)}.json`) : this.manager.authorizationFile(),
      canonicalForTrust: id => { resolve(id); return this.manager.canonicalForTrust(id); },
      open: (id, trust, directory) => { resolve(id); return this.manager.open(id, trust, directory); },
      endpoint: (id, trust) => { resolve(id); return this.manager.endpoint(id, trust); },
      resume: () => this.manager.resume(), close: async () => {}
    };
    record.server = new IDEAccessServer(record.context);
    record.server.setApprovalCopies(this.approvalCopies);
    if (this.managementOrigin) record.server.setManagementOrigin(this.managementOrigin);
    this.endpoints.set(spec.key, record);
    try {
      record.server.revokeEntries(id => { try { resolve(id); return false; } catch { return true; } });
      if (hostId && hostId !== "local") {
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
  running(): boolean { return [...this.endpoints.values()].some(e => e.status.state === "ready" && e.server.running()); }
  statuses(): IDEEndpointStatus[] { return this.applied?.routing === "per-host" ? [...this.endpoints.values()].map(e => ({ ...e.status })) : []; }
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
  private serverFor(id: string): IDEAccessServer {
    const target = this.manager.resolve(id), config = this.manager.config();
    const endpoint = this.endpoints.get(config.routing === "per-host" ? config.sharedIngressHostId ?? target.hostId : "legacy");
    if (!endpoint || endpoint.status.state !== "ready") throw new Error("此项目的浏览器入口尚未就绪；请查看 Web IDE 入口状态，后台正在重连。不会改用其他地址。");
    return endpoint.server;
  }
  grant(id: string, trustWorkspace = false) { return this.serverFor(id).grant(id, trustWorkspace); }
  private requestServer(requestId: string, id: string): IDEAccessServer {
    const matches = [...this.endpoints.values()].filter(({ server }) => server.pendingAccess().some(request => request.id === requestId && request.entryId === id));
    if (matches.length !== 1) throw new Error("浏览器申请已失效或不唯一，请刷新后重新申请");
    return matches[0].server;
  }
  async approveAccess(requestId: string, id: string, trustWorkspace = false, beforeCommit?: () => void) { return this.requestServer(requestId, id).approveAccess(requestId, id, trustWorkspace, beforeCommit); }
  rejectAccess(requestId: string, id: string) { this.requestServer(requestId, id).rejectAccess(requestId, id); }
  pendingAccess() {
    return [...this.endpoints.values()].flatMap(e => e.server.pendingAccess()).flatMap(request => {
      try { return [{ ...request, accountId: this.manager.accountForEntry(request.entryId) }]; } catch { return []; }
    });
  }
  revoke(): void { for (const endpoint of this.endpoints.values()) endpoint.server.revoke(); }
  close(): Promise<void> {
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
