import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IDEConfig } from "./config.js";

const exec = promisify(execFile), DAY = 86_400_000;
type Files = NonNullable<IDEConfig["tls"]>;
export function localIDEAddresses(): Array<{ name: string; address: string }> {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => (addresses ?? [])
    .filter(item => !item.internal && !item.address.includes("%") && !item.address.startsWith("fe80:") && item.address !== "0.0.0.0")
    .map(item => ({ name, address: item.address })));
}
function checkAddress(address: string): void {
  if (!net.isIP(address) || ["0.0.0.0", "::"].includes(address)) throw new Error("需要精确的 IP 地址，不能监听全部接口");
}
function privateFile(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128_000 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("私钥必须属于 Gateway 运行用户且仅该用户可读");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function certificate(file: string): crypto.X509Certificate { return new crypto.X509Certificate(fs.readFileSync(file)); }
function matchesKey(cert: crypto.X509Certificate, key: Buffer): boolean {
  return cert.publicKey.equals(crypto.createPublicKey(crypto.createPrivateKey(key)));
}
function valid(cert: crypto.X509Certificate, now = Date.now()): boolean {
  return Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now;
}
export function loadIDETLS(files: Files, origin: string): tls.SecureContextOptions {
  checkAddress(files.bindAddress);
  const cert = fs.readFileSync(files.certFile), parsed = new crypto.X509Certificate(cert), key = privateFile(files.keyFile);
  const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  if (!valid(parsed)) throw new Error("IDE HTTPS 证书尚未生效或已过期");
  if (!(net.isIP(hostname) ? parsed.checkIP(hostname) : parsed.checkHost(hostname))) throw new Error("IDE HTTPS 证书与浏览器入口地址不匹配");
  if (!matchesKey(parsed, key)) throw new Error("IDE HTTPS 证书与私钥不匹配");
  const options: tls.SecureContextOptions = { cert, key, minVersion: "TLSv1.2" };
  tls.createSecureContext(options); return options;
}

/** Dedicated local CA. It is NEVER installed into an OS/browser trust store.
 * Keys stay in owner-only files, outside the repository. No shell templates,
 * DNS mutations, ACME accounts or external signing service are involved. */
export class IDETLSManager {
  private transition: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  caFile(): string { return path.join(this.root, "authority", "ca.crt"); }
  private caKey(): string { return path.join(this.root, "authority", "ca.key"); }
  private files(address: string): Files {
    checkAddress(address);
    const directory = path.join(this.root, crypto.createHash("sha256").update(address).digest("hex").slice(0, 24));
    return { bindAddress: address, certFile: path.join(directory, "server.crt"), keyFile: path.join(directory, "server.key") };
  }
  owns(files: Files): boolean { const expected = this.files(files.certificateAddress ?? files.bindAddress); return expected.certFile === files.certFile && expected.keyFile === files.keyFile; }
  caCertificate(): Buffer { return fs.readFileSync(this.caFile()); }
  details(files?: Files) {
    if (!files) return undefined;
    try {
      const cert = certificate(files.certFile), ca = this.owns(files) ? certificate(this.caFile()) : undefined;
      return { fingerprint256: cert.fingerprint256, expiresAt: new Date(cert.validTo).toISOString(),
        managed: Boolean(ca), caFingerprint256: ca?.fingerprint256, caExpiresAt: ca && new Date(ca.validTo).toISOString() };
    } catch { return { error: "证书信息无法读取，请检查文件或重新准备证书" }; }
  }
  prepare(address: string, forceRenew = false): Promise<Files> {
    checkAddress(address);
    const work = this.transition.catch(() => {}).then(() => this.generate(address, forceRenew));
    this.transition = work; return work;
  }
  private async openssl(args: string[]): Promise<void> {
    try { await exec("openssl", args, { timeout: 20_000, maxBuffer: 64_000, windowsHide: true }); }
    catch { throw new Error("证书准备失败；请检查 Gateway 主机的 OpenSSL、目录权限和磁盘空间。未修改系统信任库。"); }
  }
  private secureDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("证书目录不安全");
    fs.chmodSync(directory, 0o700);
  }
  private readCA(): crypto.X509Certificate {
    const ca = certificate(this.caFile());
    if (!ca.ca || !valid(ca) || !ca.verify(ca.publicKey) || !matchesKey(ca, privateFile(this.caKey()))) throw new Error("本地 CA 无效或已过期；不会静默更换受信任 CA，请在管理台处理");
    return ca;
  }
  private async ensureCA(): Promise<crypto.X509Certificate> {
    const directory = path.dirname(this.caFile());
    if (fs.existsSync(directory)) return this.readCA();
    const stage = fs.mkdtempSync(path.join(this.root, ".authority-"));
    try {
      const key = path.join(stage, "ca.key"), cert = path.join(stage, "ca.crt");
      await this.openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1825",
        "-keyout", key, "-out", cert, "-subj", "/CN=Codex Gateway local IDE CA",
        "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
      fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600);
      fs.renameSync(stage, directory); return this.readCA();
    } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
  }
  private async generate(address: string, forceRenew: boolean): Promise<Files> {
    this.secureDirectory(this.root); const ca = await this.ensureCA(), files = this.files(address), directory = path.dirname(files.certFile);
    const existing = fs.existsSync(directory);
    if (existing) {
      this.secureDirectory(directory);
      const cert = certificate(files.certFile);
      if (!cert.verify(ca.publicKey) || !cert.checkIP(address) || !matchesKey(cert, privateFile(files.keyFile))) throw new Error("已有 IDE 证书与本地 CA、IP 或私钥不一致；未覆盖旧文件");
      if (!forceRenew && Date.parse(cert.validTo) > Date.now() + 30 * DAY) return files;
    }
    if (Date.parse(ca.validTo) < Date.now() + 366 * DAY) throw new Error("本地 CA 有效期不足一年，需要明确更换 CA 并重新信任；未自动轮换");
    const stage = fs.mkdtempSync(path.join(this.root, ".certificate-"));
    try {
      const key = existing ? files.keyFile : path.join(stage, "server.key"), csr = path.join(stage, "server.csr"), cert = path.join(stage, "server.crt"), extensions = path.join(stage, "extensions.cnf");
      await this.openssl(["req", "-new", ...(existing ? ["-key", key] : ["-newkey", "rsa:2048", "-nodes", "-keyout", key]),
        "-out", csr, "-subj", "/CN=Codex Gateway project IDE"]);
      fs.chmodSync(key, 0o600);
      fs.writeFileSync(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${address}\n`, { mode: 0o600 });
      await this.openssl(["x509", "-req", "-in", csr, "-CA", this.caFile(), "-CAkey", this.caKey(),
        "-set_serial", "0x" + crypto.randomBytes(16).toString("hex"), "-days", "365", "-sha256", "-extfile", extensions, "-out", cert]);
      fs.chmodSync(cert, 0o600);
      const parsed = certificate(cert);
      if (!parsed.verify(ca.publicKey) || !parsed.checkIP(address) || !matchesKey(parsed, privateFile(key))) throw new Error("生成的 IDE 证书校验失败");
      if (existing) fs.renameSync(cert, files.certFile); // One atomic file; stable key avoids mixed-pair reads.
      else fs.renameSync(stage, directory);
      return files;
    } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
  }
}
