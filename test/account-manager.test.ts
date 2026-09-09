import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPrompt } from "../src/bridge/format.js";
import { AccountManager } from "../src/server/account-manager.js";
import type { CodexDesktopApproval } from "../src/server/codex-desktop-approval-monitor.js";
import type {
  CodexSessionActivity,
  CodexSessionCompletion,
  CodexSessionTask
} from "../src/server/codex-session-monitor.js";
import { defaultConfig } from "../src/state/config.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { listRetainedAccounts, loadAccount, saveAccount } from "../src/weixin/accounts.js";
import type { NormalizedWeixinMessage } from "../src/weixin/messages.js";

function setup(t: test.TestContext, options: { taskboardClient?: object; taskCards?: boolean; llmWiki?: object } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  for (const accountId of ["account-one", "account-two"]) {
    saveAccount(paths, {
      accountId,
      userId: `user-${accountId}`,
      token: `token-${accountId}`,
      baseUrl: "https://example.test",
      cdnBaseUrl: "https://cdn.example.test",
      savedAt: new Date().toISOString(),
      enabled: true
    });
  }
  const starts: string[] = [];
  const inboundHandlers = new Map<string, (message: NormalizedWeixinMessage) => Promise<void>>();
  const handledMessages: NormalizedWeixinMessage[] = [];
  const sent: Array<{ accountId: string; toUserId: string; text: string }> = [];
  const streamStarts: Array<{ accountId: string; toUserId: string; text: string }> = [];
  const streamUpdates: Array<{
    accountId: string;
    toUserId: string;
    messageId: string;
    text: string;
    finalize?: boolean;
  }> = [];
  const sentCards: Array<{ accountId: string; toUserId: string; card: { identifier: string; latestComment?: string; actions: readonly { label: string }[] } }> = [];
  const runs: Array<Record<string, unknown>> = [];
  let runtimeInfo: { model?: string; effort?: string; provider?: string } = {
    model: "runtime-model",
    effort: "medium"
  };
  let runHandler: ((input: Record<string, unknown>) => Promise<{ raw: string; text: string; threadId?: string; turnId?: string }>) | undefined;
  let externalCompletionHandler: ((completion: CodexSessionCompletion) => Promise<void>) | undefined;
  let externalTaskHandler: ((task: CodexSessionTask) => void) | undefined;
  let externalActivityHandler: ((activity: CodexSessionActivity) => Promise<void>) | undefined;
  let desktopApprovalHandler: ((approval: CodexDesktopApproval) => Promise<"accept" | "decline" | undefined>) | undefined;
  const followedDesktopThreads: string[] = [];
  const channelApprovals: Array<{ senderId: string; request: Record<string, unknown> }> = [];
  const history = [
    { id: "user-1", role: "user" as const, text: buildPrompt("历史问题") },
    { id: "assistant-1", role: "assistant" as const, text: "历史回答" }
  ];
  const runner = {
    async warmUp() {},
    async run(input: Record<string, unknown>) {
      runs.push(input);
      if (runHandler) return runHandler(input);
      return { raw: "", text: "Web reply", threadId: input.threadId ?? "thread-web", turnId: "turn-web" };
    },
    async getHistory() {
      return structuredClone(history);
    },
    async getRuntimeInfo() {
      return runtimeInfo;
    },
    async listModels() {
      return [{
        model: "runtime-model",
        displayName: "Runtime Model",
        description: "Runtime model description",
        isDefault: true,
        defaultEffort: "medium",
        supportedEfforts: [{ effort: "medium", description: "Balanced" }]
      }];
    },
    async stop() {},
    close() {}
  };
  const manager = new AccountManager({
    paths,
    configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: Boolean(options.taskboardClient) }),
    taskboardClientFactory: () => options.taskboardClient as never,
    llmWiki: options.llmWiki as never,
    clientFactory: (account) => ({
      accountId: account.accountId,
      async sendText(input: { toUserId: string; text: string }) {
        sent.push({ accountId: account.accountId, ...input });
        return { messageId: "sent" };
      },
      async startTextStream(input: { toUserId: string; text: string }) {
        streamStarts.push({ accountId: account.accountId, ...input });
        return { messageId: `stream-${streamStarts.length}` };
      },
      async updateTextStream(input: {
        toUserId: string;
        messageId: string;
        text: string;
        finalize?: boolean;
      }) {
        streamUpdates.push({ accountId: account.accountId, ...input });
      },
      ...(options.taskCards ? {
        async sendTaskCard(input: { toUserId: string; card: typeof sentCards[number]["card"] }) {
          sentCards.push({ accountId: account.accountId, ...input });
          return { messageId: "sent-card" };
        }
      } : {})
    }) as never,
    channelFactory: (account) => ({
      client: {
        async sendText(input: { toUserId: string; text: string }) {
          sent.push({ accountId: account.accountId, ...input });
          return { messageId: "sent" };
        }
      },
      async monitor({ signal, onMessage }) {
        starts.push(account.accountId);
        inboundHandlers.set(account.accountId, onMessage);
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      }
    }),
    bridgeFactory: (input) => ({
      async handleMessage(message: NormalizedWeixinMessage) {
        handledMessages.push(message);
      },
      async requestApproval(senderId: string, request: Record<string, unknown>) {
        channelApprovals.push({ senderId, request });
        return "accept" as const;
      },
      allowSender(senderId: string) {
        input.stateStore.setPairedSenderIds([...input.stateStore.listPairedSenderIds(), senderId]);
      },
      removeSender(senderId: string) {
        input.stateStore.setPairedSenderIds(input.stateStore.listPairedSenderIds().filter((id) => id !== senderId));
      }
    }) as never,
    monitor: async ({ client, signal, onMessage }) => {
      const accountId = (client as never as { accountId: string }).accountId;
      starts.push(accountId);
      inboundHandlers.set(accountId, onMessage);
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
    runnerFactory: () => runner as never,
    codexSessionMonitorFactory: (handlers) => {
      externalCompletionHandler = handlers.onCompletion;
      externalTaskHandler = handlers.onTaskChanged;
      externalActivityHandler = handlers.onActivity;
      return { start() {}, stop() {} } as never;
    },
    codexDesktopApprovalMonitorFactory: (handlers) => {
      desktopApprovalHandler = handlers.onApproval;
      return {
        start() {},
        stop() {},
        followThread(threadId: string) { followedDesktopThreads.push(threadId); }
      } as never;
    }
  });
  return {
    manager,
    paths,
    starts,
    handledMessages,
    root,
    runs,
    history,
    sent,
    streamStarts,
    streamUpdates,
    sentCards,
    async emitInbound(accountId: string, message: NormalizedWeixinMessage) {
      const handler = inboundHandlers.get(accountId);
      assert.ok(handler, `Inbound handler is not running for ${accountId}`);
      await handler(message);
    },
    async emitCodexCompletion(completion: CodexSessionCompletion) {
      assert.ok(externalCompletionHandler, "Codex session monitor should be active");
      await externalCompletionHandler(completion);
    },
    emitCodexTask(task: CodexSessionTask) {
      assert.ok(externalTaskHandler, "Codex task status monitor should be active");
      externalTaskHandler(task);
    },
    async emitCodexActivity(activity: CodexSessionActivity) {
      assert.ok(externalActivityHandler, "Codex activity monitor should be active");
      await externalActivityHandler(activity);
    },
    async emitDesktopApproval(approval: CodexDesktopApproval) {
      assert.ok(desktopApprovalHandler, "Codex Desktop approval monitor should be active");
      return desktopApprovalHandler(approval);
    },
    followedDesktopThreads,
    channelApprovals,
    setRunHandler(handler: typeof runHandler) {
      runHandler = handler;
    },
    setRuntimeInfo(value: typeof runtimeInfo) {
      runtimeInfo = value;
    }
  };
}

test("notifies Taskboard review state once as an actionable card with the latest evidence", async (t) => {
  let emit: ((event: object) => Promise<void> | void) | undefined;
  const taskboardProject = { id: "tb-project", name: "Taskboard Project", workspacePath: "", issueCount: 1 };
  const taskboardClient = {
    baseUrl: "http://127.0.0.1:47823",
    async subscribe(signal: AbortSignal, onEvent: typeof emit) {
      emit = onEvent;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    async listProjects() { return [taskboardProject]; },
    async listComments() { return [{ body: "测试与构建均通过" }]; },
    async projectForWorkspace() { return taskboardProject; },
    async issueForThread() { return undefined; }
  };
  const { manager, root, sent, sentCards } = setup(t, { taskboardClient, taskCards: true });
  taskboardProject.workspacePath = path.join(root, "review-project");
  const project = manager.createProject("account-one", "Review Project", taskboardProject.workspacePath);
  manager.setProjectNotifications("account-one", project.id, [{ accountId: "account-two", recipientId: "review-room", enabled: true }]);
  await manager.startAll();
  assert.ok(emit);
  const issue = {
    id: "task-one", identifier: "REVIEW-1", projectId: "tb-project", title: "Verify bridge",
    description: "", status: "in_review", priority: "high", labels: [], threadId: "thread-one",
    version: 4, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
  };
  await emit?.({ type: "task.moved", task: issue });
  await emit?.({ type: "task.moved", task: issue });

  assert.equal(sent.length, 0);
  assert.equal(sentCards.length, 1);
  assert.equal(sentCards[0]?.card.identifier, "REVIEW-1");
  assert.equal(sentCards[0]?.card.latestComment, "测试与构建均通过");
  assert.deepEqual(sentCards[0]?.card.actions.map((action) => action.label), [
    "添加进展", "通过", "退回", "返回任务", "打开完整面板"
  ]);
  await manager.stopAll();
});

test("exposes and manages only workspace-mapped Taskboard issues", async (t) => {
  const comments: Array<{ body: string; threadId: string }> = [];
  const moves: Array<{ taskId: string; status: string; version: number; threadId: string }> = [];
  const taskboardProject = { id: "tb-project", name: "Bridge Delivery", workspacePath: "", issueCount: 1 };
  const issue = {
    id: "task-one", identifier: "BRIDGE-1", projectId: "tb-project", title: "Build workbench",
    description: "Expose mapped issues", status: "in_progress", priority: "high", labels: ["codex"],
    threadId: "thread-one", version: 7, createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T01:00:00.000Z"
  };
  const taskboardClient = {
    baseUrl: "http://127.0.0.1:47823",
    async listProjects() { return [taskboardProject]; },
    async listIssues() { return [issue]; },
    async getIssue() { return issue; },
    async listComments() { return [{ id: "comment-one", taskId: issue.id, body: "Current evidence", threadId: issue.threadId, createdAt: issue.createdAt, updatedAt: issue.updatedAt }]; },
    async addComment(_taskId: string, body: string, threadId: string) {
      comments.push({ body, threadId });
      return { id: "comment-two", taskId: issue.id, body, threadId, createdAt: issue.updatedAt, updatedAt: issue.updatedAt };
    },
    async moveIssue(taskId: string, status: string, version: number, threadId: string) {
      moves.push({ taskId, status, version, threadId });
      return { ...issue, status, version: version + 1 };
    }
  };
  const { manager, root } = setup(t, { taskboardClient });
  taskboardProject.workspacePath = path.join(root, "bridge-project");
  manager.createProject("account-one", "Bridge", taskboardProject.workspacePath);

  const summaries = await manager.listTaskboardIssues();
  const detail = await manager.getTaskboardIssue("BRIDGE-1");
  await manager.commentTaskboardIssue("BRIDGE-1", "Admin evidence");
  const moved = await manager.moveTaskboardIssue("BRIDGE-1", "in_review", 7, "Ready for acceptance");

  assert.equal(summaries[0]?.identifier, "BRIDGE-1");
  assert.equal(summaries[0]?.taskboardProjectName, "Bridge Delivery");
  assert.equal(summaries[0]?.managedProjects[0]?.projectName, "Bridge");
  assert.equal(detail.comments[0]?.body, "Current evidence");
  assert.deepEqual(comments, [
    { body: "Admin evidence", threadId: "thread-one" },
    { body: "Ready for acceptance", threadId: "thread-one" }
  ]);
  assert.deepEqual(moves, [{ taskId: "task-one", status: "in_review", version: 7, threadId: "thread-one" }]);
  assert.equal(moved.status, "in_review");
});

test("rejects Taskboard admin mutations without a Codex thread or valid transition", async (t) => {
  let threaded = false;
  const taskboardProject = { id: "tb-project", name: "Bridge Delivery", workspacePath: "", issueCount: 1 };
  const issue = {
    id: "task-one", identifier: "BRIDGE-1", projectId: "tb-project", title: "Build workbench",
    description: "", status: "todo", priority: "high", labels: [], threadId: null, version: 1,
    createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
  };
  const { manager, root } = setup(t, { taskboardClient: {
    baseUrl: "http://127.0.0.1:47823",
    async listProjects() { return [taskboardProject]; },
    async getIssue() { return { ...issue, threadId: threaded ? "thread-one" : null }; }
  } });
  taskboardProject.workspacePath = path.join(root, "bridge-project");
  manager.createProject("account-one", "Bridge", taskboardProject.workspacePath);

  await assert.rejects(() => manager.commentTaskboardIssue("BRIDGE-1", "Evidence"), /Codex thread/i);
  threaded = true;
  await assert.rejects(() => manager.moveTaskboardIssue("BRIDGE-1", "done", 1), /transition/i);
});

test("isolates personal knowledge by WeChat account", (t) => {
  const { paths } = setup(t);
  const first = new RuntimeStateStore(accountStatePaths(paths, "account-one"));
  const second = new RuntimeStateStore(accountStatePaths(paths, "account-two"));

  first.rememberKnowledge({
    kind: "skill",
    scope: "account",
    title: "内容复盘",
    content: "每周复盘标题点击率"
  });

  assert.equal(first.listKnowledge().length, 1);
  assert.equal(second.listKnowledge().length, 0);
});

test("starts and stops multiple accounts independently", async (t) => {
  const { manager, starts } = setup(t);
  await manager.startAll();

  assert.deepEqual(starts.sort(), ["account-one", "account-two"]);
  assert.deepEqual(manager.listAccounts().map((account) => account.status), ["running", "running"]);

  await manager.stopAccount("account-one");
  assert.equal(manager.listAccounts().find((account) => account.accountId === "account-one")?.status, "stopped");
  assert.equal(manager.listAccounts().find((account) => account.accountId === "account-two")?.status, "running");
  await manager.stopAccount("account-two");
});

test("adds redacted enterprise channels and stops them cleanly", async (t) => {
  const { manager } = setup(t);

  const wecom = await manager.addChannelAccount({
    channel: "wecom",
    botId: "bot-123",
    secret: "wecom-secret",
    displayName: "企业通知"
  });
  const feishu = await manager.addChannelAccount({
    channel: "feishu",
    appId: "cli_app_123",
    appSecret: "feishu-secret"
  });
  const dingtalk = await manager.addChannelAccount({
    channel: "dingtalk",
    clientId: "ding_app_123",
    clientSecret: "dingtalk-secret",
    cardTemplateId: "card-template.schema",
    networkFamily: "ipv6"
  });

  assert.equal(wecom.channel, "wecom");
  assert.equal("secret" in wecom, false);
  assert.equal(feishu.channel, "feishu");
  assert.equal("appSecret" in feishu, false);
  assert.equal(dingtalk.channel, "dingtalk");
  assert.equal("clientSecret" in dingtalk, false);
  assert.equal(dingtalk.cardTemplateId, "card-template.schema");
  assert.equal(dingtalk.networkFamily, "ipv6");
  await manager.stopAccount(wecom.accountId, false);
  await manager.stopAccount(feishu.accountId, false);
  await manager.stopAccount(dingtalk.accountId, false);
});

test("routes a native Feishu menu click through the actor's authorized conversation", async (t) => {
  const { manager, handledMessages, emitInbound } = setup(t);
  const account = await manager.addChannelAccount({
    channel: "feishu",
    appId: "cli_menu_test",
    appSecret: "feishu-secret"
  });
  manager.allowSender(account.accountId, "oc_release_room");

  await emitInbound(account.accountId, {
    id: "feishu-chat-1",
    senderId: "ou_release_owner",
    replyTargetId: "oc_release_room",
    text: "查看进度",
    attachments: [],
    raw: { channel: "feishu", event: {} }
  });
  await emitInbound(account.accountId, {
    id: "feishu-menu-1",
    senderId: "ou_release_owner",
    replyTargetId: "ou_release_owner",
    source: "native-menu",
    text: "/task",
    attachments: [],
    raw: { channel: "feishu", event: {} }
  });

  assert.equal(handledMessages.at(-1)?.replyTargetId, "oc_release_room");
  await manager.stopAccount(account.accountId, false);
});

test("notifies the configured channel and mirrors the outbound message to its webhook", { timeout: 2_000 }, async (t) => {
  const received = Promise.withResolvers<unknown>();
  const webhookServer = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => webhookServer.close((error) => error ? reject(error) : resolve())));
  const address = webhookServer.address();
  assert.ok(address && typeof address !== "string");
  const { manager, root, sent } = setup(t);
  manager.updateAccount("account-two", {
    displayName: "",
    webhookUrl: `http://127.0.0.1:${address.port}/events`
  });
  await manager.startAll();
  const project = manager.createProject("account-one", "发布项目", path.join(root, "release"));
  const session = manager.createSession("account-one", "alice@im.wechat", undefined, "发布检查", project.id);
  manager.setProjectNotifications("account-one", project.id, [{
    accountId: "account-two",
    recipientId: "release-room",
    enabled: true
  }]);

  await manager.continueSession("account-one", session.id, "执行发布检查");

  assert.deepEqual(sent, [{
    accountId: "account-two",
    toUserId: "release-room",
    text: "【Codex 任务已完成】\n项目：发布项目\n任务：发布检查\n结果：Web reply"
  }]);
  const payload = await received.promise as { occurredAt: string } & Record<string, unknown>;
  assert.match(payload.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual({ ...payload, occurredAt: undefined }, {
    schemaVersion: 1,
    event: "channel.message",
    occurredAt: undefined,
    account: { id: "account-two", channel: "weixin" },
    message: {
      direction: "outbound",
      id: "sent",
      recipientId: "release-room",
      text: sent[0].text,
      attachments: []
    }
  });
  await manager.stopAll();
});

test("notifies the configured channel when an existing Codex client task ends", async (t) => {
  const { manager, paths, root, sent, emitCodexCompletion } = setup(t);
  await manager.startAll();
  const workspace = path.join(root, "existing-codex-project");
  const project = manager.createProject("account-one", "已有 Codex 项目", workspace);
  manager.setProjectNotifications("account-one", project.id, [{
    accountId: "account-two",
    recipientId: "existing-room",
    enabled: true
  }]);

  await emitCodexCompletion({
    sessionId: "desktop-thread",
    turnId: "desktop-turn",
    workspace,
    taskTitle: "修复已有会话通知",
    text: "通知链路已恢复",
    success: true,
    completedAt: "2026-08-01T08:00:00.000Z"
  });

  assert.deepEqual(sent, [{
    accountId: "account-two",
    toUserId: "existing-room",
    text: "【Codex 任务已完成】\n项目：已有 Codex 项目\n任务：修复已有会话通知\n结果：通知链路已恢复"
  }]);

  const boundDesktopSession = manager.createSession(
    "account-one",
    "alice@im.wechat",
    undefined,
    "已绑定桌面任务",
    project.id
  );
  new RuntimeStateStore(accountStatePaths(paths, "account-one"))
    .setSessionThread(boundDesktopSession.id, "bound-desktop-thread");
  await emitCodexCompletion({
    sessionId: "bound-desktop-thread",
    turnId: "bound-desktop-turn",
    workspace,
    taskTitle: "已绑定但由桌面执行",
    text: "桌面任务完成",
    success: true,
    completedAt: "2026-08-01T08:00:30.000Z"
  });
  assert.equal(sent.length, 2, "bound desktop sessions should still send filesystem notifications");

  const managedSession = manager.createSession(
    "account-one",
    "alice@im.wechat",
    undefined,
    "服务内任务",
    project.id
  );
  await manager.continueSession("account-one", managedSession.id, "执行服务内任务");
  await emitCodexCompletion({
    sessionId: "thread-web",
    turnId: "turn-web",
    workspace,
    taskTitle: "服务内任务",
    text: "Web reply",
    success: true,
    completedAt: "2026-08-01T08:01:00.000Z"
  });
  assert.equal(sent.length, 3, "managed sessions should not send a duplicate filesystem notification");
  await manager.stopAll();
});

test("streams externally owned Codex progress into a bound channel session and finalizes it", async (t) => {
  const {
    manager,
    root,
    streamStarts,
    streamUpdates,
    emitCodexActivity,
    emitCodexCompletion,
    setRunHandler
  } = setup(t);
  await manager.startAll();
  const workspace = path.join(root, "desktop-live-project");
  const project = manager.createProject("account-one", "桌面实时项目", workspace);
  const session = manager.createSession(
    "account-one",
    "alice@im.wechat",
    undefined,
    "桌面实时会话",
    project.id
  );
  setRunHandler(async () => ({
    raw: "",
    text: "已绑定",
    threadId: "desktop-live-thread",
    turnId: "binding-turn"
  }));
  await manager.continueSession("account-one", session.id, "绑定桌面会话");

  await emitCodexActivity({
    sessionId: "desktop-live-thread",
    turnId: "desktop-live-turn",
    text: "正在核对测试结果",
    updatedAt: "2026-08-01T08:00:01.000Z"
  });
  assert.equal(streamStarts.length, 1);
  assert.equal(streamStarts[0]?.toUserId, "alice@im.wechat");
  assert.match(streamStarts[0]?.text ?? "", /最近进展[\s\S]*正在核对测试结果/);

  await emitCodexCompletion({
    sessionId: "desktop-live-thread",
    turnId: "desktop-live-turn",
    workspace,
    taskTitle: "桌面实时任务",
    text: "介入链路完成",
    success: true,
    completedAt: "2026-08-01T08:00:02.000Z"
  });
  assert.deepEqual(streamUpdates.at(-1), {
    accountId: "account-one",
    toUserId: "alice@im.wechat",
    messageId: "stream-1",
    text: "介入链路完成",
    finalize: true
  });
  await manager.stopAll();
});

test("forwards an existing Codex Desktop approval to the project's configured channel", async (t) => {
  const {
    manager,
    paths,
    root,
    emitCodexTask,
    emitDesktopApproval,
    followedDesktopThreads,
    channelApprovals
  } = setup(t);
  await manager.startAll();
  const workspace = path.join(root, "desktop-approval-project");
  const project = manager.createProject("account-one", "桌面审批项目", workspace);
  const session = manager.createSession("account-one", "alice@im.wechat", undefined, "桌面会话", project.id);
  new RuntimeStateStore(accountStatePaths(paths, "account-one"))
    .setSessionThread(session.id, "desktop-approval-thread");
  manager.setProjectNotifications("account-one", project.id, [{
    accountId: "account-two",
    recipientId: "approval-room",
    enabled: true
  }]);

  emitCodexTask({
    sessionId: "desktop-approval-thread",
    turnId: "desktop-turn",
    workspace,
    title: "等待修改文件审批",
    status: "running",
    startedAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:01.000Z"
  });
  assert.deepEqual(followedDesktopThreads, ["desktop-approval-thread"]);

  const decision = await emitDesktopApproval({
    requestId: 127,
    method: "item/fileChange/requestApproval",
    request: {
      kind: "file",
      threadId: "desktop-approval-thread",
      turnId: "desktop-turn",
      itemId: "desktop-item",
      cwd: workspace
    }
  });

  assert.equal(decision, "accept");
  assert.deepEqual(channelApprovals, [{
    senderId: "approval-room",
    request: {
      kind: "file",
      threadId: "desktop-approval-thread",
      turnId: "desktop-turn",
      itemId: "desktop-item",
      cwd: workspace
    }
  }]);
  await manager.stopAll();
});

test("refreshes a running account so new credentials take effect", async (t) => {
  const { manager, starts } = setup(t);
  await manager.startAccount("account-one", false);

  await manager.refreshAccount("account-one");

  assert.equal(starts.filter((accountId) => accountId === "account-one").length, 2);
  assert.equal(manager.listAccounts().find((account) => account.accountId === "account-one")?.status, "running");
  await manager.stopAccount("account-one", false);
});

test("isolates senders and managed sessions by account", async (t) => {
  const { manager, root } = setup(t);
  await manager.startAll();
  manager.allowSender("account-one", "alice@im.wechat");
  manager.allowSender("account-two", "bob@im.wechat");
  manager.createSession("account-one", "alice@im.wechat", root, "Alice session");
  manager.createSession("account-two", "bob@im.wechat", root, "Bob session");

  const accounts = manager.listAccounts();
  assert.deepEqual(accounts.find((account) => account.accountId === "account-one")?.pairedSenderIds, ["alice@im.wechat"]);
  assert.deepEqual(accounts.find((account) => account.accountId === "account-two")?.pairedSenderIds, ["bob@im.wechat"]);
  assert.deepEqual(manager.listSessions().map((session) => session.accountId).sort(), ["account-one", "account-two"]);
  await manager.stopAccount("account-one");
  await manager.stopAccount("account-two");
});

test("isolates managed projects by WeChat account", (t) => {
  const { manager, root } = setup(t);
  const one = manager.createProject("account-one", "账号一项目", path.join(root, "one"));
  const two = manager.createProject("account-two", "账号二项目", path.join(root, "two"));

  assert.deepEqual(manager.listProjects("account-one").map((project) => project.id), [one.id]);
  assert.deepEqual(manager.listProjects("account-two").map((project) => project.id), [two.id]);
  assert.equal(manager.listProjects("account-one").some((project) => project.id === two.id), false);
  assert.throws(
    () => manager.createSession("account-one", "alice@im.wechat", undefined, undefined, two.id),
    /Managed project not found/
  );
});

test("tracks currently running Codex client tasks for a managed project", (t) => {
  const { manager, paths, root, emitCodexTask } = setup(t);
  const workspace = path.join(root, "running-project");
  const project = manager.createProject("account-one", "运行项目", workspace);
  const otherAccountProject = manager.createProject("account-two", "另一个账号的同目录项目", workspace);
  const boundSession = manager.createSession(
    "account-one",
    "alice@im.wechat",
    undefined,
    "已绑定桌面会话",
    project.id
  );
  new RuntimeStateStore(accountStatePaths(paths, "account-one"))
    .setSessionThread(boundSession.id, "desktop-thread");
  const runningTask: CodexSessionTask = {
    sessionId: "desktop-thread",
    turnId: "desktop-turn",
    workspace,
    title: "监听运行状态",
    status: "running",
    startedAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:01.000Z"
  };

  emitCodexTask(runningTask);
  const running = manager.listProjects("account-one").find((item) => item.id === project.id);
  assert.equal(running?.activeTaskCount, 1);
  assert.deepEqual(running?.runningTasks, [{
    id: "codex:desktop-thread:desktop-turn",
    title: "监听运行状态",
    source: "codex",
    startedAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:01.000Z"
  }]);
  assert.equal(
    manager.listProjects("account-two").find((item) => item.id === otherAccountProject.id)?.activeTaskCount,
    0
  );

  emitCodexTask({ ...runningTask, status: "completed", updatedAt: "2026-08-01T08:01:00.000Z" });
  assert.equal(manager.listProjects("account-one").find((item) => item.id === project.id)?.activeTaskCount, 0);
});

test("includes the project's bound sessions and active marker in project summaries", (t) => {
  const { manager, root } = setup(t);
  const workspace = path.join(root, "bound-project");
  const project = manager.createProject("account-one", "绑定项目", workspace);
  const session = manager.createSession("account-one", "alice@im.wechat", undefined, "需求讨论", project.id);

  const summary = manager.listProjects("account-one").find((item) => item.id === project.id);
  assert.equal(summary?.sessionCount, 1);
  assert.deepEqual(summary?.boundSessions, [{
    id: session.id,
    title: "需求讨论",
    active: true,
    hasThread: false,
    updatedAt: session.updatedAt
  }]);
});

test("rejects projects outside the configured workspace allowlist", (t) => {
  const { manager } = setup(t);

  assert.throws(
    () => manager.createProject("account-one", "越界项目", "/definitely/outside"),
    /Workspace is not allowed/
  );
});

test("persists channel settings without exposing the webhook URL", (t) => {
  const { manager, paths } = setup(t);

  const configured = manager.updateAccount("account-one", {
    displayName: "  工作微信  ",
    webhookUrl: "https://hooks.example.test/channel?token=secret",
    webhookProvider: "feishu"
  });
  assert.equal(configured.displayName, "工作微信");
  assert.equal(configured.webhookConfigured, true);
  assert.equal(configured.webhookProvider, "feishu");
  assert.equal("webhookUrl" in configured, false);
  assert.equal(loadAccount(paths, "account-one").displayName, "工作微信");
  assert.equal(loadAccount(paths, "account-one").webhookUrl, "https://hooks.example.test/channel?token=secret");
  assert.equal(loadAccount(paths, "account-one").webhookProvider, "feishu");

  const renamed = manager.updateAccount("account-one", { displayName: "工作渠道" });
  assert.equal(renamed.displayName, "工作渠道");
  assert.equal(loadAccount(paths, "account-one").webhookUrl, "https://hooks.example.test/channel?token=secret");

  assert.throws(
    () => manager.updateAccount("account-one", { displayName: "a".repeat(41) }),
    /40 characters or fewer/
  );

  const cleared = manager.updateAccount("account-one", { displayName: "   ", webhookUrl: null });
  assert.equal(cleared.displayName, undefined);
  assert.equal(cleared.webhookConfigured, false);
  assert.equal(cleared.webhookProvider, "feishu");
  assert.equal(loadAccount(paths, "account-one").displayName, undefined);
  assert.equal(loadAccount(paths, "account-one").webhookUrl, undefined);
});

test("configures channel modes from a validated llm-wiki directory", async (t) => {
  // Given
  const inspectedRoots: string[] = [];
  const { manager, paths, root } = setup(t, {
    llmWiki: {
      async inspect(knowledgeBase: { rootPath: string }) {
        inspectedRoots.push(knowledgeBase.rootPath);
        return { command: "llm-wiki", status: { documentCount: 2, blockCount: 8, rawArtifactCount: 1 } };
      },
      invalidate() {}
    }
  });
  const rootPath = path.join(root, "product-wiki");

  // When
  const configured = await manager.updateAccountModeSettings("account-one", {
    defaultMode: "qa",
    enabledModes: ["session", "task", "qa"],
    qaKnowledgeBase: { kind: "directory", rootPath, name: "产品 Wiki" }
  });

  // Then
  const knowledgeBase = manager.listKnowledgeBases("account-one")[0];
  assert.equal(knowledgeBase?.name, "产品 Wiki");
  assert.deepEqual(inspectedRoots, [path.resolve(rootPath)]);
  assert.deepEqual(configured.modeSettings, {
    defaultMode: "qa",
    enabledModes: ["session", "task", "qa"],
    qaKnowledgeBaseId: knowledgeBase?.id
  });
  assert.deepEqual(loadAccount(paths, "account-one").modeSettings, configured.modeSettings);
});

test("configures channel Q&A from a validated managed Codex project", async (t) => {
  // Given
  const inspectedRoots: string[] = [];
  const { manager, root } = setup(t, {
    llmWiki: {
      async inspect(knowledgeBase: { rootPath: string }) {
        inspectedRoots.push(knowledgeBase.rootPath);
        return { command: "llm-wiki", status: { documentCount: 2, blockCount: 8, rawArtifactCount: 1 } };
      },
      invalidate() {}
    }
  });
  const workspace = path.join(root, "product-wiki");
  const project = manager.createProject("account-one", "产品知识项目", workspace);

  // When
  const configured = await manager.updateAccountModeSettings("account-one", {
    defaultMode: "qa",
    enabledModes: ["session", "qa"],
    qaKnowledgeBase: { kind: "project", projectId: project.id }
  });

  // Then
  const knowledgeBase = manager.listKnowledgeBases("account-one")[0];
  assert.equal(knowledgeBase?.name, "产品知识项目");
  assert.equal(knowledgeBase?.rootPath, path.resolve(workspace));
  assert.deepEqual(inspectedRoots, [path.resolve(workspace)]);
  assert.equal(configured.modeSettings.qaKnowledgeBaseId, knowledgeBase?.id);
});

test("revalidates an existing knowledge base and applies a corrected project CLI root atomically", async (t) => {
  // Given
  const inspected: Array<{ id: string; engineRoot?: string }> = [];
  const { manager, paths, root } = setup(t, {
    llmWiki: {
      async inspect(knowledgeBase: { id: string; engineRoot?: string }) {
        inspected.push({ id: knowledgeBase.id, engineRoot: knowledgeBase.engineRoot });
        return { command: "llm-wiki", status: { documentCount: 2, blockCount: 8, rawArtifactCount: 1 } };
      },
      invalidate() {}
    }
  });
  const store = new RuntimeStateStore(accountStatePaths(paths, "account-one"));
  const rootPath = path.join(root, "product-wiki");
  const oldEngineRoot = path.join(root, "old-engine");
  const correctedEngineRoot = path.join(rootPath, "tools", "knowledge-base");
  const knowledgeBase = store.createKnowledgeBase("产品 Wiki", rootPath, { engineRoot: oldEngineRoot });

  // When
  const configured = await manager.updateAccountModeSettings("account-one", {
    defaultMode: "qa",
    enabledModes: ["session", "qa"],
    qaKnowledgeBase: {
      kind: "directory",
      rootPath,
      engineRoot: correctedEngineRoot
    }
  });

  // Then
  assert.deepEqual(inspected, [{ id: knowledgeBase.id, engineRoot: correctedEngineRoot }]);
  assert.equal(manager.listKnowledgeBases("account-one")[0]?.engineRoot, correctedEngineRoot);
  assert.equal(configured.modeSettings.qaKnowledgeBaseId, knowledgeBase.id);
});

test("revalidates a managed knowledge base before selecting it as the channel default", async (t) => {
  // Given
  const inspectedIds: string[] = [];
  const { manager, paths, root } = setup(t, {
    llmWiki: {
      async inspect(knowledgeBase: { id: string }) {
        inspectedIds.push(knowledgeBase.id);
        return { command: "llm-wiki", status: { documentCount: 2, blockCount: 8, rawArtifactCount: 1 } };
      },
      invalidate() {}
    }
  });
  const knowledgeBase = new RuntimeStateStore(accountStatePaths(paths, "account-one"))
    .createKnowledgeBase("产品 Wiki", path.join(root, "product-wiki"));

  // When
  await manager.updateAccountModeSettings("account-one", {
    defaultMode: "qa",
    enabledModes: ["session", "qa"],
    qaKnowledgeBase: { kind: "managed", knowledgeBaseId: knowledgeBase.id }
  });

  // Then
  assert.deepEqual(inspectedIds, [knowledgeBase.id]);
});

test("does not validate or register a hidden Q&A directory when Q&A is disabled", async (t) => {
  // Given
  let inspectionCount = 0;
  const { manager, root } = setup(t, {
    llmWiki: {
      async inspect() {
        inspectionCount += 1;
        throw new Error("Hidden Q&A directory must not be inspected");
      },
      invalidate() {}
    }
  });

  // When
  const configured = await manager.updateAccountModeSettings("account-one", {
    defaultMode: "session",
    enabledModes: ["session", "task"],
    qaKnowledgeBase: { kind: "directory", rootPath: path.join(root, "hidden-wiki") }
  });

  // Then
  assert.equal(inspectionCount, 0);
  assert.equal(manager.listKnowledgeBases("account-one").length, 0);
  assert.deepEqual(configured.modeSettings, {
    defaultMode: "session",
    enabledModes: ["session", "task"]
  });
});

test("mirrors each inbound channel message to its configured webhook", { timeout: 2_000 }, async (t) => {
  const received = Promise.withResolvers<{ headers: http.IncomingHttpHeaders; body: unknown }>();
  const webhookServer = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.resolve({
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
    });
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => webhookServer.close((error) => error ? reject(error) : resolve())));
  const address = webhookServer.address();
  assert.ok(address && typeof address !== "string");
  const { manager, emitInbound } = setup(t);
  manager.updateAccount("account-one", {
    displayName: "",
    webhookUrl: `http://127.0.0.1:${address.port}/events`
  });
  await manager.startAccount("account-one");

  await emitInbound("account-one", {
    id: "message-1",
    senderId: "alice",
    text: "检查发布状态",
    attachments: [{ kind: "image", label: "proof.png", item: { aes_key: "must-not-leak" } }],
    raw: { message_id: "message-1", from_user_id: "alice", context_token: "must-not-leak" }
  });

  const delivery = await received.promise;
  assert.equal(delivery.headers["content-type"], "application/json");
  const payload = delivery.body as { occurredAt: string } & Record<string, unknown>;
  assert.match(payload.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual({ ...payload, occurredAt: undefined }, {
    schemaVersion: 1,
    event: "channel.message",
    occurredAt: undefined,
    account: { id: "account-one", channel: "weixin" },
    message: {
      direction: "inbound",
      id: "message-1",
      senderId: "alice",
      text: "检查发布状态",
      attachments: [{ kind: "image", label: "proof.png" }]
    }
  });
  await manager.stopAll();
});

test("optionally retains account sessions when removing a WeChat account", async (t) => {
  const { manager, paths, root } = setup(t);
  manager.updateAccount("account-one", { displayName: "张三" });
  manager.allowSender("account-one", "alice@im.wechat");
  manager.createSession("account-one", "alice@im.wechat", root, "历史会话");
  const retainedStatePath = accountStatePaths(paths, "account-one").statePath;

  await manager.removeAccount("account-one", { retainHistory: true });

  assert.deepEqual(manager.listAccounts().map((account) => account.accountId), ["account-two"]);
  assert.equal(fs.existsSync(retainedStatePath), true);
  assert.deepEqual(listRetainedAccounts(paths).map((account) => ({
    accountId: account.accountId,
    userId: account.userId,
    displayName: account.displayName
  })), [{ accountId: "account-one", userId: "user-account-one", displayName: "张三" }]);

  const removedState = new RuntimeStateStore(accountStatePaths(paths, "account-two"));
  removedState.createSession("bob@im.wechat", root, "删除的会话");
  await manager.removeAccount("account-two", { retainHistory: false });
  assert.equal(fs.existsSync(path.dirname(accountStatePaths(paths, "account-two").statePath)), false);
});

test("reports the effective Codex model and reasoning effort", async (t) => {
  const { manager } = setup(t);

  assert.deepEqual(await manager.getCodexRuntimeInfo(), {
    model: "runtime-model",
    effort: "medium"
  });
});

test("reports the models and reasoning efforts advertised by Codex", async (t) => {
  const { manager } = setup(t);

  assert.deepEqual(await manager.getCodexModels(), [{
    model: "runtime-model",
    displayName: "Runtime Model",
    description: "Runtime model description",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [{ effort: "medium", description: "Balanced" }]
  }]);
});

test("keeps the GPT-5.6 provider family available after selecting another model", async (t) => {
  const { manager, setRuntimeInfo } = setup(t);
  setRuntimeInfo({ model: "gpt-5.5", effort: "xhigh", provider: "IkunCoding" });

  const models = await manager.getCodexModels();
  assert.deepEqual(models.slice(0, 3).map((model) => model.model), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna"
  ]);
  assert.deepEqual(
    models.find((model) => model.model === "gpt-5.6-sol")?.supportedEfforts.map((option) => option.effort),
    ["low", "medium", "high", "xhigh", "max", "ultra"]
  );
  assert.deepEqual(
    models.find((model) => model.model === "gpt-5.6-luna")?.supportedEfforts.map((option) => option.effort),
    ["low", "medium", "high", "xhigh", "max"]
  );
});

test("reads managed thread history and continues the same session from Web", async (t) => {
  const { manager, root, runs } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Web chat");

  assert.deepEqual(await manager.getSessionMessages("account-one", session.id), []);
  const result = await manager.continueSession("account-one", session.id, "继续这个会话");

  assert.equal(result.threadId, "thread-web");
  assert.equal(result.message.text, "Web reply");
  assert.equal(runs[0].threadId, undefined);
  assert.equal(runs[0].queueKey, session.id);
  assert.match(String(runs[0].prompt), /继续这个会话/);
  assert.equal(manager.listSessions()[0].threadId, "thread-web");
  assert.equal(manager.listSessions()[0].lastPromptPreview, "继续这个会话");
  assert.deepEqual(await manager.getSessionMessages("account-one", session.id), [
    { id: "user-1", role: "user", text: "历史问题", attachments: [] },
    { id: "assistant-1", role: "assistant", text: "历史回答", attachments: [] }
  ]);
});

test("Web turns learn and reuse the owning WeChat account knowledge", async (t) => {
  const { manager, paths, root, runs, setRunHandler } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Knowledge chat");
  setRunHandler(async () => ({
    raw: "",
    threadId: "thread-knowledge",
    text: [
      "已记录。",
      "```codex-weixin-actions",
      JSON.stringify({
        remember: [{
          kind: "workflow",
          scope: "account",
          title: "交付检查",
          content: "交付前运行测试、类型检查和构建"
        }]
      }),
      "```"
    ].join("\n")
  }));

  const first = await manager.continueSession("account-one", session.id, "记住交付检查流程");
  assert.equal(first.message.text, "已记录。");
  assert.equal(new RuntimeStateStore(accountStatePaths(paths, "account-one")).listKnowledge().length, 1);

  setRunHandler(async (input) => ({ raw: "", text: "开始检查。", threadId: String(input.threadId) }));
  await manager.continueSession("account-one", session.id, "准备交付");
  assert.match(String(runs[1].developerInstructions), /交付前运行测试、类型检查和构建/);
});

test("uses WeChat session model overrides when continuing the same session from Web", async (t) => {
  const { manager, paths, root, runs } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Shared chat");
  const store = new RuntimeStateStore(accountStatePaths(paths, "account-one"));
  store.setModelOverride("alice@im.wechat", "gpt-session");
  store.setEffortOverride("alice@im.wechat", "high");

  await manager.continueSession("account-one", session.id, "从 Web 继续");

  assert.equal(runs[0].model, "gpt-session");
  assert.equal(runs[0].effort, "high");
});

test("streams Web progress without exposing final-answer deltas", async (t) => {
  const { manager, root, setRunHandler } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Streaming chat");
  manager.updateSessionRuntime("account-one", session.id, { streamReplies: true });
  const progress: string[] = [];
  setRunHandler(async (input) => {
    assert.equal(input.onDelta, undefined);
    await (input.onProgress as ((message: string) => Promise<void>) | undefined)?.("正在处理");
    return { raw: "", text: "第一段。\n\n第二段。", threadId: "thread-stream-web" };
  });

  assert.equal(manager.isSessionStreamEnabled("account-one", session.id), true);
  await manager.continueSession("account-one", session.id, "开始", [], async (message) => {
    progress.push(message);
  });
  assert.deepEqual(progress, ["正在处理"]);

  manager.updateSessionRuntime("account-one", session.id, { streamReplies: false });
  assert.equal(manager.isSessionStreamEnabled("account-one", session.id), false);
});

test("stores Web uploads per session and exposes them in user history", async (t) => {
  const { manager, root, runs, history } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Upload chat");

  await manager.continueSession("account-one", session.id, "分析附件", [{
    name: "report?.txt",
    data: Buffer.from("report body")
  }]);
  assert.match(String(runs[0].prompt), /Web file: report_\.txt saved to/);
  assert.equal(manager.listSessions()[0].lastPromptPreview, "分析附件 文件：report_.txt");
  history[0].text = String(runs[0].prompt);

  const messages = await manager.getSessionMessages("account-one", session.id);
  assert.deepEqual(messages[0], {
    id: "user-1",
    role: "user",
    text: "分析附件",
    attachments: [{
      index: 0,
      type: "file",
      name: "report_.txt",
      size: 11,
      available: true
    }]
  });
  const attachment = await manager.getSessionAttachment("account-one", session.id, "user-1", 0);
  assert.equal(fs.readFileSync(attachment.path, "utf8"), "report body");
  assert.equal(attachment.path.startsWith(path.join(root, "inbound", "account-one", "web", session.id)), true);
});

test("reports a managed session as responding only while its Web turn is active", async (t) => {
  const { manager, paths, root, emitCodexTask, setRunHandler } = setup(t);
  let finish: ((value: { raw: string; text: string; threadId: string }) => void) | undefined;
  setRunHandler(() => new Promise((resolve) => {
    finish = resolve;
  }));
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Busy chat");
  new RuntimeStateStore(accountStatePaths(paths, "account-one"))
    .setSessionThread(session.id, "thread-busy");
  await manager.startAll();

  const pending = manager.continueSession("account-one", session.id, "继续");
  assert.equal(manager.listSessions().find((item) => item.id === session.id)?.responding, true);
  emitCodexTask({
    sessionId: "thread-busy",
    turnId: "turn-busy",
    workspace: root,
    title: "Busy chat",
    status: "running",
    startedAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:01.000Z"
  });
  const project = manager.listProjects("account-one").find((item) => item.id === session.projectId);
  assert.equal(project?.activeTaskCount, 1);
  assert.deepEqual(project?.runningTasks.map((task) => task.source), ["managed"]);
  finish?.({ raw: "", text: "完成", threadId: "thread-busy" });
  await pending;
  assert.equal(manager.listSessions().find((item) => item.id === session.id)?.responding, false);
  await manager.stopAll();
});

test("exposes files sent by Codex as session attachments", async (t) => {
  const { manager, root, history } = setup(t);
  const videoPath = path.join(root, "demo.mp4");
  fs.writeFileSync(videoPath, "video-bytes");
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Media chat");
  await manager.continueSession("account-one", session.id, "发送视频");
  history.push({
    id: "assistant-video",
    role: "assistant",
    text: `视频已发送。\n\n\`\`\`codex-weixin-actions\n{"send":[{"type":"video","path":${JSON.stringify(videoPath)}}]}\n\`\`\``
  });

  const messages = await manager.getSessionMessages("account-one", session.id);
  assert.deepEqual(messages.at(-1), {
    id: "assistant-video",
    role: "assistant",
    text: "视频已发送。",
    attachments: [{
      index: 0,
      type: "video",
      name: "demo.mp4",
      size: 11,
      available: true
    }]
  });
  assert.equal(
    (await manager.getSessionAttachment("account-one", session.id, "assistant-video", 0)).path,
    videoPath
  );
  await assert.rejects(
    manager.getSessionAttachment("account-one", session.id, "assistant-video", 1),
    /not found/
  );
});
