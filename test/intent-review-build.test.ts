import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { UpdateManager } from "../src/server/update-manager.js";

for (const inherited of [false, true]) test(`Windows source installer runs npm through Node (inherited CLI: ${inherited})`, async () => {
  const source = fs.readFileSync(new URL("../scripts/install-local.mjs", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replaceAll("import.meta.url", '"file:///fixture/scripts/install-local.mjs"')
    .split(/\n(?:main\(\)\.catch|if \(process\.argv\[1\])/)[0];
  let invocation: { command: string; args: string[] } | undefined;
  const cli = inherited ? "C:\\custom npm\\bin\\npm-cli.js" : "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const context = vm.createContext({path, Error, fileURLToPath: () => "/fixture/scripts/install-local.mjs",
    process: {argv: ["node", "installer"], platform: "win32", versions: {node:"22.0.0"},
      execPath:"C:\\Program Files\\nodejs\\node.exe", env: inherited ? {npm_execpath:cli} : {}},
    existsSync: (file: string) => file === cli,
    stat: async () => { throw Object.assign(Error("missing"), {code:"ENOENT"}); },
    spawn: (command: string, args: string[]) => { invocation = {command, args:[...args]}; throw Error("stop before external execution"); }
  });
  vm.runInContext(source + "\nglobalThis.runInstaller=main;", context);
  await assert.rejects(context.runInstaller(), /stop before external execution/);
  assert.deepEqual(invocation, {command:"C:\\Program Files\\nodejs\\node.exe", args:[cli,"ci","--ignore-scripts"]});
});

test("a failed ordinary build cannot keep an old sealed artifact identity", {skip:process.platform === "win32"}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"gateway-intent-build-"));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ["scripts","bin","dist"]) fs.mkdirSync(path.join(root,dir));
  const prepare = new URL("../scripts/prepare-build.mjs",import.meta.url);
  if(fs.existsSync(prepare)) fs.copyFileSync(prepare,path.join(root,"scripts/prepare-build.mjs"));
  const identity = path.join(root,"dist/build-info.json");
  fs.writeFileSync(identity,JSON.stringify({commit:"old-sealed-commit",sourceHash:"old-source"}));
  fs.writeFileSync(path.join(root,"bin/tsc"),'#!/bin/sh\necho partial > dist/server.js\nexit 1\n',{mode:0o700});
  const pkg=JSON.parse(fs.readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  assert.throws(() => execFileSync("/bin/sh",["-c",pkg.scripts["build:bridge"]],{
    cwd:root,env:{...process.env,PATH:`${path.join(root,"bin")}:${path.dirname(process.execPath)}:${process.env.PATH}`},stdio:"pipe"
  }));
  assert.equal(fs.existsSync(path.join(root,"dist/server.js")),true,"compiler reached partial-write failure");
  assert.equal(fs.existsSync(identity),false,"partial artifact must not advertise a previous seal");
});

test("source deployments report their real update capability without querying npm",async()=>{
  let fetches=0;
  const manager=new UpdateManager({currentVersion:"0.4.0",packageRoot:"/workspace/gateway",platform:"darwin",
    fetch:async()=>{fetches++;return new Response(JSON.stringify({version:"99.0.0"}));}});
  const status=await manager.check(true);
  assert.equal(status.updateMethod,"source");
  assert.equal(status.updateAvailable,false);
  assert.equal(status.latestVersion,undefined);
  assert.match(status.message??"",/源码/);
  await assert.rejects(manager.installLatest(),/源码更新/);
  assert.equal(fetches,0);
});
