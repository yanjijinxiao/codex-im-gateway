import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {NativeQueueCoordinator} from "../../../src/bridge/native-queue.ts";
import {TaskboardLifecycle} from "../../../src/taskboard/lifecycle.ts";

test("PROBE: invalid replacement Taskboard URL stops the old service before validation",async()=>{
 const lifecycle=new TaskboardLifecycle("/tmp/unused-audit-state");let stopped=0;
 (lifecycle as any).service={async close(){stopped++;}};(lifecycle as any).key="old-service";
 await assert.rejects(lifecycle.apply({taskboardEnabled:true,taskboardUrl:"http://example.invalid:4876",codexBin:"codex"}));
 assert.equal(stopped,1);assert.equal((lifecycle as any).service,undefined);
 await lifecycle.close();
});
