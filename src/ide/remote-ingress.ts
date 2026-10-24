import crypto from "node:crypto";
import https from "node:https";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteIDEAccess } from "./config.js";
import { ideHostCommand, ideSshConnection, runIDEHost } from "./host-command.js";

export type IDEIngressState = { state: "connecting" | "ready" | "reconnecting" | "error"; error?: string };
export type IDEIngressConnection = { closed: Promise<void>; close(): Promise<void> };
export type IDEIngressInput = { installation: string; hostId: string; access: RemoteIDEAccess; localPort: number; ca: Buffer };
export type IDEIngressIO = {
  connect(input: IDEIngressInput, signal: AbortSignal): Promise<IDEIngressConnection>;
  probe(input: IDEIngressInput, signal: AbortSignal): Promise<void>;
};

/** The remote process relays opaque TLS bytes only. It has no certificates,
 * browser credentials, management API or direct code-server endpoint. A private
 * reverse Unix socket avoids changing sshd GatewayPorts or Docker mappings. */
export class RemoteIDEIngress {
  private readonly cancellation = new AbortController();
  private task?: Promise<void>;
  constructor(private readonly input: IDEIngressInput, private readonly report: (state: IDEIngressState) => void,
    private readonly io: IDEIngressIO = processIDEIngressIO, private readonly timing = { retryMs: 1000, probeMs: 15_000 }) {}
  start(): void { this.task ??= this.run(); }
  async close(): Promise<void> { this.cancellation.abort(); await this.task; }
  private async run(): Promise<void> {
    const signal = this.cancellation.signal; let attempt = 0;
    while (!signal.aborted) {
      this.report({ state: attempt ? "reconnecting" : "connecting" });
      let connection: IDEIngressConnection | undefined;
      try {
        connection = await this.io.connect(this.input, signal);
        await this.io.probe(this.input, signal);
        if (signal.aborted) break;
        this.report({ state: "ready" }); attempt = 0;
        let ended = false;
        void connection.closed.then(() => { ended = true; });
        // Verify the published path, not just whether an SSH process exists.
        while (!signal.aborted && !ended) {
          await Promise.race([connection.closed, delay(this.timing.probeMs, undefined, { signal, ref: false })]);
          if (signal.aborted || ended) break;
          await this.io.probe(this.input, signal);
        }
      } catch {
        if (!signal.aborted) this.report({ state: "error", error: "远程 HTTPS 转发或连通性检查失败；请检查 SSH、固定端口映射及远程监听占用。后台会自动重试，不修改项目或授权。" });
      } finally { await connection?.close().catch(() => {}); }
      if (signal.aborted) break;
      this.report({ state: "reconnecting", error: "远程入口暂不可达，正在自动重连；原浏览器授权和项目状态保留。" });
      await delay(Math.min(30_000, this.timing.retryMs * 2 ** Math.min(attempt++, 5)), undefined, { signal }).catch(() => {});
    }
  }
}

export const REMOTE_IDE_SOCKET_PREPARE = String.raw`
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),net=require("node:net");
const i=JSON.parse(Buffer.from(process.argv[1],"base64").toString());
(async()=>{
if(!/^[a-f0-9]{24}$/.test(i.id))throw Error("invalid ingress identity");
const dir=path.join(os.homedir(),".local/share/codex-im-gateway/ingress",i.id);
fs.mkdirSync(dir,{recursive:true,mode:0o700});const stat=fs.lstatSync(dir);
if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw Error("unsafe ingress directory");
fs.chmodSync(dir,0o700);const socketPath=path.join(dir,"relay.sock");
if(Buffer.byteLength(socketPath)>100)throw Error("ingress socket path too long");
let before;try{before=fs.lstatSync(socketPath);}catch(e){if(e.code!=="ENOENT")throw e;}
if(before){
 if(!before.isSocket()||before.uid!==process.getuid()||(before.mode&0o077))throw Error("unsafe ingress socket");
 // The client's StreamLocalBindUnlink does not configure remote sshd. A
 // disconnected server can leave an inode: remove only a proven stale socket,
 // never a live forward, symlink, foreign-owned path or replacement inode.
 const stale=await new Promise((resolve,reject)=>{const c=net.createConnection(socketPath);c.setTimeout(1000,()=>{c.destroy();reject(Error("socket probe timeout"));});
  c.once("connect",()=>{c.destroy();resolve(false);});c.once("error",e=>{c.destroy();["ECONNREFUSED","ENOENT"].includes(e.code)?resolve(true):reject(e);});});
 if(!stale)throw Error("ingress socket still active");
 try{const now=fs.lstatSync(socketPath);if(now.ino!==before.ino||now.dev!==before.dev||!now.isSocket()||now.uid!==process.getuid())throw Error("ingress socket changed");fs.unlinkSync(socketPath);}
 catch(e){if(e.code!=="ENOENT")throw e;}
}
console.log(JSON.stringify({socketPath}));
})().catch(()=>{process.stderr.write("Ingress socket preparation failed\n");process.exitCode=1;});`;

export const REMOTE_IDE_RELAY = String.raw`
const net=require("node:net"),os=require("node:os"),fs=require("node:fs");
const i=JSON.parse(Buffer.from(process.argv[1],"base64").toString());
if(!Object.values(os.networkInterfaces()).flat().some(x=>x&&x.address===i.bindAddress))throw Error("ingress address not assigned");
const stat=fs.lstatSync(i.socketPath);if(!stat.isSocket()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error("unsafe forwarding socket");
const sockets=new Set();let stopped=false;
const server=net.createServer(client=>{
  if(stopped){client.destroy();return;}
  const upstream=net.createConnection(i.socketPath);sockets.add(client);sockets.add(upstream);
  client.on("error",()=>upstream.destroy());upstream.on("error",()=>client.destroy());
  client.on("close",()=>{sockets.delete(client);upstream.destroy();});
  upstream.on("close",()=>{sockets.delete(upstream);client.destroy();});
  client.pipe(upstream).pipe(client);
});server.maxConnections=128;
const stop=()=>{if(stopped)return;stopped=true;for(const s of sockets)s.destroy();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1000).unref();};
server.once("error",e=>{console.log(JSON.stringify({error:e.code||"listen-failed"}));stop();});
server.listen(i.port,i.bindAddress,()=>console.log(JSON.stringify({ready:true})));
process.stdin.resume();process.stdin.on("end",stop);process.stdin.on("close",stop);
for(const event of ["SIGHUP","SIGINT","SIGTERM"])process.on(event,stop);`;

async function connect(input: IDEIngressInput, signal: AbortSignal): Promise<IDEIngressConnection> {
  const id = crypto.createHash("sha256").update(JSON.stringify([input.installation, input.hostId, input.access])).digest("hex").slice(0, 24);
  const { socketPath } = await runIDEHost<{ socketPath: string }>(input.hostId, REMOTE_IDE_SOCKET_PREPARE, { id }, signal, 20_000);
  if (signal.aborted) throw new Error("Ingress cancelled");
  const relay = ideHostCommand(input.hostId, REMOTE_IDE_RELAY, { ...input.access, socketPath });
  const ssh = ideSshConnection(input.hostId);
  const targetIndex = relay.args.indexOf(ssh.target);
  if (targetIndex < 0) throw new Error("Invalid ingress SSH target");
  const args = [...relay.args.slice(0, targetIndex), "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes",
    "-o", "StreamLocalBindMask=0177", "-R", `${socketPath}:127.0.0.1:${input.localPort}`, ...relay.args.slice(targetIndex)];
  const child = spawn(relay.command, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume(); child.stdin.on("error", () => {});
  let ended = false, buffer = "";
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  child.once("exit", () => { ended = true; finish(); });
  const closing = async () => {
    child.stdin.end();
    if (ended) return;
    await Promise.race([closed, delay(1000)]);
    if (!ended) child.kill("SIGTERM");
    await Promise.race([closed, delay(2000)]);
    if (!ended) child.kill("SIGKILL");
    await closed;
  };
  const abort = () => { child.stdin.end(); child.kill("SIGTERM"); };
  signal.addEventListener("abort", abort, { once: true });
  void closed.then(() => signal.removeEventListener("abort", abort));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Ingress readiness timeout")), 15_000);
      const done = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once("error", error => { ended = true; finish(); done(error); });
      void closed.then(() => done(new Error("Ingress exited before readiness")));
      child.stdout.on("data", chunk => {
        buffer += chunk.toString();
        if (buffer.length > 8192) { done(new Error("Invalid ingress readiness response")); return; }
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try { const row = JSON.parse(line); if (row.ready === true) done(); else if (row.error) done(new Error("Remote ingress listen failed")); }
          catch { done(new Error("Invalid ingress readiness response")); }
        }
      });
      if (signal.aborted) done(new Error("Ingress cancelled"));
    });
    return { closed, close: closing };
  } catch (error) { await closing(); throw error; }
}

function probe(input: IDEIngressInput, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(new URL("/", input.access.publicOrigin), { ca: input.ca, agent: false, signal, timeout: 5000 }, response => {
      response.resume(); response.statusCode === 200 ? resolve() : reject(new Error("Ingress HTTPS check failed"));
    });
    request.on("timeout", () => request.destroy(new Error("Ingress HTTPS check timed out")));
    request.on("error", reject);
  });
}
export const processIDEIngressIO: IDEIngressIO = { connect, probe };
