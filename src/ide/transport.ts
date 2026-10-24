import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ideSshConnection } from "./host-command.js";
import { IDE_PROFILE_HELPER, IDE_SETTING_DEFAULTS, type IDEProfileStatus } from "./profile.js";

const exec = promisify(execFile);
export type IDELaunch = { socketPath: string; alive: () => boolean; stop: () => Promise<void> };
export type IDELaunchInput = { hostId: string; workspace: string; id: string; binary: string;
  settings: Record<string, unknown>; extensions: readonly string[]; prepare?: boolean; trustWorkspace?: boolean;
  onProfile?: (status: IDEProfileStatus) => void; signal?: AbortSignal };
export interface IDEHostTransport {
  canonicalDirectory(hostId: string, workspace: string): Promise<string>;
  launch(input: IDELaunchInput): Promise<IDELaunch>;
}

/** Fixed helper; variable input is base64 JSON, never shell source. Each host
 * owns its tools/data. A disconnected parent terminates its own child group. */
const HELPER = String.raw`
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
${IDE_PROFILE_HELPER}
const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
const cwd=fs.realpathSync(input.workspace);
if(!path.isAbsolute(cwd)||!fs.statSync(cwd).isDirectory()) throw Error('Project directory unavailable');
if(input.operation==='resolve'){process.stdout.write(JSON.stringify({cwd}));process.exit(0);}
const root=input.dataRoot?path.join(input.dataRoot,input.id):path.join(os.homedir(),'.local','share','codex-im-gateway','ide',input.id);
fs.mkdirSync(root,{recursive:true,mode:0o700});
fs.chmodSync(root,0o700);
const data=path.join(root,'data'),extensions=path.join(root,'extensions');
fs.mkdirSync(path.join(data,'User'),{recursive:true,mode:0o700});
// Seed a fresh profile, or add ONLY missing runtime defaults. Preserve JSONC,
// explicit user overrides, and the existing instance/trust identity.
const settings=path.join(data,'User','settings.json');
let settingsWarning;
if(!fs.existsSync(settings)) fs.writeFileSync(settings,JSON.stringify({...input.defaults,...input.settings,'remote.autoForwardPorts':false}),{mode:0o600,flag:'wx'});
else try{
 const before=fs.readFileSync(settings,'utf8'),after=seedSettings(before,{...input.defaults,...Object.fromEntries(Object.entries(input.settings).filter(([key])=>Object.hasOwn(input.defaults,key)))});
 if(before!==after){const tmp=settings+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,after,{mode:0o600,flag:'wx'});if(fs.readFileSync(settings,'utf8')!==before){fs.unlinkSync(tmp);throw Error('Settings changed');}fs.renameSync(tmp,settings);}
}catch{settingsWarning='settings-unmodified';}
const prefix=['--user-data-dir',data,'--extensions-dir',extensions];
const config=path.join(root,'config.yaml');
if(!fs.existsSync(config))fs.writeFileSync(config,'auth: none\ncert: false\n',{flag:'wx',mode:0o600});
prefix.push('--config',config);
let child,stopping=false,exitCode=0;
function kill(){if(stopping)return;stopping=true;if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{} setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}process.exit(exitCode);},3000).unref();}else process.exit(exitCode);}
process.on('SIGTERM',kill);process.on('SIGINT',kill);process.stdin.resume();process.stdin.on('end',kill);
const preparationDeadline=Date.now()+120000;
async function run(args){if(stopping||Date.now()>=preparationDeadline)throw Error('Cancelled or preparation deadline exceeded');return await new Promise((resolve,reject)=>{
 const command=child=cp.spawn(input.binary,args,{cwd,detached:true,stdio:['ignore','pipe','pipe']});let out='',timedOut=false,force;
 command.stdout.on('data',data=>{out=(out+data).slice(-256000);});command.stderr.resume();
 const timer=setTimeout(()=>{timedOut=true;try{process.kill(-command.pid,'SIGTERM');}catch{}force=setTimeout(()=>{try{process.kill(-command.pid,'SIGKILL');}catch{}},3000);},Math.min(60000,Math.max(1,preparationDeadline-Date.now())));
 function done(){clearTimeout(timer);clearTimeout(force);if(child===command)child=undefined;}
 command.once('error',error=>{done();reject(error);});command.once('close',code=>{done();code===0&&!timedOut&&!stopping?resolve(out):reject(Error('Extension preparation failed'));});
});}
const requested=[...new Set(input.extensions)],installed=new Map();let extensionWarning;
function report(phase,activeExtension){process.stdout.write('CIG_PROFILE '+JSON.stringify({phase,requested,installed:requested.filter(id=>installed.has(id)).map(id=>({id,version:installed.get(id)})),missing:requested.filter(id=>!installed.has(id)),...(activeExtension?{activeExtension}:{}),...(extensionWarning||settingsWarning?{warning:extensionWarning||settingsWarning}:{})})+'\n');}
async function listExtensions(){
 const text=await run([...prefix,'--list-extensions','--show-versions']);installed.clear();
 for(const line of text.split(/\r?\n/)){const match=/^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)@([a-zA-Z0-9.+-]{1,100})$/.exec(line.trim());if(match)installed.set(match[1].toLowerCase(),match[2]);}
}
(async()=>{
 report('checking');
 if(requested.length)try{
  await listExtensions();
  for(const id of requested){if(installed.has(id))continue;report('installing',id);await run([...prefix,'--install-extension',id]);await listExtensions();if(!installed.has(id))throw Error('Extension missing after successful install');}
 }catch{extensionWarning='extensions-unavailable';}
 report(extensionWarning?'error':'ready');
 if(input.prepare){if(extensionWarning)throw Error('Extensions unavailable');process.stdout.write('CIG_PREPARED\n');process.exit(0);}
 if(stopping)throw Error('Cancelled');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cig-ide-'));fs.chmodSync(temp,0o700);
 const socket=path.join(temp,'ide.sock');
 if(Buffer.byteLength(socket)>100) throw Error('IDE socket path exceeds platform limit');
 // Only an explicitly Gateway-approved directory session opts out of the
 // browser-local second trust prompt. No global VS Code setting is changed.
 const trust=input.trustWorkspace===true?['--disable-workspace-trust']:[];
 child=cp.spawn(input.binary,[...prefix,'--auth','none','--socket',socket,'--socket-mode','0600','--disable-proxy','--disable-telemetry',...trust,cwd],{cwd,detached:true,stdio:['ignore','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();child.on('error',()=>{process.stderr.write('code-server executable unavailable\n');process.exitCode=1;});
 child.on('close',code=>{try{fs.rmSync(temp,{recursive:true,force:true});}catch{}process.exit(code||0);});
 process.stdout.write('CIG_SOCKET '+JSON.stringify({socket})+'\n');
})().catch(()=>{process.stderr.write('IDE host preparation failed\n');exitCode=1;kill();});
`;

export class ProcessIDEHostTransport implements IDEHostTransport {
  constructor(private readonly options: { codexHome?: string; sshBin?: string; localDataRoot?: string } = {}) {}
  private invocation(hostId: string, input: object): { command: string; args: string[] } {
    const data = Buffer.from(JSON.stringify({ ...input, ...(hostId === "local" && this.options.localDataRoot ? { dataRoot: this.options.localDataRoot } : {}) })).toString("base64");
    if (hostId === "local") return { command: process.execPath, args: ["-e", HELPER, data] };
    const ssh = ideSshConnection(hostId, this.options);
    const helper = Buffer.from(HELPER).toString("base64");
    return { command: ssh.command, args: [...ssh.args, ssh.target,
      `exec node -e "eval(Buffer.from('${helper}','base64').toString())" '${data}'`] };
  }
  async canonicalDirectory(hostId: string, workspace: string): Promise<string> {
    const call = this.invocation(hostId, { operation: "resolve", workspace });
    const { stdout } = await exec(call.command, call.args, { timeout: 15_000, maxBuffer: 32_000, windowsHide: true })
      .catch(() => { throw new Error("无法读取项目目录；请检查主机 Node、SSH 连接和目录权限。"); });
    const result = JSON.parse(stdout) as { cwd: string };
    if (!path.posix.isAbsolute(result.cwd) || /[\r\n\0]/.test(result.cwd)) throw new Error("无效的项目目录");
    return result.cwd;
  }
  async launch(input: IDELaunchInput): Promise<IDELaunch> {
    if (input.signal?.aborted) throw new Error("IDE 启动已取消");
    const { onProfile, signal, ...payload } = input;
    const call = this.invocation(input.hostId, { ...payload, defaults: IDE_SETTING_DEFAULTS });
    const processChild = spawn(call.command, call.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stopping = false, hostReason = "unknown";
    processChild.stderr?.on("data", chunk => { hostReason = connectionReason(String(chunk)) ?? hostReason; });
    processChild.once("exit", (code, signal) => { if (!stopping) console.warn(`[codex-im-gateway] IDE host exited code=${code} signal=${signal} reason=${hostReason}`); });
    let tunnel: ChildProcess | undefined, temp: string | undefined;
    const stop = async () => {
      stopping = true;
      await Promise.all([terminate(tunnel), terminate(processChild)]);
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
    };
    try {
      const socket = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("IDE 启动或扩展准备超时；可检查主机网络后重试")), input.extensions.length ? 180_000 : 20_000);
        let buffer = "", settled = false, prepared = false, profile: IDEProfileStatus | undefined;
        const abort = () => finish(new Error("IDE 启动已取消"));
        const finish = (error?: Error, value?: string) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value!); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        processChild.once("error", () => finish(new Error("无法启动 IDE 主机进程")));
        processChild.once("close", code => input.prepare && code === 0 && prepared ? finish(undefined, "") : finish(new Error(profile?.warning === "extensions-unavailable"
          ? "所选扩展未安装完成；请检查 Open VSX 网络、扩展兼容性及目录权限后重试。"
          : "IDE 主机进程已退出；请检查 code-server、Node 和 SSH 配置")));
        processChild.stdout?.on("data", chunk => {
          buffer = (buffer + String(chunk)).slice(-32_000);
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (line === "CIG_PREPARED") prepared = true;
            if (line.startsWith("CIG_PROFILE ")) {
              const status = parseProfileStatus(line.slice(12), input.extensions);
              if (status) { profile = status; onProfile?.(status); }
            }
            if (!line.startsWith("CIG_SOCKET ")) continue;
            try { const value = JSON.parse(line.slice(11)).socket;
              if (typeof value !== "string" || !path.posix.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error();
              finish(undefined, value);
            } catch { finish(new Error("无效的 IDE 主机回执")); }
          }
        });
      });
      if (input.prepare || input.hostId === "local") return { socketPath: socket,
        alive: () => processChild.exitCode === null && !processChild.signalCode, stop };
      temp = fs.mkdtempSync(path.join(os.tmpdir(), "cig-tunnel-")); fs.chmodSync(temp, 0o700);
      const localSocket = path.join(temp, "ide.sock");
      const ssh = ideSshConnection(input.hostId, this.options);
      tunnel = spawn(ssh.command, [...ssh.args, "-o", "ExitOnForwardFailure=yes", "-N", "-L", `${localSocket}:${socket}`, ssh.target],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let tunnelReason = "unknown";
      tunnel.stderr?.on("data", chunk => { tunnelReason = connectionReason(String(chunk)) ?? tunnelReason; });
      tunnel.once("exit", (code, signal) => { if (!stopping) console.warn(`[codex-im-gateway] IDE tunnel exited code=${code} signal=${signal} reason=${tunnelReason}`); });
      // Attach before the first asynchronous boundary; spawn failure must never
      // become an unhandled EventEmitter error that takes the Gateway down.
      let tunnelFailed = false; tunnel.on("error", () => { tunnelFailed = true; });
      return { socketPath: localSocket, alive: () => !tunnelFailed && processChild.exitCode === null
        && !processChild.signalCode && tunnel!.exitCode === null && !tunnel!.signalCode, stop };
    } catch (error) { await stop(); throw error; }
  }
}

function parseProfileStatus(text: string, extensions: readonly string[]): IDEProfileStatus | undefined {
  try {
    const value = JSON.parse(text);
    if (!["checking", "installing", "ready", "error"].includes(value.phase) || !Array.isArray(value.installed)) return;
    const requested = [...extensions];
    const installed = value.installed.filter((item: { id?: unknown; version?: unknown }) => requested.includes(String(item?.id))
      && typeof item.version === "string" && /^[a-zA-Z0-9.+-]{1,100}$/.test(item.version));
    return { phase: value.phase, requested, installed: installed.map((item: { id: string; version: string }) => ({ id: item.id, version: item.version })),
      missing: requested.filter(id => !installed.some((item: { id: string }) => item.id === id)),
      ...(requested.includes(value.activeExtension) ? { activeExtension: value.activeExtension } : {}),
      ...(["extensions-unavailable", "settings-unmodified"].includes(value.warning) ? { warning: value.warning } : {}) };
  } catch { return; }
}

function connectionReason(stderr: string): string | undefined {
  for (const [pattern, code] of [[/Broken pipe|Connection reset|Connection closed|closed by remote/i, "connection-closed"],
    [/timed out|Timeout/i, "timeout"], [/administratively prohibited/i, "forwarding-denied"], [/Permission denied/i, "permission-denied"],
    [/executable unavailable/i, "binary-unavailable"]] as const) if (pattern.test(stderr)) return code;
}

async function terminate(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.stdin?.end(); child.kill("SIGTERM");
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 4_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
