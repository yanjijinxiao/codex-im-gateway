import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadEventHub } from "../src/server/thread-event-hub.js";

test("a failed in-flight follow scan cannot skip suspending its local presentation timers",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-follow-close-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const hub:any=new ThreadEventHub({filePath:path.join(root,"follow.json"),subscriptions:()=>[],backend:()=>({readThreadSnapshot:async()=>{throw Error("unused");}})});
  let suspended=0;
  hub.streams.set("stream",{async suspend(){suspended++;}});
  hub.scan=Promise.reject(Error("observer journal write failed"));
  await assert.rejects(hub.stop(),/observer journal write failed|跟随.*停止/);
  assert.equal(suspended,1);
  assert.equal(hub.streams.size,0);
  assert.equal(hub.stopped,true);
});

test("one slow subscription cannot delay publishing a healthy snapshot or targeted synchronization", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-follow-isolation-"));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let reads = 0;
  const client = { async sendText() { return { messageId: "ack" }; } };
  const subscriptions = ["slow", "healthy"].map(key => ({ key, hostId: "local", threadId: key, recipientId: key, managed: false, client }));
  const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), subscriptions: () => subscriptions,
    backend: () => ({ async readThreadSnapshot(threadId: string) {
      if (threadId === "slow") { entered.resolve(); await release.promise; } else reads++;
      return { state: { threadId, persistence: "active" as const, runtimeStatus: "idle" as const, activeFlags: [] }, turns: [] };
    } }) });
  t.after(async () => { release.resolve(); await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const pending = hub.refresh(); await entered.promise;
  for (let i = 0; i < 100 && hub.status("healthy").status !== "synced"; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(hub.status("healthy").status, "synced");
  assert.equal((await hub.synchronize("healthy")).status, "synced"); assert.equal(reads, 2);
  release.resolve(); await pending;
});
