import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeService, parseCommand } from "../src/bridge/service.js";
import type { ChannelIntentResolverInput } from "../src/bridge/ai-channel-intent.js";
import type { FriendlyChannelIntent } from "../src/bridge/channel-intent.js";
import { buildPrompt } from "../src/bridge/format.js";
import { defaultConfig, MAX_INBOUND_BYTES } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { encryptAesEcb } from "../src/weixin/media.js";
import { normalizeWeixinMessage } from "../src/weixin/messages.js";

test("reports WeChat Codex turn status and resolves runtime details for status", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-status-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  stateStore.createProject("Test project", tmpDir);
  const replies: string[] = [];
  const statuses: Array<{ senderId: string; sessionId: string; active: boolean }> = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      codexBackend: "auto"
    },
    stateStore,
    onTurnStatus: (status) => statuses.push(status),
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        return { raw: "", text: "完成", threadId: "thread-status" };
      },
      async getRuntimeInfo() {
        return { model: "gpt-test", effort: "high" };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "turn",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "开始",
    raw: {}
  });
  const sessionId = stateStore.getActiveSession("alice@im.wechat")?.id;
  assert.deepEqual(statuses, [
    { senderId: "alice@im.wechat", sessionId, active: true },
    { senderId: "alice@im.wechat", sessionId, active: false }
  ]);

  await service.handleMessage({
    id: "status",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/status",
    raw: {}
  });
  assert.match(replies.at(-1) ?? "", /model: gpt-test/);
  assert.match(replies.at(-1) ?? "", /effort: high/);
});

test("lists every built-in command and reports the current Codex account balance without a project", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-balance-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: { async stop() {} } as never,
    getCodexBalance: async () => ({
      limitName: "Codex",
      planType: "plus",
      primary: { usedPercent: 18.5, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: null },
      credits: { hasCredits: true, unlimited: false, balance: "12.34" },
      spendControlReached: false
    })
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("help", "/help");
  const help = replies.at(-1) ?? "";
  for (const command of [
    "/help", "/status", "/balance", "/memory", "/project", "/task", "/new", "/sessions", "/session",
    "/model", "/effort", "/stream", "/prompt start", "/prompt done", "/approve", "/reject", "/stop"
  ]) {
    assert.match(help, new RegExp(command.replace("/", "\\/")));
  }
  for (const alias of ["/h", "/st", "/bal", "/mem", "/p", "/tb", "/ss", "/s", "/n", "/m", "/e", "/str", "/pp", "/ok", "/no", "/x"]) {
    assert.match(help, new RegExp(alias.replace("/", "\\/")));
  }
  assert.doesNotMatch(help, /\/bind|\/resume|\/b\b|\/r\b/);

  await send("balance", "/balance");
  assert.equal(stateStore.listProjects().length, 0);
  assert.match(replies.at(-1) ?? "", /Codex 当前账号用量/);
  assert.match(replies.at(-1) ?? "", /套餐：Plus/);
  assert.match(replies.at(-1) ?? "", /5 小时额度：剩余 81\.5%/);
  assert.match(replies.at(-1) ?? "", /7 天额度：剩余 58%/);
  assert.match(replies.at(-1) ?? "", /Credits：12\.34/);
});

test("reports each successfully sent text message for webhook mirroring", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-outbound-webhook-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const outbound: unknown[] = [];
  let sentText = "";
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore: new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state"))),
    weixin: {
      async sendText(input: { text: string }) {
        sentText = input.text;
        return { messageId: "outbound-1" };
      }
    },
    runner: { async stop() {} } as never,
    onOutboundMessage: (message) => outbound.push(message)
  });

  await service.handleMessage({
    id: "help-1",
    senderId: "alice@im.wechat",
    text: "/help",
    attachments: [],
    raw: {}
  });

  assert.equal(outbound.length, 1);
  const message = outbound[0] as { text: string } & Record<string, unknown>;
  assert.equal(message.text, sentText);
  assert.deepEqual({ ...message, text: undefined }, {
    direction: "outbound",
    id: "outbound-1",
    recipientId: "alice@im.wechat",
    text: undefined,
    attachments: []
  });
});

test("maps every documented short command to its canonical command", () => {
  const aliases: Record<string, string> = {
    h: "help",
    st: "status",
    bal: "balance",
    mem: "memory",
    p: "project",
    ss: "sessions",
    s: "session",
    n: "new",
    m: "model",
    e: "effort",
    str: "stream",
    pp: "prompt",
    ok: "approve",
    no: "reject",
    x: "stop",
    tb: "task"
  };
  for (const [alias, command] of Object.entries(aliases)) {
    assert.deepEqual(parseCommand(`/${alias} argument`), { name: command, arg: "argument" });
  }
  assert.deepEqual(parseCommand("/bind /tmp/project"), { name: "bind", arg: "/tmp/project" });
  assert.deepEqual(parseCommand("/resume R1"), { name: "resume", arg: "R1" });
});

test("sends Codex approvals to the originating sender and accepts channel decisions", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-approval-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const project = stateStore.createProject("Approval project", tmpDir);
  stateStore.createSession("alice@im.wechat", project.workspace, "Alice task", project.id);
  stateStore.createSession("bob@im.wechat", project.workspace, "Bob task", project.id);
  const replies: Array<{ toUserId: string; text: string }> = [];
  let releaseApproval!: (decision: "accept" | "decline") => void;
  const approvalSeen = new Promise<"accept" | "decline">((resolve) => { releaseApproval = resolve; });
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat", "bob@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { toUserId: string; text: string }) {
        replies.push(input);
        return { messageId: `sent-${replies.length}` };
      }
    } as never,
    runner: {
      async run(input: { onApproval?: (request: Record<string, unknown>) => Promise<"accept" | "decline"> }) {
        const decision = await input.onApproval?.({
          kind: "command",
          threadId: "thread-alice",
          turnId: "turn-alice",
          itemId: "item-alice",
          command: "touch approved.txt",
          cwd: tmpDir,
          reason: "需要创建文件"
        });
        releaseApproval(decision ?? "decline");
        return { raw: "", text: `审批结果：${decision}`, threadId: "thread-alice" };
      },
      async getRuntimeInfo() { return {}; },
      async stop() {}
    } as never
  });

  const runningTurn = service.handleMessage({
    id: "run", senderId: "alice@im.wechat", contextToken: "alice-context", text: "创建文件", attachments: [], raw: {}
  });
  for (let attempt = 0; attempt < 20 && !replies.some((reply) => /Codex 审批 A1/.test(reply.text)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(replies.find((reply) => reply.toUserId === "alice@im.wechat")?.text ?? "", /touch approved\.txt/);

  await service.handleMessage({
    id: "wrong-sender", senderId: "bob@im.wechat", text: "/ok A1", attachments: [], raw: {}
  });
  assert.match(replies.at(-1)?.text ?? "", /没有待审批/);

  await service.handleMessage({
    id: "approve", senderId: "alice@im.wechat", text: "/ok A1", attachments: [], raw: {}
  });
  assert.equal(await approvalSeen, "accept");
  await runningTurn;
  assert.match(replies.at(-2)?.text ?? "", /已批准.*A1/);
  assert.match(replies.at(-1)?.text ?? "", /审批结果：accept/);
});

test("automatically declines unanswered channel approvals after the timeout", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-approval-timeout-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const project = stateStore.createProject("Approval project", tmpDir);
  stateStore.createSession("alice@im.wechat", project.workspace, "Alice task", project.id);
  const replies: string[] = [];
  let decision: string | undefined;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    approvalTimeoutMs: 10,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) { replies.push(input.text); return { messageId: "sent" }; }
    } as never,
    runner: {
      async run(input: { onApproval?: (request: Record<string, unknown>) => Promise<"accept" | "decline"> }) {
        decision = await input.onApproval?.({
          kind: "file", threadId: "thread-timeout", turnId: "turn-timeout", itemId: "item-timeout",
          grantRoot: tmpDir, reason: "需要写入"
        });
        return { raw: "", text: "已继续", threadId: "thread-timeout" };
      },
      async getRuntimeInfo() { return {}; },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "run", senderId: "alice@im.wechat", text: "修改文件", attachments: [], raw: {}
  });

  assert.equal(decision, "decline");
  assert.ok(replies.some((reply) => /审批 A1 已超时.*自动拒绝/.test(reply)));
});

test("lists and binds Taskboard issues to the active Codex session", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-taskboard-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const project = stateStore.createProject("Project One", tmpDir);
  stateStore.createSession("alice@im.wechat", project.workspace, "Taskboard task", project.id);
  const replies: string[] = [];
  const issue = {
    id: "task-one", identifier: "PROJECT-1", projectId: "project-one", title: "Ship integration",
    description: "", status: "in_progress", priority: "high", labels: ["codex"],
    threadId: "thread-one", version: 3, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
  } as const;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    taskboard: {
      async projectForWorkspace() { return { id: "project-one", name: "Project One", workspacePath: tmpDir, issueCount: 1 }; },
      async listIssues() { return [issue]; },
      async getIssue() { return issue; }
    } as never,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) { replies.push(input.text); return { messageId: "sent" }; }
    } as never,
    runner: { async stop() {} } as never
  });
  const send = (id: string, text: string) => service.handleMessage({ id, senderId: "alice@im.wechat", text, attachments: [], raw: {} });

  await send("list", "/task");
  assert.match(replies.at(-1) ?? "", /PROJECT-1.*Ship integration/);
  await send("bind", "/task PROJECT-1");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.threadId, "thread-one");
  assert.match(replies.at(-1) ?? "", /已绑定.*PROJECT-1/);
  await send("empty-attachment", "/task attach PROJECT-1");
  assert.match(replies.at(-1) ?? "", /\/task comment PROJECT-1/);
});

test("routes Taskboard workflow mutations through Codex and the manage-taskboard skill", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-taskboard-action-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const project = stateStore.createProject("Project One", tmpDir);
  stateStore.createSession("alice@im.wechat", project.workspace, "Taskboard task", project.id);
  const prompts: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    taskboard: {
      async projectForWorkspace() { return { id: "project-one", name: "Project One", workspacePath: tmpDir, issueCount: 1 }; },
      async getIssue() { return { id: "task-one", identifier: "PROJECT-1", projectId: "project-one", title: "Ship integration", description: "", status: "todo", priority: "high", labels: [], threadId: null, version: 1, createdAt: "", updatedAt: "" }; }
    } as never,
    weixin: { async sendTyping() {}, async sendText() { return { messageId: "sent" }; } } as never,
    runner: {
      async run(input: { prompt: string }) { prompts.push(input.prompt); return { raw: "", text: "已开始", threadId: "thread-new" }; },
      async stop() {}
    } as never
  });

  await service.handleMessage({ id: "start", senderId: "alice@im.wechat", text: "/task start PROJECT-1", attachments: [], raw: {} });
  assert.match(prompts[0] ?? "", /manage-taskboard Skill/);
  assert.match(prompts[0] ?? "", /PROJECT-1/);
  assert.match(prompts[0] ?? "", /开始处理/);
});

test("uses friendly Chinese workbench intents with direct Taskboard creation, current-issue context, and cards", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-friendly-taskboard-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const project = stateStore.createProject("Project One", tmpDir);
  const session = stateStore.createSession("alice@im.wechat", project.workspace, "Taskboard task", project.id);
  stateStore.setSessionThread(session.id, "thread-one");
  const prompts: string[] = [];
  const comments: string[] = [];
  const cards: Array<{ identifier: string; projectName: string }> = [];
  const replies: string[] = [];
  const createdTitles: string[] = [];
  const classifiedContexts: ChannelIntentResolverInput[] = [];
  const resolvedIntents = new Map<string, FriendlyChannelIntent>([
    ["把现在手头在忙的事情给我捋一遍", { kind: "command", command: { name: "task", arg: "list" } }],
    ["记到待办：补充操作文档", { kind: "command", command: { name: "task", arg: "todo 补充操作文档" } }],
    ["新任务：完成飞书按钮回调", { kind: "command", command: { name: "task", arg: "new 完成飞书按钮回调" } }],
    ["记录：测试和构建均通过", { kind: "command", command: { name: "task", arg: "comment current 测试和构建均通过" } }],
    ["退回：缺少飞书真机点击验证", { kind: "command", command: { name: "task", arg: "return current 缺少飞书真机点击验证" } }],
    ["查看当前项目", { kind: "command", command: { name: "status", arg: "" } }]
  ]);
  const issue = {
    id: "task-one", identifier: "PROJECT-1", projectId: "project-one", title: "Ship integration",
    description: "Finish phase two", status: "in_review", priority: "high", labels: ["codex"],
    threadId: "thread-one", version: 3, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z"
  } as const;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    taskboard: {
      async projectForWorkspace() { return { id: "project-one", name: "Project One", workspacePath: tmpDir, issueCount: 1 }; },
      async listIssues() { return [issue]; },
      async getIssue(identifier: string) {
        if (identifier === "PROJECT-1") return issue;
        if (identifier === "PROJECT-2" && createdTitles.length) {
          return {
            ...issue,
            id: "task-two",
            identifier: "PROJECT-2",
            title: createdTitles.at(-1) ?? "Created task",
            status: "todo",
            threadId: null,
            version: 1
          };
        }
        throw new Error("not found");
      },
      async issueForThread() { return issue; },
      async listComments() { return [{ body: "All checks passed" }]; },
      async addComment(_id: string, body: string) { comments.push(body); return { body }; },
      async createIssue(input: { title: string }) {
        createdTitles.push(input.title);
        return { ...issue, id: "task-two", identifier: "PROJECT-2", title: input.title, status: "todo", threadId: null, version: 1 };
      }
    } as never,
    weixin: {
      async sendText(input: { text: string }) { replies.push(input.text); return { messageId: "sent" }; },
      async sendTaskCard(input) {
        cards.push({ identifier: input.card.identifier, projectName: input.card.projectName });
        return { messageId: `card-${cards.length}` };
      }
    },
    intentResolver: {
      async resolve(input) {
        classifiedContexts.push(input);
        const intent = resolvedIntents.get(input.text);
        assert.ok(intent);
        return intent;
      }
    },
    runner: {
      async run(input: { prompt: string; threadId?: string }) {
        prompts.push(input.prompt);
        return { raw: "", text: "已处理", threadId: input.threadId ?? "thread-one" };
      },
      async getRuntimeInfo() { return { model: "gpt-test", effort: "high" }; },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id, senderId: "alice@im.wechat", text, attachments: [], raw: {}
  });

  await send("list", "把现在手头在忙的事情给我捋一遍");
  assert.deepEqual(cards.at(-1), { identifier: "overview:project-one", projectName: "Project One" });
  assert.deepEqual(classifiedContexts[0], {
    text: "把现在手头在忙的事情给我捋一遍",
    currentProjectName: "Project One",
    projectNames: ["Project One"]
  });
  assert.equal(prompts.length, 0);

  await send("todo", "记到待办：补充操作文档");
  assert.deepEqual(createdTitles, ["补充操作文档"]);
  assert.equal(prompts.length, 0);
  assert.equal(cards.at(-1)?.identifier, "PROJECT-2");

  await send("new", "新任务：完成飞书按钮回调");
  assert.deepEqual(createdTitles, ["补充操作文档", "完成飞书按钮回调"]);
  assert.match(prompts.at(-1) ?? "", /领取并开始处理刚创建的 PROJECT-2/);

  await send("comment", "记录：测试和构建均通过");
  assert.deepEqual(comments, ["测试和构建均通过"]);

  await send("return", "退回：缺少飞书真机点击验证");
  assert.match(prompts.at(-1) ?? "", /退回处理中/);
  assert.match(prompts.at(-1) ?? "", /缺少飞书真机点击验证/);

  await send("status", "查看当前项目");
  assert.match(replies.at(-1) ?? "", /项目：Project One/);
  assert.match(replies.at(-1) ?? "", /任务：PROJECT-1 · 待验收 · Ship integration/);

  const classificationCount = classifiedContexts.length;
  await send("slash-list", "/task list");
  assert.equal(classifiedContexts.length, classificationCount);
  assert.deepEqual(cards.at(-1), { identifier: "overview:project-one", projectName: "Project One" });
});

test("automatically learns and reuses account knowledge with user controls", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-knowledge-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const project = stateStore.createProject("内容项目", tmpDir);
  stateStore.createSession("alice@im.wechat", project.workspace, "内容任务", project.id);
  const prompts: string[] = [];
  const replies: string[] = [];
  let runCount = 0;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async run(input: { prompt: string }) {
        prompts.push(input.prompt);
        runCount += 1;
        if (runCount === 1) {
          return {
            raw: "",
            text: [
              "记住了。",
              "```codex-weixin-actions",
              JSON.stringify({
                remember: [{
                  kind: "preference",
                  scope: "account",
                  title: "回复风格",
                  content: "默认使用简体中文，并先给结论"
                }]
              }),
              "```"
            ].join("\n")
          };
        }
        return { raw: "", text: "继续处理。" };
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("learn", "以后请用中文并先给结论");
  assert.equal(stateStore.listKnowledge()[0]?.title, "回复风格");
  assert.equal(replies.at(-1), "记住了。");

  await send("reuse", "继续规划下一篇内容");
  assert.match(prompts[1] ?? "", /默认使用简体中文，并先给结论/);

  await send("list", "/memory");
  assert.match(replies.at(-1) ?? "", /\[K1\].*偏好/);
  assert.match(replies.at(-1) ?? "", /回复风格/);

  await send("disable", "/memory off");
  await send("disabled-turn", "再处理一篇");
  assert.doesNotMatch(prompts.at(-1) ?? "", /默认使用简体中文，并先给结论/);
});

test("sends local markdown images as native WeChat image messages", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const imagePath = path.join(tmpDir, "generated_image_latest.png");
  fs.writeFileSync(imagePath, Buffer.from("png image bytes"));
  const markdownPath = imagePath.replace(/\\/g, "/");

  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  stateStore.createProject("Test project", tmpDir);
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"],
    codexBackend: "exec" as const
  };
  const textReplies: string[] = [];
  const imageMessages: Array<Record<string, unknown>> = [];
  const outbound: Array<Record<string, unknown>> = [];
  const weixin = {
    async sendTyping() {},
    async sendText(input: { text: string }) {
      textReplies.push(input.text);
      return { messageId: "text-message" };
    },
    async getUploadUrl() {
      return { uploadParam: "upload-token" };
    },
    async sendImageMessage(input: Record<string, unknown>) {
      imageMessages.push(input);
      return { messageId: "image-message" };
    },
    async sendFileMessage() {
      throw new Error("expected image message");
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", {
    status: 200,
    headers: { "x-encrypted-param": "download-param" }
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const service = new BridgeService({
    config,
    stateStore,
    weixin,
    onOutboundMessage: (message) => outbound.push(message),
    runner: {
      async run() {
        return {
          raw: "",
          text: [
            "找到了这张，来自下载目录：",
            "",
            `![generated_image_latest.png](${markdownPath})`,
            "",
            `如果图片没有直接显示，点这里打开：[generated_image_latest.png](${markdownPath})`
          ].join("\n")
        };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "message-1",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "从电脑里面找一张图片发给我",
    raw: {}
  });

  assert.equal(imageMessages.length, 1);
  assert.equal(imageMessages[0].toUserId, "alice@im.wechat");
  assert.equal(imageMessages[0].contextToken, "ctx");
  assert.equal(imageMessages[0].encryptQueryParam, "download-param");
  assert.equal(textReplies.some((reply) => reply.includes("[codex-channel-bridge] File send requested")), false);
  assert.equal(textReplies.some((reply) => reply.includes(markdownPath)), false);
  assert.equal(textReplies.join("\n").includes("如果图片没有直接显示"), false);
  assert.deepEqual(outbound.find((message) => (
    Array.isArray(message.attachments) && message.attachments.length > 0
  )), {
    direction: "outbound",
    id: "image-message",
    recipientId: "alice@im.wechat",
    text: "",
    attachments: [{ kind: "image", label: "generated_image_latest.png" }]
  });
});

test("sends local markdown videos as native WeChat video messages", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-video-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const videoPath = path.join(tmpDir, "desktop-demo.mp4");
  fs.writeFileSync(videoPath, Buffer.from("mp4 video bytes"));
  const markdownPath = videoPath.replace(/\\/g, "/");

  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  stateStore.createProject("Test project", tmpDir);
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"],
    codexBackend: "exec" as const
  };
  const textReplies: string[] = [];
  const videoMessages: Array<Record<string, unknown>> = [];
  const weixin = {
    async sendTyping() {},
    async sendText(input: { text: string }) {
      textReplies.push(input.text);
      return { messageId: "text-message" };
    },
    async getUploadUrl() {
      return { uploadParam: "upload-token" };
    },
    async sendImageMessage() {
      throw new Error("expected video message");
    },
    async sendFileMessage() {
      throw new Error("expected video message");
    },
    async sendVideoMessage(input: Record<string, unknown>) {
      videoMessages.push(input);
      return { messageId: "video-message" };
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", {
    status: 200,
    headers: { "x-encrypted-param": "download-param" }
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const service = new BridgeService({
    config,
    stateStore,
    weixin,
    runner: {
      async run() {
        return {
          raw: "",
          text: `Random desktop video: [desktop-demo.mp4](${markdownPath})`
        };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "message-1",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "send me a random video from desktop",
    raw: {}
  });

  assert.equal(videoMessages.length, 1);
  assert.equal(videoMessages[0].toUserId, "alice@im.wechat");
  assert.equal(videoMessages[0].contextToken, "ctx");
  assert.equal(videoMessages[0].encryptQueryParam, "download-param");
  assert.equal(textReplies.some((reply) => reply.includes(markdownPath)), false);
});

test("buffers inbound image attachments and includes local paths in prompt done", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-buffer-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("inbound image bytes")
  ]);
  const ciphertext = encryptAesEcb(plaintext, key);
  const aesKeyBase64 = Buffer.from(key.toString("hex"), "utf8").toString("base64");

  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  stateStore.createProject("Test project", tmpDir);
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"],
    codexBackend: "exec" as const
  };
  const textReplies: string[] = [];
  let prompt = "";
  const service = new BridgeService({
    config,
    stateStore,
    inboundDir: path.join(tmpDir, "inbound"),
    mediaFetch: async () => new Response(new Uint8Array(ciphertext), { status: 200 }),
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        textReplies.push(input.text);
        return { messageId: "text-message" };
      },
      async getUploadUrl() {
        throw new Error("not used");
      },
      async sendImageMessage() {
        throw new Error("not used");
      },
      async sendFileMessage() {
        throw new Error("not used");
      }
    },
    runner: {
      async run(input: { prompt: string }) {
        prompt = input.prompt;
        return { raw: "", text: "done" };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "start",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/pp s",
    raw: {}
  });

  const imageMessage = normalizeWeixinMessage({
    message_id: "img-1",
    from_user_id: "alice@im.wechat",
    context_token: "ctx",
    item_list: [{
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: "download-token",
          aes_key: aesKeyBase64
        }
      }
    }]
  });
  assert.ok(imageMessage);
  await service.handleMessage(imageMessage);

  await service.handleMessage({
    id: "text-1",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "描述这张图片",
    raw: {}
  });

  await service.handleMessage({
    id: "done",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/pp d",
    raw: {}
  });

  assert.match(prompt, /WeChat image: image\.png saved to /);
  assert.match(prompt, /描述这张图片/);
  const savedPath = prompt.match(/saved to ([^\]]+)/)?.[1];
  assert.ok(savedPath);
  assert.deepEqual(fs.readFileSync(savedPath), plaintext);
  assert.equal(textReplies.filter((reply) => reply === "Buffered. Send /prompt done when ready.").length, 2);
});

test("replies directly when a WeChat attachment exceeds 100 MiB", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-oversize-notice-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  stateStore.createProject("Test project", tmpDir);
  const replies: string[] = [];
  let runnerCalled = false;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    mediaFetch: async () => new Response(null, {
      status: 200,
      headers: { "content-length": String(MAX_INBOUND_BYTES + 1) }
    }),
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        runnerCalled = true;
        return { raw: "", text: "不应执行" };
      },
      async stop() {}
    } as never
  });

  const message = normalizeWeixinMessage({
    message_id: "video-large",
    from_user_id: "alice@im.wechat",
    context_token: "ctx",
    item_list: [{
      type: 5,
      video_item: {
        media: { full_url: "https://example.test/video" },
        video_size: MAX_INBOUND_BYTES + 1
      }
    }]
  });
  assert.ok(message);
  await service.handleMessage(message);

  assert.equal(runnerCalled, false);
  assert.deepEqual(replies, ["附件超过 100 MiB 上限，请压缩或裁剪后重新发送。"]);
});

test("lists resumable sessions with unambiguous R codes and switches by code", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-resume-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const project = stateStore.createProject("桌面客户端", "/work/one");
  const first = stateStore.createSession("alice@im.wechat", project.workspace, "更新修复", project.id);
  stateStore.setThread("alice@im.wechat", "thread-one");
  stateStore.setSessionPromptPreview(first.id, "修复 macOS 自动更新");
  const second = stateStore.createSession("alice@im.wechat", project.workspace, "季度报告", project.id);
  stateStore.setThread("alice@im.wechat", "thread-two");
  const unrelatedProject = stateStore.createProject("其他项目", "/work/two");
  stateStore.createSession("alice@im.wechat", unrelatedProject.workspace, "不应出现", unrelatedProject.id);
  stateStore.activateSession(second.id);
  const replies: string[] = [];
  const runs: Array<{ prompt: string; threadId?: string }> = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async getHistory(threadId: string) {
        assert.equal(threadId, "thread-two");
        return [{
          id: "history-user",
          role: "user" as const,
          text: buildPrompt("分析季度报告", [{
            kind: "file",
            label: "report.pdf",
            path: "/private/report.pdf"
          }])
        }];
      },
      async run(input: { prompt: string; threadId?: string }) {
        runs.push(input);
        return { raw: "", text: "继续完成", threadId: input.threadId };
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  const listedSessions = stateStore.listSessions()
    .filter((session) => session.senderId === "alice@im.wechat" && session.projectId === project.id);
  const firstNumber = listedSessions.findIndex((session) => session.id === first.id) + 1;
  const secondNumber = listedSessions.findIndex((session) => session.id === second.id) + 1;

  await send("resume-list", "/sessions");
  const listReply = replies.at(-1) ?? "";
  assert.match(listReply, /项目“桌面客户端”最近活跃的会话（最多 10 个）/);
  assert.match(listReply, new RegExp(`\\[R${secondNumber}\\] 【当前】季度报告`));
  assert.match(listReply, /最近内容：分析季度报告 文件：report\.pdf/);
  assert.match(listReply, new RegExp(`\\[R${firstNumber}\\] 更新修复`));
  assert.match(listReply, /修复 macOS 自动更新/);
  assert.match(listReply, /\/session R1 绑定并继续对应会话/);
  assert.doesNotMatch(listReply, /不应出现/);
  assert.doesNotMatch(listReply, /thread-one|thread-two|private\/report/);
  assert.equal(stateStore.getSession(second.id)?.lastPromptPreview, "分析季度报告 文件：report.pdf");

  await send("resume-bare-number", "/session 2");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.id, second.id);
  assert.match(replies.at(-1) ?? "", /R 开头的切换编号/);

  await send("resume-invalid", "/session R99");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.id, second.id);
  assert.match(replies.at(-1) ?? "", /没有这个切换编号/);

  await send("resume-first", `/session r${firstNumber}`);
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.id, first.id);
  assert.match(replies.at(-1) ?? "", /已绑定项目“桌面客户端”的会话：更新修复/);
  assert.doesNotMatch(replies.at(-1) ?? "", /thread-one/);

  await send("continued-turn", "继续处理");
  assert.equal(runs.at(-1)?.threadId, "thread-one");
});

test("lists only the ten most recent sessions in the current project", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-project-sessions-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const project = stateStore.createProject("当前项目", path.join(tmpDir, "current"));
  const sessions = Array.from({ length: 11 }, (_, index) =>
    stateStore.createSession("alice@im.wechat", project.workspace, `项目会话 ${index + 1}`, project.id)
  );
  const other = stateStore.createProject("其他项目", path.join(tmpDir, "other"));
  stateStore.createSession("alice@im.wechat", other.workspace, "其他项目会话", other.id);
  const latestSession = sessions.at(-1);
  assert.ok(latestSession);
  stateStore.activateSession(latestSession.id);
  const replies: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: { async stop() {} } as never
  });

  await service.handleMessage({
    id: "sessions",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/sessions",
    raw: {}
  });

  const reply = replies.join("\n");
  assert.equal(reply.match(/\[R\d+\]/g)?.length, 10);
  assert.doesNotMatch(reply, /\[R11\]/);
  assert.doesNotMatch(reply, /其他项目会话/);
});

test("binds a Codex Desktop session from the current project and continues its thread", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bind-desktop-session-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const project = stateStore.createProject("桌面项目", tmpDir);
  stateStore.createSession("alice@im.wechat", project.workspace, "桥接会话", project.id);
  const replies: string[] = [];
  const runs: Array<{ threadId?: string; queueKey?: string }> = [];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    listCodexSessions: () => [{
      threadId: "desktop-thread",
      workspace: tmpDir,
      lastUsedAt: "2099-08-01T09:00:00.000Z",
      lastUserMessage: buildPrompt("继续桌面端方案")
    }],
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async run(input: { threadId?: string; queueKey?: string }) {
        runs.push(input);
        return { raw: "", text: "已继续", threadId: input.threadId };
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("list", "/sessions");
  assert.match(replies.at(-1) ?? "", /\[R1\] 继续桌面端方案/);
  await send("bind", "/session R1");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.threadId, "desktop-thread");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.projectId, project.id);
  assert.match(replies.at(-1) ?? "", /下一条消息将继续该历史会话/);

  await send("continue", "接着完成");
  assert.equal(runs.at(-1)?.threadId, "desktop-thread");
  assert.equal(runs.at(-1)?.queueKey, "desktop-thread");
});

test("authorized WeChat can add, list, and switch Codex projects", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-project-command-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const workspace = path.join(tmpDir, "jiaxing-ai");
  fs.mkdirSync(workspace);
  const candidate = {
    name: "嘉兴AI社区",
    workspace,
    lastUsedAt: "2026-07-30T08:00:00.000Z",
    sessionCount: 3
  };
  const serviceWithProjects = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: { async run() { return { raw: "", text: "ok" }; }, async stop() {} } as never,
    listCodexProjects: () => [candidate]
  });
  const sendWithProjects = (id: string, text: string) => serviceWithProjects.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  // Commands and ordinary messages on a fresh account do not create a default-directory project.
  for (const [id, text] of [
    ["project-help", "/help"],
    ["project-status", "/status"],
    ["project-new", "/new"],
    ["project-model", "/model"],
    ["project-message", "开始处理任务"]
  ]) {
    await sendWithProjects(id, text);
    assert.equal(stateStore.listProjects().length, 0);
    assert.equal(stateStore.listSessions().length, 0);
  }

  // Given an authorized sender, when they choose a project sourced from Codex history
  await sendWithProjects("project-discover", "/p a");
  assert.match(replies.at(-1) ?? "", /\[C1\] 嘉兴AI社区/);
  assert.doesNotMatch(replies.at(-1) ?? "", /项目名称\|绝对路径/);
  await sendWithProjects("project-add", "/p a C1");
  await sendWithProjects("project-list", "/p l");
  const projects = stateStore.listProjects();
  const projectNumber = projects.findIndex((project) => project.name === "嘉兴AI社区") + 1;
  const addedProject = projects[projectNumber - 1];
  assert.match(replies.at(-1) ?? "", /已绑定的 Codex 项目/);
  assert.match(replies.at(-1) ?? "", new RegExp(`\\[P${projectNumber}\\] 嘉兴AI社区`));

  // Removed legacy channel commands are not retained as compatibility aliases.
  const manualWorkspace = path.join(tmpDir, "manual-path");
  await sendWithProjects("manual-bind", `/bind ${manualWorkspace}`);
  assert.match(replies.at(-1) ?? "", /未知命令：\/bind/);
  assert.equal(stateStore.listProjects().some((project) => project.workspace === manualWorkspace), false);

  await sendWithProjects("project-rename", `/p rn P${projectNumber}|嘉兴AI社区`);
  assert.match(replies.at(-1) ?? "", /已重命名 Codex 项目/);
  await sendWithProjects("project-switch", `/p P${projectNumber}`);
  assert.match(replies.at(-1) ?? "", /请选择接下来要进入的工作模式/);
  assert.equal(stateStore.getActiveProject("alice@im.wechat")?.id, addedProject?.id);
  assert.equal(stateStore.getActiveSession("alice@im.wechat"), undefined);
  await sendWithProjects("legacy-resume", "/resume R1");
  assert.match(replies.at(-1) ?? "", /未知命令：\/resume/);

  // Then a mode-specific session is created only when the user enters work.
  await sendWithProjects("project-new-session", "/new");
  assert.equal(stateStore.getWorkspace("alice@im.wechat"), workspace);
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.projectId, addedProject?.id);
  assert.match(replies.at(-1) ?? "", /已在当前项目“嘉兴AI社区”新建并绑定会话/);
  await sendWithProjects("project-delete-blocked", `/p d P${projectNumber}`);
  assert.match(replies.at(-1) ?? "", /项目下还有任务/);
});

test("switching projects does not expose or control the previous project's session", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-project-context-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const firstWorkspace = path.join(tmpDir, "first");
  const secondWorkspace = path.join(tmpDir, "second");
  fs.mkdirSync(firstWorkspace);
  fs.mkdirSync(secondWorkspace);
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const firstProject = stateStore.createProject("First", firstWorkspace);
  const secondProject = stateStore.createProject("Second", secondWorkspace);
  const firstSession = stateStore.createSession("alice@im.wechat", firstWorkspace, "First session", firstProject.id);
  stateStore.setSessionThread(firstSession.id, "thread-first");
  stateStore.setInteractionMode("alice@im.wechat", "qa");
  const replies: string[] = [];
  let goalReads = 0;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendText(input: { text: string }) { replies.push(input.text); return { messageId: "sent" }; }
    } as never,
    runner: {
      async getGoal() { goalReads += 1; return undefined; },
      async stop() {}
    } as never
  });
  const secondIndex = stateStore.listProjects().findIndex((project) => project.id === secondProject.id) + 1;

  await service.handleMessage({
    id: "switch", senderId: "alice@im.wechat", text: `/project P${secondIndex}`, attachments: [], raw: {}
  });
  await service.handleMessage({
    id: "status", senderId: "alice@im.wechat", text: "/status", attachments: [], raw: {}
  });
  await service.handleMessage({
    id: "goal", senderId: "alice@im.wechat", text: "/goal", attachments: [], raw: {}
  });

  assert.equal(stateStore.getActiveProject("alice@im.wechat")?.id, secondProject.id);
  assert.equal(stateStore.getInteractionMode("alice@im.wechat"), "session");
  assert.doesNotMatch(replies.at(-2) ?? "", /First session|thread-first/);
  assert.match(replies.at(-2) ?? "", /会话：新会话/);
  assert.equal(goalReads, 0);
  assert.match(replies.at(-1) ?? "", /尚未创建 Codex thread/);
});

test("lists and switches model and reasoning effort for the active WeChat session", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-model-command-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(path.join(tmpDir, "state"));
  const stateStore = new RuntimeStateStore(paths);
  stateStore.createProject("Test project", tmpDir);
  const replies: string[] = [];
  const runs: Array<{ model?: string; effort?: string }> = [];
  const models = [{
    model: "gpt-default",
    displayName: "GPT Default",
    description: "Default model",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [
      { effort: "low", description: "Low" },
      { effort: "medium", description: "Medium" }
    ]
  }, {
    model: "gpt-fast",
    displayName: "GPT Fast",
    description: "Fast model",
    isDefault: false,
    defaultEffort: "low",
    supportedEfforts: [
      { effort: "low", description: "Low" },
      { effort: "high", description: "High" }
    ]
  }];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      model: "gpt-default",
      effort: "medium"
    },
    stateStore,
    listCodexModels: async () => models,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run(input: { model?: string; effort?: string }) {
        runs.push(input);
        return { raw: "", text: "done", threadId: "thread-model" };
      },
      async getRuntimeInfo() {
        return { model: "runtime-model", effort: "low" };
      },
      async stop() {}
    } as never
  });
  const send = async (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("model-list", "/model");
  assert.match(replies.at(-1) ?? "", /2\. GPT Fast（gpt-fast）/);
  await send("model-switch", "/model 2");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.model, "gpt-fast");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.effort, "low");

  await send("effort-list", "/effort");
  assert.match(replies.at(-1) ?? "", /2\. 高（high）/);
  assert.doesNotMatch(replies.at(-1) ?? "", /medium/);
  await send("effort-switch", "/effort 2");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.effort, "high");
  await send("invalid-effort", "/effort ultra");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.effort, "high");

  await send("turn", "使用当前设置");
  assert.equal(runs.at(-1)?.model, "gpt-fast");
  assert.equal(runs.at(-1)?.effort, "high");
  await send("status", "/status");
  assert.match(replies.at(-1) ?? "", /model: gpt-fast/);
  assert.match(replies.at(-1) ?? "", /effort: high/);

  const overriddenSession = stateStore.getActiveSession("alice@im.wechat")?.id;
  await send("new", "/new");
  await send("new-turn", "新会话使用默认值");
  assert.equal(runs.at(-1)?.model, "gpt-default");
  assert.equal(runs.at(-1)?.effort, "medium");

  assert.ok(overriddenSession);
  stateStore.activateSession(overriddenSession);
  await send("model-default", "/model default");
  await send("effort-default", "/effort default");
  await send("default-turn", "恢复默认值");
  assert.equal(runs.at(-1)?.model, "gpt-default");
  assert.equal(runs.at(-1)?.effort, "medium");
  assert.equal(new RuntimeStateStore(paths).getSession(overriddenSession)?.model, undefined);
  assert.equal(new RuntimeStateStore(paths).getSession(overriddenSession)?.effort, undefined);
});

test("streams process progress but sends the final WeChat answer as one message", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stream-command-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  stateStore.createProject("Test project", tmpDir);
  const replies: string[] = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      streamReplies: false
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run(input: {
        onDelta?: (delta: string) => Promise<void>;
        onProgress?: (message: string) => Promise<void>;
      }) {
        assert.equal(input.onDelta, undefined);
        await input.onProgress?.("正在查询资料。");
        return {
          raw: "",
          threadId: "thread-stream",
          text: [
            "第一段。",
            "",
            "第二段。",
            "",
            "```codex-weixin-actions",
            '{"send":[]}',
            "```"
          ].join("\n")
        };
      },
      async getRuntimeInfo() {
        return {};
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("status-default", "/stream");
  assert.match(replies.at(-1) ?? "", /关闭.*继承全局/);
  await send("enable", "/stream on");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.streamReplies, true);
  await send("turn", "开始流式回复");
  assert.equal(replies.filter((reply) => reply === "【进度】正在查询资料。").length, 1);
  assert.equal(replies.filter((reply) => reply === "第一段。\n\n第二段。").length, 1);
  assert.equal(replies.filter((reply) => reply === "第一段。").length, 0);
  assert.equal(replies.some((reply) => reply.includes("codex-weixin-actions")), false);

  await send("inherit", "/stream default");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.streamReplies, undefined);
  await send("disable", "/stream off");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.streamReplies, false);
});

test("preserves the tail of a long final answer with bounded WeChat chunks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-long-reply-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  stateStore.createProject("Test project", tmpDir);
  const replies: string[] = [];
  const finalText = `${"长回答".repeat(700)}\n\n来源：arXiv 官方作者检索。`;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      streamReplies: true
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async run(input: { onProgress?: (message: string) => Promise<void> }) {
        await input.onProgress?.("正在检索论文。");
        return { raw: "", threadId: "thread-long", text: finalText };
      },
      async getRuntimeInfo() {
        return {};
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "long",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "查询论文",
    raw: {}
  });

  assert.equal(replies[0], "【进度】正在检索论文。");
  const finalChunks = replies.slice(1);
  assert.equal(finalChunks.length, 2);
  assert.equal(finalChunks.every((chunk) => chunk.length <= 1_800), true);
  assert.equal(finalChunks.join(""), finalText);
  assert.match(finalChunks.at(-1) ?? "", /来源：arXiv 官方作者检索。$/);
});
