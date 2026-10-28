import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import { IDEEndpointManager } from "../src/ide/endpoint-manager.js";

test("a failed entrance cleanup cannot skip closing project IDE processes",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-ide-close-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manager=new WorkspaceIDEManager({root,resolve:()=>undefined});
  const endpoints=new IDEEndpointManager(manager);
  const closed:string[]=[];
  manager.close=async()=>{closed.push("projects");};
  (endpoints as any).endpoints.set("failed",{server:{async close(){closed.push("failed");throw Error("entrance cleanup failed");}}});
  (endpoints as any).endpoints.set("other",{server:{async close(){closed.push("other");}}});
  await assert.rejects(endpoints.close(),/entrance cleanup failed|IDE.*停止|IDE.*关闭/);
  assert.deepEqual(closed.sort(),["failed","other","projects"]);
  assert.equal(manager.accessAvailable,false);
  assert.deepEqual(endpoints.statuses(),[]);
});
