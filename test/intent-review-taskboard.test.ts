import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startEmbeddedTaskboard } from "../src/taskboard/embedded-server.js";
import { TaskboardClient } from "../src/taskboard/client.js";
import { TaskboardLifecycle } from "../src/taskboard/lifecycle.js";

test("the supported IPv4 managed origin is reachable and can be reused", async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-intent-ipv6-listen-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const options={dataDirectory:root,port:0};
  const service=await startEmbeddedTaskboard(options);t.after(()=>service.close());
  assert.equal(new URL(service.url).hostname,"127.0.0.1");
  assert.equal((await fetch(`${service.url}/health`)).status,200);
  const reuse=await startEmbeddedTaskboard({...options,port:Number(new URL(service.url).port)});await reuse.close();
  assert.equal((await fetch(`${service.url}/health`)).status,200,"a reused listener is not owned by the caller");
});

test("unsupported IPv6 cannot stop or replace the working IPv4 listener",async()=>{
  const starts:unknown[]=[];let stops=0;const lifecycle=new TaskboardLifecycle("/tmp/unused",async input=>{starts.push(input);return {url:"http://127.0.0.1:47823",async close(){stops++;}};});
  try{await lifecycle.apply({taskboardEnabled:true,taskboardUrl:"http://127.0.0.1:47823",codexBin:"codex"});
    await assert.rejects(lifecycle.apply({taskboardEnabled:true,taskboardUrl:"http://[::1]:47823",codexBin:"codex"}),/loopback/);
    assert.equal(starts.length,1);assert.equal(stops,0);
  }finally{await lifecycle.close();}
});

test("Taskboard origin cannot contain ignored paths, credentials, query or fragment",()=>{
  for(const baseUrl of ["http://127.0.0.1:47823/prefix","http://user:password@localhost:47823","http://[::1]:47823/?secret=x","http://localhost:47823/#other"])
    assert.throws(()=>new TaskboardClient({baseUrl}),/loopback origin/);
});
