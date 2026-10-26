import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";

// Deliberately not arbitrary VS Code configuration: imports cannot smuggle
// executable paths, environment variables, proxy credentials or extension state.
export const PORTABLE_SETTINGS = new Set([
  "workbench.editor.wrapTabs", "workbench.colorTheme", "workbench.iconTheme", "workbench.productIconTheme",
  "editor.fontSize", "editor.fontFamily", "editor.lineHeight", "editor.fontWeight", "editor.fontLigatures",
  "editor.tabSize", "editor.insertSpaces", "editor.wordWrap", "editor.minimap.enabled",
  "editor.renderWhitespace", "editor.formatOnSave", "files.trimTrailingWhitespace",
  "files.insertFinalNewline", "files.watcherExclude", "diffEditor.maxComputationTime",
  "diffEditor.ignoreTrimWhitespace", "terminal.integrated.initialHint", "workbench.secondarySideBar.defaultVisibility"
]);
export const IDE_EXTENSIONS = ["redhat.vscode-yaml", "dotjoshjohnson.xml", "mechatroner.rainbow-csv",
  "redhat.java", "vscjava.vscode-maven", "scalameta.metals", "josevseb.google-java-format-for-vs-code", "tuttieee.emacs-mcx"] as const;
const settingsSchema = z.record(z.string(), z.union([z.string().max(500), z.boolean(), z.number().finite(),
  z.record(z.string().max(300), z.boolean())])).superRefine((settings, context) => {
  for (const key of Object.keys(settings)) if (!PORTABLE_SETTINGS.has(key)) context.addIssue({ code: "custom", message: `不支持导入的设置：${key}` });
  const visibility = settings["workbench.secondarySideBar.defaultVisibility"];
  if (visibility !== undefined && !["hidden", "visibleInWorkspace", "visible", "maximizedInWorkspace", "maximized"].includes(String(visibility)))
    context.addIssue({ code: "custom", message: "无效的次侧边栏默认可见性" });
  for (const key of ["workbench.colorTheme", "workbench.iconTheme", "workbench.productIconTheme", "editor.fontFamily"])
    if (settings[key] !== undefined && (typeof settings[key] !== "string" || !String(settings[key]).trim() || /[\r\n\0]/.test(String(settings[key]))))
      context.addIssue({ code: "custom", message: `${key} 必须为非空的单行名称` });
  for (const [key, min, max] of [["editor.fontSize", 6, 100], ["editor.lineHeight", 0, 200]] as const)
    if (settings[key] !== undefined && (typeof settings[key] !== "number" || Number(settings[key]) < min || Number(settings[key]) > max))
      context.addIssue({ code: "custom", message: `${key} 必须为 ${min} 至 ${max} 的数值` });
  if (settings["editor.fontWeight"] !== undefined && (typeof settings["editor.fontWeight"] !== "string" || !/^(normal|bold|[1-9]00)$/.test(String(settings["editor.fontWeight"]))))
    context.addIssue({ code: "custom", message: "editor.fontWeight 必须为 normal、bold 或 100 至 900 的字重字符串" });
  for (const key of ["editor.fontLigatures", "workbench.editor.wrapTabs"])
    if (settings[key] !== undefined && typeof settings[key] !== "boolean") context.addIssue({ code: "custom", message: `${key} 必须为布尔值` });
  if (JSON.stringify(settings).length > 16_000) context.addIssue({ code: "custom", message: "Profile 过大" });
});
const exactAddress = z.string().refine(value => Boolean(net.isIP(value)) && !["0.0.0.0", "::"].includes(value), "需要精确 IP，不允许监听全部接口");
export const remoteIDEAccessSchema = z.object({
  publicOrigin: z.string().url().max(500).refine(value => {
    if (!URL.canParse(value)) return false;
    const u = new URL(value), address = u.hostname.replace(/^\[|\]$/g, "");
    return u.protocol === "https:" && Boolean(net.isIP(address)) && !["0.0.0.0", "::", "::1"].includes(address) && !address.startsWith("127.")
      && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash;
  }, "远程入口必须为固定 IP 的 HTTPS origin，不接受凭据、路径或回环地址"),
  bindAddress: exactAddress,
  port: z.number().int().min(1).max(65535)
}).strict();
export type RemoteIDEAccess = z.infer<typeof remoteIDEAccessSchema>;
// Separate from remote relay bindings: this listener is owned by the Gateway
// itself and its advertised IP must equal the exact local listening address.
const localIDEAccessSchema = z.object({
  publicOrigin: z.string().url().max(500), bindAddress: exactAddress,
  // When present, the IP fields are the last resolved IPv4 binding. The
  // endpoint coordinator follows only this explicitly selected interface.
  interfaceName: z.string().min(1).max(128).refine(value => !/[\s\0]/.test(value)).optional(),
  port: z.number().int().min(1024).max(65535)
}).strict().superRefine((access, context) => {
  if (access.interfaceName && net.isIP(access.bindAddress) !== 4)
    context.addIssue({ code: "custom", message: "自动跟随网卡目前需要 IPv4 地址" });
  if (!URL.canParse(access.publicOrigin)) return;
  const u = new URL(access.publicOrigin);
  if (u.protocol !== "https:" || u.hostname.replace(/^\[|\]$/g, "") !== access.bindAddress
    || Number(u.port || 443) !== access.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash)
    context.addIssue({ code: "custom", message: "本机直连入口必须为所选精确 IP 和端口的 HTTPS origin，不接受凭据或路径" });
});
export const ideConfigSchema = z.object({
  enabled: z.boolean(),
  routing: z.literal("per-host").optional(),
  // Browser publication is independent of where a project's code-server runs.
  // Reuse one explicitly configured remote ingress; never infer a VPN address.
  sharedIngressHostId: z.string().min(1).max(300).optional(),
  localAccess: localIDEAccessSchema.optional(),
  port: z.number().int().min(1024).max(65535),
  publicOrigin: z.string().url().max(500).refine(value => {
    if (!URL.canParse(value)) return false;
    const u = new URL(value);
    return !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash
      && (u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)));
  }, "跨设备入口必须为 HTTPS；HTTP 仅允许本机回环地址，不接受路径或凭据"),
  // Omitted: loopback HTTP behind an existing TLS proxy. Present: the IDE
  // data plane terminates TLS itself; the management plane stays loopback.
  tls: z.object({ bindAddress: z.string().refine(value => Boolean(net.isIP(value)) && !["0.0.0.0", "::"].includes(value), "请选择精确的本机 IP，不允许监听全部接口"),
    certificateAddress: exactAddress.optional(),
    certFile: z.string().max(1000).refine(value => path.isAbsolute(value) && !/[\r\n\0]/.test(value), "证书必须为绝对路径"),
    keyFile: z.string().max(1000).refine(value => path.isAbsolute(value) && !/[\r\n\0]/.test(value), "私钥必须为绝对路径") }).strict().optional(),
  hosts: z.array(z.object({ hostId: z.string().min(1).max(300), enabled: z.boolean(),
    autoInstall: z.boolean().default(false),
    access: remoteIDEAccessSchema.optional(),
    binary: z.string().min(1).max(500).refine(value => value === "code-server" || (path.posix.isAbsolute(value) && !/[\r\n\0]/.test(value)), "使用 code-server 或绝对可执行文件路径")
  }).strict()).max(50).refine(hosts => new Set(hosts.map(host => host.hostId)).size === hosts.length, "主机重复"),
  profile: z.object({ settings: settingsSchema, extensions: z.array(z.enum(IDE_EXTENSIONS)).max(20)
    .refine(ids => new Set(ids).size === ids.length, "扩展重复") }).strict()
}).strict().superRefine((config, context) => {
  if (!URL.canParse(config.publicOrigin)) return;
  const origin = new URL(config.publicOrigin);
  if (config.sharedIngressHostId && (config.routing !== "per-host" || config.sharedIngressHostId === "local"
    || !config.hosts.some(host => host.hostId === config.sharedIngressHostId && host.enabled && host.access)))
    context.addIssue({ code: "custom", path: ["sharedIngressHostId"], message: "共享入口必须选择分主机模式中已启用且配置固定 HTTPS 的远程主机" });
  if (config.routing === "per-host") {
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || config.tls)
      context.addIssue({ code: "custom", path: ["publicOrigin"], message: "分主机模式的维护入口必须使用 HTTP 127.0.0.1；跨设备直连请配置独立本机 HTTPS 入口" });
    const origins = config.hosts.filter(h => h.enabled && h.access).map(h => new URL(h.access!.publicOrigin).origin);
    if (config.localAccess && URL.canParse(config.localAccess.publicOrigin)) origins.push(new URL(config.localAccess.publicOrigin).origin);
    if (new Set(origins).size !== origins.length) context.addIssue({ code: "custom", path: ["hosts"], message: "远程入口不能重复" });
    if (config.hosts.some(h => h.hostId === "local" && h.access)) context.addIssue({ code: "custom", path: ["hosts"], message: "本地主机不能配置远程转发" });
    const binds = config.hosts.filter(h => h.enabled && h.access).map(h => `${h.hostId}:${h.access!.bindAddress}:${h.access!.port}`);
    if (new Set(binds).size !== binds.length) context.addIssue({ code: "custom", path: ["hosts"], message: "远程监听重复" });
  } else if (config.hosts.some(h => h.access)) context.addIssue({ code: "custom", path: ["routing"], message: "远程入口需要启用分主机模式" });
  if (config.localAccess && (config.routing !== "per-host" || !config.hosts.some(h => h.hostId === "local")))
    context.addIssue({ code: "custom", path: ["localAccess"], message: "本机直连入口需要分主机模式并登记本地主机" });
  if (config.tls && (origin.protocol !== "https:" || Number(origin.port || 443) !== config.port)) context.addIssue({ code: "custom", path: ["tls"], message: "内置 HTTPS 入口的协议和端口必须与浏览器地址一致" });
  if (origin.protocol === "http:" && Number(origin.port || 80) !== config.port) context.addIssue({ code: "custom", path: ["publicOrigin"], message: "本机 HTTP 入口端口必须与 IDE 监听端口一致" });
});
export type IDEConfig = z.infer<typeof ideConfigSchema>;
export class IDEConfigStore {
  readonly filePath: string;
  error?: string;
  constructor(root: string) { this.filePath = path.join(root, "ide", "config.json"); }
  private read(): IDEConfig {
    const defaults = { enabled: false, port: 8790, publicOrigin: "http://127.0.0.1:8790", hosts: [],
      profile: { settings: { "workbench.editor.wrapTabs": true, "terminal.integrated.initialHint": false,
        "diffEditor.ignoreTrimWhitespace": false }, extensions: [] } };
    try {
      const value = readJsonFile<Partial<IDEConfig> & { passwordHash?: unknown }>(this.filePath, {});
      // Existing password hashes are intentionally ignored and removed on save.
      const { passwordHash: _, ...settings } = value;
      const parsed = ideConfigSchema.parse({ ...defaults, ...settings }); this.error = undefined;
      return parsed;
    } catch { this.error = "IDE 配置文件无效，已安全禁用 IDE；原文件未改动。"; return ideConfigSchema.parse(defaults); }
  }
  config(): IDEConfig { return this.read(); }
  save(input: unknown): IDEConfig {
    const config = ideConfigSchema.parse(input);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(this.filePath), 0o700);
    writeJsonFile(this.filePath, config); fs.chmodSync(this.filePath, 0o600);
    return config;
  }
}
