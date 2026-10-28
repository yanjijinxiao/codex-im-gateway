import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InteractionRoutingJournal, type InteractionDestination } from "../src/bridge/interaction-routing.js";

test("failed primary-routing configuration cannot publish a different in-memory question destination",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-intent-primary-")),file=path.join(root,"routing.json");t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const first:InteractionDestination={accountId:"one",sessionId:"session-one",recipientId:"room-one",hostId:"local",threadId:"thread"};
  const second={...first,sessionId:"session-two",recipientId:"room-two"},bindings=[first,second];
  const journal=new InteractionRoutingJournal(file);journal.setPrimary(first);journal.rememberTurn(first,"running");
  const before=fs.readFileSync(file,"utf8"),rename=fs.renameSync;
  t.mock.method(fs,"renameSync",function(from:fs.PathLike,to:fs.PathLike){if(String(to)===file)throw Object.assign(Error("disk full"),{code:"ENOSPC"});return rename(from,to);});
  assert.throws(()=>journal.setPrimary(second),/disk full/);
  assert.deepEqual(journal.resolve("local","thread",bindings).destination,first);
  assert.deepEqual(journal.resolve("local","thread",bindings,"running").destination,first);
  assert.equal(fs.readFileSync(file,"utf8"),before);t.mock.restoreAll();
  journal.setPrimary(second);assert.deepEqual(journal.resolve("local","thread",bindings).destination,second);
  assert.deepEqual(new InteractionRoutingJournal(file).resolve("local","thread",bindings,"running").destination,first);
});
