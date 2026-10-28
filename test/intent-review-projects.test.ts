import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexDesktopProjects } from "../src/server/codex-projects.js";
import { AccountManager } from "../src/server/account-manager.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { saveAccount } from "../src/weixin/accounts.js";

test("an unavailable primary project root remains an explicit unavailable native identity and blocks cached IDE scope",async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"gateway-unavailable-project-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const primary=path.join(root,"primary"),sibling=path.join(root,"sibling"),home=path.join(root,"home");
  fs.mkdirSync(sibling);fs.mkdirSync(home);
  fs.writeFileSync(path.join(home,".codex-global-state.json"),JSON.stringify({"local-projects":{native:{id:"native",name:"Project",rootPaths:[primary,sibling]}}}));
  const paths=resolveStatePaths(path.join(root,"state"));
  saveAccount(paths,{accountId:"account",token:"synthetic",userId:"actor",baseUrl:"https://example.invalid",enabled:false});
  const store=new RuntimeStateStore(accountStatePaths(paths,"account"));
  const project=store.createProject("Project",primary,{sourceProjectId:"native",rootPaths:[primary,sibling]});
  const session=store.createSession("chat",primary,"Task",project.id);
  const manager=new AccountManager({paths,configProvider:()=>({...defaultConfig(root),codexBackend:"app-server"}),ideProjectsProvider:()=>readCodexDesktopProjects(home)});
  t.after(()=>manager.stopAll());
  const rows=readCodexDesktopProjects(home);
  assert.equal(rows.length,1);
  assert.equal(rows[0].projectId,"native");assert.equal(rows[0].available,false);
  assert.deepEqual(rows[0].rootPaths,[primary,sibling]);
  assert.equal(manager.ideWorkspace("account",session.id),undefined,"unavailable current catalog must not authorize cached roots");
  fs.mkdirSync(primary);
  assert.equal(readCodexDesktopProjects(home)[0].available,true);
  assert.deepEqual(manager.ideWorkspace("account",session.id)?.rootPaths,[primary,sibling]);
});

test("a local session path alias does not duplicate the primary root in a multi-root IDE scope", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-ide-root-alias-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary"), alias = path.join(root, "alias"), sibling = path.join(root, "sibling");
  fs.mkdirSync(primary); fs.mkdirSync(sibling); fs.symlinkSync(primary, alias, "dir");
  const paths = resolveStatePaths(path.join(root, "state"));
  saveAccount(paths, { accountId: "account", token: "synthetic", userId: "actor", baseUrl: "https://example.invalid", enabled: false });
  const store = new RuntimeStateStore(accountStatePaths(paths, "account"));
  const project = store.createProject("Project", alias, { sourceProjectId: "native", rootPaths: [alias, sibling] });
  const session = store.createSession("chat", alias, "Task", project.id);
  const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), codexBackend: "app-server" }),
    ideProjectsProvider: () => [{ name: "Project", workspace: primary, rootPaths: [primary, sibling], projectId: "native", hostId: "local", lastUsedAt: "", sessionCount: 0, projectKind: "local", available: true }] });
  t.after(() => manager.stopAll());
  assert.deepEqual(manager.ideWorkspace("account", session.id)?.rootPaths, [alias, sibling]);
});
