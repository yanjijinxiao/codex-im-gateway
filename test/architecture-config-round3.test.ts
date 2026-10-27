import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {NativeQueueCoordinator} from "../src/bridge/native-queue.ts";
import {TaskboardLifecycle} from "../src/taskboard/lifecycle.ts";

test("regression: invalid Taskboard configuration leaves the old service running",async()=>{
 const lifecycle=new TaskboardLifecycle("/tmp/unused-audit-state");let stopped=0;
 (lifecycle as any).service={async close(){stopped++;}};(lifecycle as any).key="old-service";
 await assert.rejects(lifecycle.apply({taskboardEnabled:true,taskboardUrl:"http://example.invalid:4876",codexBin:"codex"}));
 assert.equal(stopped,0);assert.ok((lifecycle as any).service);
 await lifecycle.close();
});
