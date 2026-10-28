import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import type { ChannelActionCard } from "../src/channels/action-card.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

for (const selection of ["model", "effort"] as const) test(`native ${selection} choice retains its identity after the catalog is reordered`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-choice-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const project = store.createProject("Project", root), session = store.createSession("actor", root, "Session", project.id);
  const cards: ChannelActionCard[] = [];
  let reversed = false;
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, stateStore: store,
    listCodexModels: async () => {
      const models = ["alpha", "beta"].map(model => ({ model, displayName: model, description: "synthetic", isDefault: model === "alpha", defaultEffort: "medium",
        supportedEfforts: (reversed ? ["high", "medium", "low"] : ["low", "medium", "high"]).map(effort => ({ effort, description: effort })) }));
      return reversed ? models.reverse() : models;
    },
    weixin: { async sendText() { return { messageId: "ack" }; }, async sendActionCard(input: { card: ChannelActionCard }) { cards.push(input.card); return { messageId: "card" }; } },
    runner: { async getRuntimeInfo() { return { model: "alpha", effort: "medium" }; } } as never });
  t.after(() => service.suspendUserInputs());
  const send = (id: string, text: string) => service.handleMessage({ id, senderId: "actor", text, attachments: [], raw: {} });
  await send("show", `/${selection}`);
  const action = cards[0].actionGroups.flat()[0].value;
  assert.equal(action.version, 1);
  reversed = true;
  await service.handleMessage({ id: "legacy-click", senderId: "actor", text: `/${selection} 1`, attachments: [], interaction: { kind: "card", messageId: "old-card" }, raw: {} });
  assert.equal(store.getSession(session.id)?.[selection], undefined);
  await send("click", `/${action.command} ${action.arg}`);
  assert.equal(store.getSession(session.id)?.[selection], selection === "model" ? "alpha" : "low");
});

test("a project button from an earlier list cannot silently target the new row at the same index", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-project-choice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)), cards: ChannelActionCard[] = [];
  let reversed = false;
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, stateStore: store,
    listCodexProjects: () => {
      const rows = ["alpha", "beta"].map(name => ({ name, workspace: path.join(root, name), projectId: name, hostId: "local", lastUsedAt: "", sessionCount: 0 }));
      return reversed ? rows.reverse() : rows;
    },
    weixin: { async sendText() { return { messageId: "ack" }; }, async sendActionCard(input: { card: ChannelActionCard }) { cards.push(input.card); return { messageId: "card" }; } },
    runner: {} as never });
  t.after(() => service.suspendUserInputs());
  const send = (id: string, text: string) => service.handleMessage({ id, senderId: "actor", text, attachments: [], raw: {} });
  await send("show", "/project");
  const old = cards[0].actionGroups.flat()[0].value;
  reversed = true; await send("refresh", "/project");
  await send("old-click", `/${old.command} ${old.arg}`);
  assert.equal(store.getActiveProject("actor"), undefined);
  await service.handleMessage({ id: "legacy-click", senderId: "actor", text: "/project C1", attachments: [], interaction: { kind: "card", messageId: "old-card" }, raw: {} });
  assert.equal(store.getActiveProject("actor"), undefined);
  const fresh = cards[1].actionGroups.flat()[0].value;
  await send("new-click", `/${fresh.command} ${fresh.arg}`);
  assert.equal(store.getActiveProject("actor")?.sourceProjectId, "beta");
});

for (const model of ["1", "default"]) test(`native model choice distinguishes the model ID ${model} from command syntax`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-model-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const project = store.createProject("Project", root), session = store.createSession("actor", root, "Session", project.id);
  const cards: ChannelActionCard[] = [];
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, stateStore: store,
    listCodexModels: async () => ["other", model].map(id => ({ model: id, displayName: id, description: "synthetic",
      isDefault: false, defaultEffort: "medium", supportedEfforts: [] })),
    weixin: { async sendText() { return { messageId: "ack" }; }, async sendActionCard(input: { card: ChannelActionCard }) { cards.push(input.card); return { messageId: "card" }; } },
    runner: { async getRuntimeInfo() { return { model: "other" }; } } as never });
  t.after(() => service.suspendUserInputs());
  await service.handleMessage({ id: "show", senderId: "actor", text: "/model", attachments: [], raw: {} });
  const action = cards[0].actionGroups.flat()[1].value;
  await service.handleMessage({ id: "click", senderId: "actor", text: `/${action.command} ${action.arg}`, attachments: [],
    interaction: { kind: "card", messageId: "card" }, raw: {} });
  assert.equal(store.getSession(session.id)?.model, model);
  await service.handleMessage({ id: "reset", senderId: "actor", text: "/model default", attachments: [], raw: {} });
  assert.equal(store.getSession(session.id)?.model, undefined, "manual default still resets inheritance");
});
