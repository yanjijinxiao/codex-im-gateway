import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { AppServerTransport } from "./app-server-transport.js";

export type CodexInboundFile = { path: string; label: string; kind: "image" | "file" | "video" | "audio" };
export type StageInboundFiles = (files: CodexInboundFile[], options: {
  hostId?: string; scope: string; maxBytes: number;
}) => Promise<CodexInboundFile[]>;

/** Fixed receiver: no filenames or paths interpolated into a shell command. */
export const INBOUND_FILE_RECEIVER = String.raw`
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
let parts=[],size=0;
process.stdin.on('data',chunk=>{size+=chunk.length;if(size>100*1024*1024+16384)process.exit(2);parts.push(chunk);});
process.stdin.on('end',()=>{try{
 const input=Buffer.concat(parts),nl=input.indexOf(10);
 if(nl<0||nl>16384)throw Error();
 const h=JSON.parse(input.subarray(0,nl).toString()),body=input.subarray(nl+1);
 if(!/^[a-f0-9]{64}$/.test(h.scope)||!/^[a-f0-9]{64}$/.test(h.hash)||body.length!==h.size
 ||crypto.createHash('sha256').update(body).digest('hex')!==h.hash)throw Error();
 if(typeof h.name!=='string'||!/^\w[\w.-]{0,150}$/.test(h.name))throw Error();
 const home=fs.realpathSync(os.homedir());let dir=home;
 for(const name of ['.codex-im-gateway','inbound',h.scope]){
   dir=path.join(dir,name);if(!fs.existsSync(dir))fs.mkdirSync(dir,{mode:0o700});
   if(fs.lstatSync(dir).isSymbolicLink()||!fs.statSync(dir).isDirectory()||fs.realpathSync(dir)!==dir)throw Error();
 }
 const target=path.join(dir,h.hash+'-'+h.name);
 if(fs.existsSync(target)){
   if(!fs.lstatSync(target).isFile()||fs.lstatSync(target).isSymbolicLink()
     ||crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==h.hash)throw Error();
 }else fs.writeFileSync(target,body,{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify({path:target,hash:h.hash}));
}catch{process.stderr.write('inbound file staging failed');process.exitCode=1;}});
`;

export async function stageRemoteFiles(files: CodexInboundFile[], scope: string, maxBytes: number,
  transport: AppServerTransport): Promise<CodexInboundFile[]> {
  // Only the same SSH transport used to route Codex may transfer files. A custom
  // websocket/other transport needs its own staging port, never guessed SSH.
  if (transport.mode !== "remote-daemon" || !transport.args?.length
    || !/(?:^|\/)ssh$/.test(transport.command)) throw new Error("Remote backend has no attachment staging transport");
  const encoded = Buffer.from(INBOUND_FILE_RECEIVER).toString("base64");
  const args = [...transport.args.slice(0, -1), `exec node -e "eval(Buffer.from('${encoded}','base64').toString())"`];
  const output: CodexInboundFile[] = [];
  for (const file of files) {
    const fd = fs.openSync(file.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let body: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > Math.min(maxBytes, 100 * 1024 * 1024)) throw new Error("Inbound file exceeds staging limit");
      const bytes = Buffer.alloc(stat.size + 1);
      let read = 0, next = 0;
      do { next = fs.readSync(fd, bytes, read, bytes.length - read, read); read += next; } while (next && read < bytes.length);
      if (read !== stat.size) throw new Error("Inbound file changed during staging");
      body = bytes.subarray(0, read);
    } finally { fs.closeSync(fd); }
    const hash = crypto.createHash("sha256").update(body).digest("hex");
    const name = file.label.replace(/[^\w.-]/g, "_").replace(/^\W+/, "").slice(0, 150) || "attachment";
    const header = JSON.stringify({ name, size: body.length, hash, scope: crypto.createHash("sha256").update(scope).digest("hex") });
    const remotePath = await new Promise<string>((resolve, reject) => {
      const child = spawn(transport.command, args, { stdio: ["pipe", "pipe", "pipe"] });
      let reply = "", excessive = false;
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Remote attachment staging timed out")); }, 30_000);
      child.stdout.on("data", data => { reply += data.toString(); if (reply.length > 8192) { excessive = true; child.kill("SIGTERM"); } });
      child.stderr.resume(); // Never log SSH/user/provider credentials.
      child.stdin.on("error", () => undefined);
      child.on("error", () => { clearTimeout(timer); reject(new Error("Remote attachment staging transport unavailable")); });
      child.on("close", code => {
        clearTimeout(timer);
        try {
          if (code !== 0 || excessive) throw new Error();
          const result = JSON.parse(reply);
          if (result.hash !== hash || typeof result.path !== "string" || !result.path.startsWith("/")
            || !result.path.endsWith(`/${hash}-${name}`)) throw new Error();
          resolve(result.path);
        } catch { reject(new Error("Remote attachment staging failed; input was not submitted")); }
      });
      child.stdin.end(Buffer.concat([Buffer.from(header + "\n"), body]));
    });
    output.push({ ...file, path: remotePath });
  }
  return output;
}
