import net from "node:net";
import type { IDEConfig } from "./config.js";

/** Selection policy is distinct from a resolved listening IP. Never infer a
 * VPN/default route, choose among aliases, or fall back to another interface. */
export function resolveLocalIDEAccess(access: NonNullable<IDEConfig["localAccess"]>, addresses: readonly { name: string; address: string }[]) {
  if (!access.interfaceName) return access;
  const matches = [...new Set(addresses.filter(item => item.name === access.interfaceName && net.isIP(item.address) === 4).map(item => item.address))];
  if (matches.length !== 1) throw new Error(`网卡 ${access.interfaceName} ${matches.length ? "有多个 IPv4 地址，无法唯一选择" : "暂无 IPv4 地址"}；等待地址恢复，不切换其他网卡。`);
  const bindAddress = matches[0]!;
  return { ...access, bindAddress, publicOrigin: `https://${bindAddress}:${access.port}` };
}
