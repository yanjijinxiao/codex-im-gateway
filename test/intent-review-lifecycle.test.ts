import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import path from "node:path";
import { EventEmitter } from "node:events";

test("startup failure still closes HTTP, optional services and the lock if account cleanup rejects",async()=>{
  let source=fs.readFileSync(new URL("../src/server/index.ts",import.meta.url),"utf8");
  const parsed=ts.createSourceFile("index.ts",source,ts.ScriptTarget.Latest,true);
  source=parsed.statements.filter(node=>!ts.isImportDeclaration(node)&&!ts.isExpressionStatement(node)).map(node=>node.getFullText(parsed)).join("\n").replaceAll("import.meta.url",'"file:///fixture/server/index.js"');
  const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^#![^\n]*\n/,"");
  const helperFile=new URL("../src/server/cleanup.ts",import.meta.url);
  const helper=fs.existsSync(helperFile)?ts.transpileModule(fs.readFileSync(helperFile,"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/\bexport\s+/g,""):"";
  const closed:string[]=[];
  const context=vm.createContext({console,process:{env:{CODEX_IM_GATEWAY_OPEN:"0"},pid:123},fileURLToPath:()=>"/fixture",preferredStateDir:()=>"/tmp/unused",resolveStatePaths:()=>({root:"/tmp/unused",taskboardDir:"/tmp/unused/taskboard"}),loadConfig:()=>({taskboardEnabled:true}),
    acquireServiceProcessLock:()=>({release(){closed.push("lock");}}),AccountManager:class{async startAll(){throw Error("startup failed");}async stopAll(){closed.push("accounts");throw Error("cleanup failed");}},
    TaskboardLifecycle:class{async apply(){}async close(){closed.push("taskboard");}},startLocalHttpServer:async()=>({url:"http://fixture",async close(){closed.push("http");}})});
  vm.runInContext(helper+output+"\nglobalThis.auditMain=main;",context);
  let error:any;try{await context.auditMain();}catch(failure){error=failure;}
  assert.deepEqual([...closed].sort(),["accounts","http","lock","taskboard"]);
  assert.ok(error.errors?.some((item:Error)=>item.message==="startup failed"),"retain the original startup error alongside cleanup failure");
});

test("restart scheduling waits for helper spawn and reports a failed launch",async()=>{
  const source=fs.readFileSync(new URL("../src/server/restart.ts",import.meta.url),"utf8"),parsed=ts.createSourceFile("restart.ts",source,ts.ScriptTarget.Latest,true);
  const code=parsed.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getFullText(parsed)).join("\n").replaceAll("import.meta.url",'"file:///fixture/server/restart.js"');
  const output=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/\bexport\s+/g,"");
  const child=new EventEmitter() as EventEmitter&{unref:()=>void};child.unref=()=>{};
  const context=vm.createContext({path,URL,console:{error(){}},process:{env:{},execPath:"/fixture/node"},fileURLToPath:()=>"/fixture/restart-helper.js",spawn:()=>child,fs:{existsSync:()=>true,openSync:()=>1,closeSync(){}}});
  vm.runInContext(output,context);let settled=false,emitted=false;
  const work=Promise.resolve(context.launchRestartHelper({parentPid:123,entryPath:"/fixture/server/index.js",stateDir:"/tmp/fixture",port:8787})).then(()=>{settled=true;});
  try{await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,"do not exit the old service before helper startup is known");
    emitted=true;child.emit("error",Error("spawn failed"));await assert.rejects(work,/spawn failed/);
  }finally{if(!emitted)child.emit("error",Error("cleanup"));await work.catch(()=>{});}
});
