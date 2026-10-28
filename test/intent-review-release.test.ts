import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

test("release cutovers claim exclusive ownership before an asynchronous readiness read",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-release-concurrency-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const repo=path.join(root,"repo"),state=path.join(root,"state");
  fs.mkdirSync(path.join(repo,"dist"),{recursive:true});fs.mkdirSync(path.join(state,"runtime"),{recursive:true});
  fs.writeFileSync(path.join(repo,"source.txt"),"source");fs.writeFileSync(path.join(repo,"dist/old.js"),"old");
  const digest=(s:string)=>crypto.createHash("sha256").update(s).digest("hex");
  let release!:()=>void,reads=0,nativeWrites=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const source=fs.readFileSync(new URL("../scripts/release-local.mjs",import.meta.url),"utf8")
    .replace(/^import .*;\n/gm,"").replace(/\bexport\s+/g,"")
    .replaceAll("import.meta.url",'"file:///fixture/scripts/release-local.mjs"').split("\nif (process.argv[1]")[0];
  const context=vm.createContext({fs,path,crypto,URL,AbortSignal,Date,console,
    fileURLToPath:()=>repo,process:{pid:process.pid,kill:process.kill},
    fetch:async()=>{reads++;await gate;throw Error("end isolated readiness probe");},
    execFileSync:(bin:string,args:string[])=>{
      if(bin==="git")return args[0]==="ls-files"?(args.includes("--others")?"":"source.txt\0"):"";
      if(args[0]==="print")return "pid = 111\n";
      nativeWrites++;throw Error("test forbids native launchd writes");
    }});
  vm.runInContext(source,context);
  const dirs=["a","b"].map(name=>path.join(root,name));
  for(const dir of dirs){fs.mkdirSync(path.join(dir,"dist"),{recursive:true});fs.writeFileSync(path.join(dir,"dist/new.js"),"new");
    fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify({status:"sealed",commit:"commit",
      source:digest(`source.txt\0${digest("source")}`),previousPid:111,previous:context.treeHash(path.join(repo,"dist")),compiled:context.treeHash(path.join(dir,"dist"))}));}
  const args=(dir:string)=>["switch","--dir",dir,"--state",state,"--origin","http://127.0.0.1:18788","--service","gui/501/fixture","--plist",path.join(root,"fixture.plist")];
  const first=Promise.resolve(context.main(args(dirs[0]))).catch(error=>error);
  await new Promise(resolve=>setImmediate(resolve));
  const firstReads=reads;let secondError:Error|undefined;
  const second=Promise.resolve(context.main(args(dirs[1]))).catch(error=>{secondError=error;return error;});
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(firstReads>0,"first release is waiting at its read-only readiness boundary");
    assert.match(secondError?.message??"",/release.*(?:lock|progress|ownership)|发布.*(?:锁|进行)/i);
    assert.equal(reads,firstReads,"another cutover cannot pass preconditions while the owner awaits health");
    assert.equal(nativeWrites,0);
  }finally{release();await Promise.all([first,second]);}
  assert.equal(fs.existsSync(path.join(state,"release.lock")),false,"failed preflight releases its ownership");
});

test("release ownership closes its descriptor and does not erase an unverifiable lock if fstat fails", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-release-fstat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(new URL("../scripts/release-local.mjs", import.meta.url), "utf8");
  const helper = source.slice(source.indexOf("async function withReleaseOwnership("), source.indexOf("export async function main("));
  let closed = 0, actions = 0;
  const context = vm.createContext({ fs: { ...fs, fstatSync() { throw Error("injected fstat failure"); }, closeSync(fd: number) { closed++; fs.closeSync(fd); } }, path, process, Date });
  vm.runInContext(helper, context);
  await assert.rejects(context.withReleaseOwnership(root, async () => { actions++; }), /injected fstat failure/);
  assert.equal(closed, 1); assert.equal(actions, 0);
  assert.equal(fs.existsSync(path.join(root, "release.lock")), true, "an identity that could not be verified must not be unlinked");
});
