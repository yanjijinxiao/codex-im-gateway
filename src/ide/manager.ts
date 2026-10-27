import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IDEConfigStore, type IDEConfig } from "./config.js";
import { ProcessIDEHostTransport, type IDEHostTransport, type IDELaunch } from "./transport.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { CodeServerInstaller, type IDEInstallerIO } from "./installer.js";
import type { IDEProfileStatus } from "./profile.js";
import { runtimeChanges } from "./reconfiguration.js";
import { workspaceAuthorizationScope } from "./workspace-scope.js";

export type IDEWorkspace = { owner: string; sessionId: string; hostId: string; workspace: string; projectName: string;
  projectId?: string; nativeThreadId?: string; rootPaths?: readonly string[] };
export type IDECanonicalWorkspace = { workspace: string; rootPaths?: readonly string[] };
type Reference = { accountId: string; sessionId: string; identity?: string; sessionIds?: string[] };
type Instance = { id: string; hostId: string; workspace: string; status: "starting" | "running" | "error" | "stopped";
  error?: string; launch?: IDELaunch; lastUsedAt: number; trustWorkspace?: boolean; profile?: IDEProfileStatus;
  rootPaths?: readonly string[]; workspaceFile?: string };
export type IDEInstanceStatus = Omit<Instance, "launch">;
export class WorkspaceIDEManager {
  readonly configStore: IDEConfigStore;
  readonly installer: CodeServerInstaller;
  private readonly references: Record<string, Reference>;
  private readonly referencePath: string;
  private readonly instances = new Map<string, Instance>();
  private readonly pending = new Map<string, Promise<Instance>>();
  private readonly cancellations = new Map<string, { controller: AbortController; hostId: string }>();
  private readonly hostGenerations = new Map<string, number>();
  private readonly reconfiguring = new Set<string>();
  private readonly transport: IDEHostTransport;
  private generation = 0;
  private closing = false;
  accessAvailable?: boolean;
  accessOrigin?: (hostId: string) => string | undefined;
  private referenceError = false;
  onStop?: (instanceId: string) => void;
  constructor(private readonly options: { root: string; resolve: (accountId: string, sessionId: string) => IDEWorkspace | undefined;
    refresh?: (accountId: string, sessionId: string) => Promise<IDEWorkspace | undefined>;
    transport?: IDEHostTransport; readyTimeoutMs?: number; installerIO?: IDEInstallerIO }) {
    this.configStore = new IDEConfigStore(options.root);
    this.installer = new CodeServerInstaller(options.root, { io: options.installerIO,
      allowed: hostId => { const config = this.config(); return !this.closing && !this.reconfiguring.has(hostId)
        && config.enabled && config.hosts.some(h => h.hostId === hostId && h.enabled && h.autoInstall); } });
    this.referencePath = path.join(options.root, "ide", "workspaces.json");
    try {
      const references = readJsonFile<Record<string, Reference>>(this.referencePath, {});
      if (!references || Array.isArray(references) || typeof references !== "object"
        || Object.entries(references).some(([id, value]) => !/^[a-f0-9]{32}$/.test(id)
          || !value || typeof value.accountId !== "string" || typeof value.sessionId !== "string"
          || value.identity !== undefined && !/^[a-f0-9]{32}$/.test(value.identity)
          || value.sessionIds !== undefined && (!Array.isArray(value.sessionIds) || value.sessionIds.some(id => typeof id !== "string")))) throw new Error("Invalid IDE references");
      this.references = references;
    }
    catch { this.references = {}; this.referenceError = true; }
    this.transport = options.transport ?? new ProcessIDEHostTransport({ localDataRoot: path.join(options.root, "ide", "instances") });
  }
  entry(accountId: string, sessionId: string): { id: string; url: string } | undefined {
    const config = this.configStore.config();
    const target = this.options.resolve(accountId, sessionId);
    if (!config.enabled || !target || !config.hosts.some(h => h.hostId === target.hostId && h.enabled)) return;
    const origin = this.accessOrigin ? this.accessOrigin(target.hostId) : this.accessAvailable === false ? undefined
      : target.hostId === "local" && config.localAccess?.interfaceName ? undefined
      : config.routing === "per-host" && target.hostId === "local" && config.localAccess ? config.localAccess.publicOrigin
      : config.routing === "per-host" && config.sharedIngressHostId ? config.hosts.find(h => h.hostId === config.sharedIngressHostId)?.access?.publicOrigin
      : config.routing === "per-host" && target.hostId !== "local" ? config.hosts.find(h => h.hostId === target.hostId)?.access?.publicOrigin : config.publicOrigin;
    if (!origin) return;
    if (this.referenceError) throw new Error("IDE 入口记录无法读取，请检查专用状态文件；未覆盖旧记录");
    // Project/worktree identity is stable across IM edges and native threads.
    // Roots are an authorization scope, not URL identity: expanding them keeps
    // the link but requires a fresh grant. Legacy references remain readable.
    const identity = target.projectId ? this.entryIdentity(accountId, target) : undefined;
    const id = identity ?? digest([accountId, sessionId]);
    const reference = this.references[id];
    if (!reference) {
      this.references[id] = { accountId, sessionId, ...(identity ? { identity, sessionIds: [sessionId] } : {}) };
      writeJsonFile(this.referencePath, this.references);
    } else if (identity && !reference.sessionIds?.includes(sessionId)) {
      reference.sessionIds = [...new Set([reference.sessionId, ...(reference.sessionIds ?? []), sessionId])];
      writeJsonFile(this.referencePath, this.references);
    }
    return { id, url: `${new URL(origin).origin}/workspace/${id}` };
  }
  async freshEntry(accountId: string, sessionId: string): Promise<{ id: string; url: string } | undefined> {
    if (!this.configStore.config().enabled) return;
    if (this.options.refresh && !await this.options.refresh(accountId, sessionId)) return;
    return this.entry(accountId, sessionId);
  }
  private entryIdentity(accountId: string, target: IDEWorkspace): string {
    return digest(["project-entry-v1", accountId, target.owner, target.hostId, target.projectId, target.workspace]);
  }
  private referenceTarget(id: string): { reference: Reference; sessionId: string; target: IDEWorkspace } {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("IDE 入口不存在");
    const reference = this.references[id];
    if (reference) for (const sessionId of new Set([reference.sessionId, ...(reference.sessionIds ?? [])])) {
      const target = this.options.resolve(reference.accountId, sessionId);
      if (target && (!reference.identity || this.entryIdentity(reference.accountId, target) === reference.identity)) {
        // Pin legacy references on their first validated use. Keep their old
        // authorization shape, but never follow a later session/project move.
        if (!reference.identity && target.projectId) {
          reference.identity = this.entryIdentity(reference.accountId, target);
          writeJsonFile(this.referencePath, this.references);
        }
        return { reference, sessionId, target };
      }
    }
    throw new Error("项目或 session 已移除，IDE 入口失效");
  }
  /** Validate through the same native boundary as link creation and startup.
   * Unknown observations fail closed and do not rewrite stored membership. */
  async refresh(id: string): Promise<IDEWorkspace> {
    const { reference, sessionId } = this.referenceTarget(id);
    for (const candidate of new Set([sessionId, reference.sessionId, ...(reference.sessionIds ?? [])])) {
      const before = this.options.resolve(reference.accountId, candidate);
      if (!before || reference.identity && this.entryIdentity(reference.accountId, before) !== reference.identity) continue;
      // Undefined means confirmed absence/archive. An unknown/failed read must
      // reject, never silently authorize through another alias's cached state.
      const current = this.options.refresh ? await this.options.refresh(reference.accountId, candidate) : before;
      if (!current || reference.identity && this.entryIdentity(reference.accountId, current) !== reference.identity) continue;
      const fresh = this.options.resolve(reference.accountId, candidate);
      if (!fresh || reference.identity && this.entryIdentity(reference.accountId, fresh) !== reference.identity) continue;
      if (reference.identity === id && reference.sessionId !== candidate) {
        reference.sessionId = candidate; writeJsonFile(this.referencePath, this.references);
      }
      const latest = this.resolve(id);
      return reference.identity === id ? latest : current;
    }
    throw new Error("项目关系无法确认，IDE 入口失效");
  }
  accountForEntry(id: string): string { this.resolve(id); return this.references[id].accountId; }
  authorizationScope(id: string): string { return workspaceAuthorizationScope(this.resolve(id)); }
  resolve(id: string): IDEWorkspace {
    const { reference, target: resolved } = this.referenceTarget(id);
    // Authorization must not depend on which surviving IM alias was selected.
    const target = reference.identity === id ? { ...resolved, sessionId: id, nativeThreadId: undefined } : resolved;
    if (!target || !path.posix.isAbsolute(target.workspace) || /[\r\n\0]/.test(target.workspace)) throw new Error("项目或 session 已移除，IDE 入口失效");
    if (target.rootPaths && (!Array.isArray(target.rootPaths) || target.rootPaths.length < 2 || target.rootPaths.length > 32
      || !target.rootPaths.includes(target.workspace) || new Set(target.rootPaths).size !== target.rootPaths.length
      || target.rootPaths.some(root => typeof root !== "string" || !path.posix.isAbsolute(root) || /[\r\n\0]/.test(root))))
      throw new Error("项目多根目录配置无效，未开放 IDE");
    return target;
  }
  private host(target: IDEWorkspace) {
    const config = this.configStore.config();
    const host = config.hosts.find(h => h.hostId === target.hostId && h.enabled);
    if (!config.enabled || !host) throw new Error("请先在 Gateway 网页端启用该主机的 Web IDE");
    return { config, host };
  }
  private identity(target: IDEWorkspace, workspace: string, trustWorkspace = false, rootPaths?: readonly string[]): string {
    return digest([this.options.root, target.owner, target.hostId, workspace, "code-server", JSON.stringify(this.configStore.config().profile),
      ...(trustWorkspace ? ["gateway-trusted-workspace-v1"] : []), ...(rootPaths ? ["multi-root-v1", rootPaths] : [])]);
  }
  private async canonical(target: IDEWorkspace): Promise<IDECanonicalWorkspace> {
    const workspace = await this.transport.canonicalDirectory(target.hostId, target.workspace);
    if (!target.rootPaths) return { workspace };
    const rootPaths = await Promise.all(target.rootPaths.map(root => root === target.workspace ? workspace
      : this.transport.canonicalDirectory(target.hostId, root)));
    if (new Set(rootPaths).size !== rootPaths.length) throw new Error("项目包含重复的实际目录，请先核对项目配置");
    return { workspace, rootPaths: [workspace, ...rootPaths.filter(root => root !== workspace).sort()] };
  }
  async canonicalForTrust(id: string): Promise<IDECanonicalWorkspace> {
    const base = this.resolve(id), expected = digest(base);
    const current = await this.refresh(id);
    if (!current || digest(current) !== expected || digest(this.resolve(id)) !== expected) throw new Error("项目目录已改变，请同步 session 后重新授权");
    const directory = await this.canonical(base);
    if (digest(this.resolve(id)) !== expected) throw new Error("项目已改变，未授权目录");
    return directory;
  }
  async start(id: string, prepare = false, trustWorkspace = false, trustedDirectory?: string, trustedRootPaths?: readonly string[]): Promise<IDEInstanceStatus> {
    if (this.closing) throw new Error("IDE 正在停止或重新配置，请稍后重试");
    const base = this.resolve(id), generation = this.generation;
    const hostGeneration = this.hostGenerations.get(base.hostId) ?? 0;
    const initial = this.host(base);
    const check = () => {
      const current = this.host(base);
      if (this.closing || this.reconfiguring.has(base.hostId) || generation !== this.generation
        || hostGeneration !== (this.hostGenerations.get(base.hostId) ?? 0)
        || initial.host.binary !== current.host.binary || JSON.stringify(initial.config.profile) !== JSON.stringify(current.config.profile))
        throw new Error("IDE 配置已改变，已取消启动，请刷新后重试");
    };
    check();
    const target = await this.refresh(id);
    check();
    if (!target || target.hostId !== base.hostId || target.owner !== base.owner || digest(base) !== digest(this.resolve(id))) throw new Error("项目上下文已改变，未启动 IDE");
    const { config, host } = this.host(target);
    const binary = host.autoInstall && host.binary === "code-server" ? await this.installer.binary(target.hostId) : host.binary;
    check();
    const { workspace, rootPaths } = await this.canonical(target);
    if (trustWorkspace && (workspace !== trustedDirectory || JSON.stringify(rootPaths && [...rootPaths].sort()) !== JSON.stringify(trustedRootPaths && [...trustedRootPaths].sort())))
      throw new Error("实际目录与已信任目录不一致，请重新核对授权");
    if (digest(base) !== digest(this.resolve(id))) throw new Error("项目目录已改变，未启动 IDE");
    check();
    const instanceId = this.identity(target, workspace, trustWorkspace, rootPaths);
    const inflight = this.pending.get(instanceId);
    if (inflight) { if (prepare) throw new Error("IDE 正在启动，请稍后准备扩展"); return publicInstance(await inflight); }
    const previous = this.instances.get(instanceId);
    if (this.pending.size + [...this.instances.values()].filter(i => i.status === "running" && i.launch?.alive()).length
      - Number(previous?.status === "running" && previous.launch?.alive()) >= 8) throw new Error("IDE 实例达到上限，请先停止不用的实例");
    const cancellation = new AbortController(); this.cancellations.set(instanceId, { controller: cancellation, hostId: target.hostId });
    const promise = (async (): Promise<Instance> => {
      if (previous?.status === "running" && previous.launch?.alive()) {
        if (prepare) throw new Error("请先停止 IDE 再准备扩展，以免并发写入扩展目录");
        if (await healthy(previous.launch.socketPath)) {
          check();
          previous.lastUsedAt = Date.now(); return previous;
        }
      }
      await previous?.launch?.stop();
      check();
      const instance: Instance = { id: instanceId, workspace, ...(rootPaths ? { rootPaths } : {}), hostId: target.hostId, status: "starting", lastUsedAt: Date.now(), trustWorkspace };
      this.instances.set(instanceId, instance);
      try {
        instance.launch = await this.transport.launch({ hostId: target.hostId, workspace, ...(rootPaths ? { rootPaths } : {}), id: instanceId,
          binary, settings: config.profile.settings, extensions: config.profile.extensions, prepare, trustWorkspace,
          signal: cancellation.signal,
          onProfile: status => { if (this.instances.get(instanceId) === instance && generation === this.generation
            && hostGeneration === (this.hostGenerations.get(target.hostId) ?? 0)) instance.profile = status; } });
        check();
        if (rootPaths && !prepare && !instance.launch.workspaceFile) throw new Error("多根工作区未生成，未开放 IDE");
        if (instance.launch.workspaceFile) instance.workspaceFile = instance.launch.workspaceFile;
        if (prepare) { await instance.launch.stop(); instance.launch = undefined; instance.status = "stopped"; return instance; }
        const deadline = Date.now() + (this.options.readyTimeoutMs ?? 20_000);
        while (!await healthy(instance.launch.socketPath)) {
          check();
          if (!instance.launch.alive() || Date.now() >= deadline) throw new Error("IDE 健康检查未通过，请检查主机安装、目录权限和 SSH 转发");
          await delay(150);
        }
        this.resolve(id); // Deleted sessions/projects cannot authorize a late startup.
        check();
        instance.status = "running"; return instance;
      } catch (error) {
        await instance.launch?.stop(); instance.launch = undefined; instance.status = "error";
        // Do not expose subprocess stderr, SSH identities or arbitrary host output.
        instance.error = instance.profile?.warning === "extensions-unavailable"
          ? "所选扩展未安装完成；请检查 Open VSX 网络、扩展兼容性及目录权限后重试准备扩展。"
          : "IDE 启动失败；请检查对应主机的 code-server、Node、SSH 与项目目录。";
        throw error;
      }
    })();
    this.pending.set(instanceId, promise);
    try { return publicInstance(await promise); } finally {
      if (this.pending.get(instanceId) === promise) this.pending.delete(instanceId);
      if (this.cancellations.get(instanceId)?.controller === cancellation) this.cancellations.delete(instanceId);
    }
  }
  endpoint(id: string, trustWorkspace = false): { instanceId: string; socketPath: string; workspace: string; workspaceFile?: string } | undefined {
    const target = this.resolve(id); this.host(target);
    // References can share an instance, but never cross host/owner/security profile.
    for (const instance of this.instances.values()) {
      const expected = this.identity(target, instance.workspace, trustWorkspace, instance.rootPaths);
      if (expected !== instance.id || instance.status !== "running" || !instance.launch?.alive()) continue;
      // Alias/symlink mapping is recorded only following a successful resolution.
      const opened = this.opened.get(`${id}:${trustWorkspace}`);
      if (opened?.instanceId !== instance.id || opened.target !== digest(target)) continue;
      instance.lastUsedAt = Date.now(); return { instanceId: instance.id, socketPath: instance.launch.socketPath, workspace: instance.workspace,
        ...(instance.workspaceFile ? { workspaceFile: instance.workspaceFile } : {}) };
    }
  }
  private readonly opened = new Map<string, { instanceId: string; target: string }>();
  async open(id: string, trustWorkspace = false, trustedDirectory?: string, trustedRootPaths?: readonly string[]): Promise<IDEInstanceStatus> {
    const base = this.resolve(id), target = digest(base), generation = this.generation, hostGeneration = this.hostGenerations.get(base.hostId) ?? 0;
    const instance = await this.start(id, false, trustWorkspace, trustedDirectory, trustedRootPaths);
    this.host(base);
    if (target !== digest(this.resolve(id)) || this.closing || this.reconfiguring.has(base.hostId) || generation !== this.generation
      || hostGeneration !== (this.hostGenerations.get(base.hostId) ?? 0)) throw new Error("项目或 IDE 配置已改变，请刷新后重试");
    this.opened.set(`${id}:${trustWorkspace}`, { instanceId: instance.id, target }); return instance;
  }
  list(): IDEInstanceStatus[] {
    return [...this.instances.values()].map(instance => publicInstance(instance.status === "running" && !instance.launch?.alive()
      ? { ...instance, status: "error", error: "IDE 进程或 SSH 连接已断开；重新打开可重建连接。" } : instance));
  }
  async stop(id: string): Promise<void> {
    if (this.pending.has(id)) throw new Error("IDE 正在准备，请完成后重试或禁用 Web IDE");
    const instance = this.instances.get(id);
    if (!instance) throw new Error("IDE 实例不存在");
    this.onStop?.(id); await instance.launch?.stop(); instance.launch = undefined; instance.status = "stopped";
  }
  async close(): Promise<void> {
    this.closing = true;
    this.generation++;
    for (const cancellation of this.cancellations.values()) cancellation.controller.abort();
    await this.installer.close();
    await Promise.allSettled(this.pending.values());
    await Promise.all([...this.instances.values()].map(async instance => {
      this.onStop?.(instance.id); await instance.launch?.stop(); instance.launch = undefined; instance.status = "stopped";
    }));
    this.opened.clear();
  }
  async reconfigure(previous: IDEConfig | undefined, next: IDEConfig): Promise<void> {
    const { stopHosts, cancelInstalls } = runtimeChanges(previous, next);
    // Fence before the first await, including directory/refresh work that has
    // not yet acquired an instance ID. Unrelated hosts remain usable.
    for (const hostId of stopHosts) {
      this.reconfiguring.add(hostId);
      this.hostGenerations.set(hostId, (this.hostGenerations.get(hostId) ?? 0) + 1);
    }
    const pending = [...this.pending].filter(([id]) => stopHosts.has(this.cancellations.get(id)!.hostId)).map(([, work]) => work);
    for (const cancellation of this.cancellations.values()) if (stopHosts.has(cancellation.hostId)) cancellation.controller.abort();
    try {
      await Promise.all([this.installer.cancelHosts(cancelInstalls), Promise.allSettled(pending)]);
      await Promise.all([...this.instances.values()].filter(instance => stopHosts.has(instance.hostId)).map(async instance => {
        this.onStop?.(instance.id); await instance.launch?.stop(); instance.launch = undefined; instance.status = "stopped";
      }));
      for (const [key, opened] of this.opened) if (stopHosts.has(this.instances.get(opened.instanceId)?.hostId ?? "")) this.opened.delete(key);
    } finally { for (const hostId of stopHosts) this.reconfiguring.delete(hostId); }
  }
  resume(): void { this.closing = false; }
  config(): IDEConfig { return this.configStore.config(); }
  authorizationFile(): string { return path.join(this.options.root, "ide", "authorization.json"); }
}
function digest(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32); }
function publicInstance({ launch: _, ...instance }: Instance): IDEInstanceStatus { return instance; }
function healthy(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { request.destroy(); resolve(false); }, 1000);
    const request = http.get({ socketPath, path: "/healthz", agent: false }, response => {
      clearTimeout(timer); response.resume(); resolve(response.statusCode === 200);
    });
    request.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}
