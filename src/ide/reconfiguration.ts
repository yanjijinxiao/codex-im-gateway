import type { IDEConfig } from "./config.js";

/** Project processes, installation permission and browser entrances have
 * independent lifetimes. Adding a host must not invalidate existing work. */
export function runtimeChanges(previous: IDEConfig | undefined, next: IDEConfig) {
  const stopHosts = new Set<string>(), cancelInstalls = new Set<string>();
  if (previous?.enabled) for (const host of previous.hosts.filter(h => h.enabled)) {
    const current = next.enabled && next.hosts.find(h => h.enabled && h.hostId === host.hostId);
    if (!current || current.binary !== host.binary || JSON.stringify(previous.profile) !== JSON.stringify(next.profile)) stopHosts.add(host.hostId);
    if (!current || current.binary !== host.binary || (host.autoInstall && !current.autoInstall)) cancelInstalls.add(host.hostId);
  }
  return { stopHosts, cancelInstalls };
}

export type IDEEntrance = { key: string; hostId?: string; fingerprint: string; config: IDEConfig };
export function entrances(config: IDEConfig): IDEEntrance[] {
  if (!config.enabled) return [];
  if (config.routing !== "per-host") return [{ key: "legacy", fingerprint: JSON.stringify(["legacy", config.publicOrigin, config.port, config.tls]), config }];
  return config.hosts.filter(h => h.enabled && (h.hostId === "local" || h.access)).map(host => {
    const local = host.hostId === "local";
    return { key: host.hostId, hostId: host.hostId,
      // Sharing changes the permitted project hosts, not the TLS listener or
      // reverse SSH relay. Keep the latter alive when publication changes.
      fingerprint: JSON.stringify(local ? ["local", config.publicOrigin, config.port] : ["remote", host.access]),
      config: { ...config, hosts: config.sharedIngressHostId === host.hostId ? config.hosts : [host],
        ...(local ? {} : { publicOrigin: host.access!.publicOrigin, port: 0 }) } };
  });
}
