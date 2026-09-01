import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

function createStore(t: test.TestContext): RuntimeStateStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new RuntimeStateStore(resolveStatePaths(root));
}

test("keeps a channel actor separate from its conversation scope", (t) => {
  const store = createStore(t);

  store.rememberChannelIdentity("ou_pending", "oc_chat", false);

  assert.equal(store.getLastActiveActorId(), "ou_pending");
  assert.equal(store.getLastActiveSenderId(), "oc_chat");
  assert.equal(store.getLastAuthorizedSenderId(), undefined);
  assert.deepEqual(store.listPairedSenderIds(), []);

  store.setPairedSenderIds(["ou_pending"]);
  store.rememberChannelIdentity("ou_pending", "oc_chat", true);
  assert.equal(store.getLastAuthorizedActorId(), "ou_pending");
  assert.equal(store.getLastAuthorizedSenderId(), "oc_chat");
  assert.equal(store.getAuthorizedConversation("ou_pending"), "oc_chat");
  assert.equal(store.getAuthorizedConversation("ou_other"), undefined);
});

test("uses the matching legacy authorized identity until an actor link is persisted", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
  fs.writeFileSync(paths.statePath, JSON.stringify({
    pairedSenderIds: ["oc_legacy_room"],
    lastAuthorizedActorId: "ou_legacy_owner",
    lastAuthorizedSenderId: "oc_legacy_room"
  }));

  const store = new RuntimeStateStore(paths);

  assert.equal(store.getAuthorizedConversation("ou_legacy_owner"), "oc_legacy_room");
  assert.equal(store.getAuthorizedConversation("ou_other"), undefined);
});

test("creates and activates a managed session for a sender", (t) => {
  const store = createStore(t);
  const first = store.ensureActiveSession("alice@im.wechat", "/work/one");
  const same = store.ensureActiveSession("alice@im.wechat", "/work/two");

  assert.equal(same.id, first.id);
  assert.equal(store.getWorkspace("alice@im.wechat"), path.resolve("/work/one"));
  assert.equal(store.listSessions().length, 1);
});

test("preserves Codex Desktop routing metadata on a remote project", (t) => {
  const store = createStore(t);
  const project = store.createProject("Remote", "/home/admin/project", {
    sourceProjectId: "desktop-project-id",
    projectKind: "remote",
    hostId: "remote-ssh-discovered:devbox"
  });
  const session = store.createSession("alice@im.wechat", project.workspace, "Remote session", project.id);

  assert.deepEqual({
    sourceProjectId: store.getProject(project.id)?.sourceProjectId,
    projectKind: store.getProject(project.id)?.projectKind,
    hostId: store.getProject(project.id)?.hostId,
    sessionProjectId: session.projectId
  }, {
    sourceProjectId: "desktop-project-id",
    projectKind: "remote",
    hostId: "remote-ssh-discovered:devbox",
    sessionProjectId: project.id
  });
});

test("backfills Codex Desktop routing metadata on an existing project", (t) => {
  const store = createStore(t);
  const project = store.createProject("Bridge", "/work/bridge");

  const updated = store.updateProjectMetadata(project.id, {
    sourceProjectId: "desktop-project-id",
    projectKind: "local"
  });

  assert.equal(updated.sourceProjectId, "desktop-project-id");
  assert.equal(updated.projectKind, "local");
});

test("supports create, rename, switch, reset, and delete", (t) => {
  const store = createStore(t);
  const first = store.createSession("alice@im.wechat", "/work/one", "第一项");
  store.setThread("alice@im.wechat", "thread-one");
  const second = store.createSession("alice@im.wechat", "/work/two", "第二项");

  assert.equal(store.getActiveSession("alice@im.wechat")?.id, second.id);
  store.renameSession(second.id, "发布准备");
  assert.equal(store.getActiveSession("alice@im.wechat")?.title, "发布准备");

  store.activateSession(first.id);
  assert.equal(store.getThread("alice@im.wechat"), "thread-one");
  store.resetSession(first.id);
  assert.equal(store.getThread("alice@im.wechat"), undefined);

  store.deleteSession(first.id);
  assert.equal(store.getActiveSession("alice@im.wechat")?.id, second.id);
  assert.equal(store.listSessions().length, 1);
});

test("persists a prompt preview without changing the session activity time", (t) => {
  const store = createStore(t);
  const session = store.createSession("alice@im.wechat", "/work/one", "历史会话");

  store.setSessionPromptPreview(session.id, "  分析   项目方案  ");

  const updated = store.getSession(session.id);
  assert.equal(updated?.lastPromptPreview, "分析 项目方案");
  assert.equal(updated?.updatedAt, session.updatedAt);
});

test("replaces a generated Bridge session title with the first clean user preview", (t) => {
  const store = createStore(t);
  const session = store.createSession("alice@im.wechat", "/work/one");

  store.setSessionPromptPreview(session.id, "本机装的云壳是什么？");

  assert.equal(store.getSession(session.id)?.title, "本机装的云壳是什么？");
});

test("keeps sessions for different senders independent", (t) => {
  const store = createStore(t);
  const alice = store.createSession("alice@im.wechat", "/alice", "Alice");
  const bob = store.createSession("bob@im.wechat", "/bob", "Bob");
  store.activateSession(alice.id);
  store.setThread("alice@im.wechat", "thread-alice");
  store.activateSession(bob.id);
  store.setThread("bob@im.wechat", "thread-bob");

  assert.equal(store.getThread("alice@im.wechat"), "thread-alice");
  assert.equal(store.getThread("bob@im.wechat"), "thread-bob");
  assert.equal(store.getWorkspace("alice@im.wechat"), path.resolve("/alice"));
  assert.equal(store.getWorkspace("bob@im.wechat"), path.resolve("/bob"));
});

test("manages projects and keeps sessions attached to their project", (t) => {
  const store = createStore(t);

  // Given an account-local project
  const project = store.createProject("嘉兴AI社区", "/work/jiaxing");

  // When a task is created inside it
  const session = store.createSession("alice@im.wechat", project.workspace, "整理创业想法", project.id);

  // Then project metadata and task ownership persist together
  assert.equal(store.listProjects()[0]?.name, "嘉兴AI社区");
  assert.equal(store.getSession(session.id)?.projectId, project.id);
  assert.equal(store.renameProject(project.id, "嘉兴 AI 社区").name, "嘉兴 AI 社区");
});

test("keeps project selection, interaction mode, and llm-wiki Q&A sessions independent", (t) => {
  const store = createStore(t);
  const project = store.createProject("产品研发", "/work/product");
  const knowledgeBase = store.createKnowledgeBase("产品 Wiki", "/knowledge/product", {
    engineRoot: "/tools/llm-wiki",
    stateDir: "/knowledge/state"
  });
  store.bindProjectKnowledgeBase(project.id, knowledgeBase.id);

  store.activateProject("alice@im.wechat", project.id);
  store.setInteractionMode("alice@im.wechat", "qa");
  const qa = store.createSession(
    "alice@im.wechat",
    project.workspace,
    "问答 · 产品 Wiki",
    project.id,
    "qa",
    knowledgeBase.id
  );
  const chat = store.createSession("alice@im.wechat", project.workspace, "实现功能", project.id);

  assert.equal(store.getActiveProject("alice@im.wechat")?.id, project.id);
  assert.equal(store.getInteractionMode("alice@im.wechat"), "qa");
  assert.equal(store.getActiveQaSession("alice@im.wechat")?.id, qa.id);
  assert.equal(store.getActiveSession("alice@im.wechat")?.id, chat.id);
  assert.equal(store.listProjects()[0]?.knowledgeBaseId, knowledgeBase.id);
  assert.equal(store.listKnowledgeBases()[0]?.rootPath, path.resolve("/knowledge/product"));

  assert.throws(() => store.deleteKnowledgeBase(knowledgeBase.id), /still bound/);
  store.bindProjectKnowledgeBase(project.id);
  assert.equal(store.getInteractionMode("alice@im.wechat"), "session");
  store.deleteKnowledgeBase(knowledgeBase.id);
  assert.equal(store.listKnowledgeBases().length, 0);
});

test("persists deduplicated project completion notification targets", (t) => {
  const store = createStore(t);
  const project = store.createProject("通知项目", "/work/notifications");

  store.setProjectNotifications(project.id, [
    { accountId: "wecom-bot", recipientId: "engineering", enabled: true },
    { accountId: "wecom-bot", recipientId: "engineering", enabled: false },
    { accountId: "feishu-app", recipientId: "oc_chat", enabled: true }
  ]);

  assert.deepEqual(store.listProjects()[0].notifications, [
    { accountId: "wecom-bot", recipientId: "engineering", enabled: false },
    { accountId: "feishu-app", recipientId: "oc_chat", enabled: true }
  ]);
});

test("prevents deleting a project that still owns sessions", (t) => {
  const store = createStore(t);
  const project = store.createProject("内容运营", "/work/content");
  store.createSession("alice@im.wechat", project.workspace, "首篇小红书", project.id);

  assert.throws(() => store.deleteProject(project.id), /still has sessions/);
});

test("migrates existing session workspaces into account-local projects", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-project-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const original = new RuntimeStateStore(paths);
  const session = original.createSession("alice@im.wechat", "/work/legacy", "旧任务");

  const reloaded = new RuntimeStateStore(paths);
  const project = reloaded.listProjects()[0];
  assert.equal(project?.workspace, path.resolve("/work/legacy"));
  assert.equal(reloaded.getSession(session.id)?.projectId, project?.id);
});

test("persists model and reasoning effort overrides per managed session", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-session-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const store = new RuntimeStateStore(paths);
  const first = store.createSession("alice@im.wechat", "/work/one", "First");
  store.setModelOverride("alice@im.wechat", "gpt-session");
  store.setEffortOverride("alice@im.wechat", "high");
  const second = store.createSession("alice@im.wechat", "/work/two", "Second");

  assert.equal(store.getSession(first.id)?.model, "gpt-session");
  assert.equal(store.getSession(first.id)?.effort, "high");
  assert.equal(store.getSession(second.id)?.model, undefined);
  assert.equal(store.getSession(second.id)?.effort, undefined);

  const reloaded = new RuntimeStateStore(paths);
  reloaded.activateSession(first.id);
  assert.equal(reloaded.getActiveSession("alice@im.wechat")?.model, "gpt-session");
  assert.equal(reloaded.getActiveSession("alice@im.wechat")?.effort, "high");
  reloaded.setModelOverride("alice@im.wechat");
  reloaded.setEffortOverride("alice@im.wechat");
  assert.equal(reloaded.getActiveSession("alice@im.wechat")?.model, undefined);
  assert.equal(reloaded.getActiveSession("alice@im.wechat")?.effort, undefined);
});

test("updates model, effort, and streaming by managed session id for Web controls", (t) => {
  const store = createStore(t);
  const first = store.createSession("alice@im.wechat", "/work/one", "First");
  const second = store.createSession("alice@im.wechat", "/work/two", "Second");

  store.updateSessionRuntime(first.id, { model: "gpt-session", effort: "high", streamReplies: true });
  assert.equal(store.getSession(first.id)?.model, "gpt-session");
  assert.equal(store.getSession(first.id)?.effort, "high");
  assert.equal(store.getSession(first.id)?.streamReplies, true);
  assert.equal(store.getSession(second.id)?.model, undefined);

  store.updateSessionRuntime(first.id, { model: null, effort: null, streamReplies: null });
  assert.equal(store.getSession(first.id)?.model, undefined);
  assert.equal(store.getSession(first.id)?.effort, undefined);
  assert.equal(store.getSession(first.id)?.streamReplies, undefined);
});

test("persists, deduplicates, scopes, and filters personal knowledge", (t) => {
  const store = createStore(t);
  const firstProject = store.createProject("内容运营", "/work/content");
  const secondProject = store.createProject("产品研发", "/work/product");
  const session = store.createSession("alice@im.wechat", firstProject.workspace, "首篇内容", firstProject.id);

  store.rememberKnowledge({
    kind: "preference",
    scope: "account",
    title: " 回复风格 ",
    content: " 结论优先，使用中文 "
  }, firstProject.id, session.id);
  store.rememberKnowledge({
    kind: "preference",
    scope: "account",
    title: "回复风格",
    content: "结论优先，必要时补充步骤"
  }, firstProject.id, session.id);
  store.rememberKnowledge({
    kind: "workflow",
    scope: "project",
    title: "发布流程",
    content: "发布前运行测试和构建"
  }, firstProject.id, session.id);
  const rejected = store.rememberKnowledge({
    kind: "knowledge",
    scope: "account",
    title: "部署密钥",
    content: "API_KEY: should-not-be-stored"
  });

  assert.equal(rejected, undefined);
  assert.equal(store.listKnowledge().length, 2);
  assert.equal(store.listKnowledge().find((entry) => entry.title === "回复风格")?.content, "结论优先，必要时补充步骤");
  assert.equal(store.relevantKnowledge("准备发布", firstProject.id).length, 2);
  assert.deepEqual(
    store.relevantKnowledge("准备发布", secondProject.id).map((entry) => entry.title),
    ["回复风格"]
  );
});

test("persistently claims inbound message ids once and bounds the history", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-dedupe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const store = new RuntimeStateStore(paths);

  assert.equal(store.claimProcessedMessage("message-one"), true);
  assert.equal(store.claimProcessedMessage("message-one"), false);
  assert.equal(new RuntimeStateStore(paths).claimProcessedMessage("message-one"), false);

  for (let index = 0; index < 1_005; index += 1) {
    store.claimProcessedMessage(`message-${index + 2}`);
  }
  assert.equal(store.snapshot.processedMessageIds.length, 1_000);
  assert.equal(store.snapshot.processedMessageIds.includes("message-one"), false);
});

test("stores the latest WeChat sync key across monitor restarts", (t) => {
  const store = createStore(t);

  assert.equal(store.getSyncKey(), undefined);
  store.setSyncKey("sync-next");
  assert.equal(store.getSyncKey(), "sync-next");
});
