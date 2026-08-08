import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aiChannelActionNamesForCapabilities,
  commandsFromAiChannelIntentOutput
} from "../src/bridge/ai-channel-intent-decision.js";
import { AiChannelIntentResolver } from "../src/bridge/ai-channel-intent.js";
import {
  channelCapabilityAliases,
  resolveChannelCapabilityCommand
} from "../src/bridge/channel-capability.js";
import { createInstalledSkillCapabilitiesProvider } from "../src/bridge/installed-skill-capabilities.js";
import { BridgeService, parseCommand } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const weeklySkillSource = path.join(repositoryRoot, "taskboard", "skills", "manage-weekly-report");

const action = (intent: string, detail: string | null = null) => ({
  intent,
  confidence: 0.97,
  target: null,
  detail
});

function installWeeklySkill(codexHome: string): void {
  fs.mkdirSync(path.join(codexHome, "skills"), { recursive: true });
  fs.cpSync(weeklySkillSource, path.join(codexHome, "skills", "manage-weekly-report"), {
    recursive: true
  });
}

test("loads the weekly-report capability manifest after installation without recreating the provider", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-capability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = createInstalledSkillCapabilitiesProvider({ codexHome: root });

  assert.deepEqual(await provider(), []);
  installWeeklySkill(root);
  assert.deepEqual((await provider()).map((capability) => capability.id), ["weekly-report"]);
});

test("maps manifest-declared aliases and operations to one installed Skill", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-aliases-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installWeeklySkill(root);
  const capabilities = await createInstalledSkillCapabilitiesProvider({ codexHome: root })();
  const aliases = channelCapabilityAliases(capabilities);

  assert.deepEqual(parseCommand("/wr mail", aliases), { name: "weekly", arg: "mail" });
  assert.deepEqual(parseCommand("/周报 确认", aliases), { name: "weekly", arg: "确认" });

  for (const [arg, operation] of [
    ["", "status"],
    ["open", "open"],
    ["collect 已完成渠道联调", "collect"],
    ["draft", "draft"],
    ["confirm", "confirm"],
    ["mail", "mail"],
    ["publish", "publish"]
  ] as const) {
    const resolution = resolveChannelCapabilityCommand({ name: "weekly", arg }, capabilities);
    assert.equal(resolution?.kind, "run_skill");
    if (resolution?.kind === "run_skill") {
      assert.equal(resolution.skillName, "manage-weekly-report");
      assert.equal(resolution.operation, operation);
    }
  }

  assert.equal(
    resolveChannelCapabilityCommand({ name: "weekly", arg: "unsupported" }, capabilities)?.kind,
    "reply"
  );
});

test("exposes and maps manifest-declared AI actions only with the same capability snapshot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-ai-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installWeeklySkill(root);
  const capabilities = await createInstalledSkillCapabilitiesProvider({ codexHome: root })();
  const output = JSON.stringify({
    schemaVersion: 2,
    kind: "actions",
    actions: [action("weekly_collect", "继续整理本周周报"), action("weekly_mail", "第 32 周")]
  });

  assert.deepEqual(aiChannelActionNamesForCapabilities([]).filter((name) => name.startsWith("weekly_")), []);
  assert.deepEqual(
    aiChannelActionNamesForCapabilities(capabilities).filter((name) => name.startsWith("weekly_")),
    ["weekly_status", "weekly_open", "weekly_collect", "weekly_draft", "weekly_confirm", "weekly_mail", "weekly_publish"]
  );
  assert.equal(commandsFromAiChannelIntentOutput(output, []), undefined);
  assert.deepEqual(commandsFromAiChannelIntentOutput(output, capabilities), [
    { name: "weekly", arg: "collect 继续整理本周周报" },
    { name: "weekly", arg: "mail 第 32 周" }
  ]);

  const schemas: string[] = [];
  const resolver = new AiChannelIntentResolver(async (_prompt, outputSchema) => {
    schemas.push(JSON.stringify(outputSchema));
    return output;
  });
  const baseInput = {
    text: "继续整理周报，然后生成邮件草稿",
    actorId: "alice",
    conversationId: "alice",
    conversationKind: "direct" as const,
    projectNames: ["Bridge"]
  };
  assert.equal(await resolver.resolve(baseInput), undefined);
  assert.deepEqual(await resolver.resolve({ ...baseInput, availableCapabilities: capabilities }), {
    kind: "command_sequence",
    commands: [
      { name: "weekly", arg: "collect 继续整理本周周报" },
      { name: "weekly", arg: "mail 第 32 周" }
    ]
  });
  assert.doesNotMatch(schemas[0] ?? "", /weekly_collect/);
  assert.match(schemas[1] ?? "", /weekly_collect/);
});

test("injects installed Skill shortcuts and natural-language commands into a running Bridge service", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, ".codex");
  const provider = createInstalledSkillCapabilitiesProvider({ codexHome });
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = stateStore.createProject("Bridge", root);
  stateStore.createSession("alice", project.workspace, "周报", project.id);
  const replies: string[] = [];
  const prompts: string[] = [];
  let capabilityProviderCalls = 0;
  let intentResolverCalls = 0;
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["alice"] },
    stateStore,
    channelCapabilities: async () => {
      capabilityProviderCalls += 1;
      return provider();
    },
    weixin: {
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `reply-${replies.length}` };
      }
    },
    intentResolver: {
      async resolve(input) {
        intentResolverCalls += 1;
        if (input.text !== "继续整理本周周报") return undefined;
        return { kind: "command", command: { name: "weekly", arg: "collect" } };
      }
    },
    runner: {
      async run(input: { prompt: string }) {
        prompts.push(input.prompt);
        return { raw: "", text: "已进入周报流程", threadId: "weekly-thread" };
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice",
    text,
    attachments: [],
    raw: {}
  });

  await send("help-before", "/help");
  assert.doesNotMatch(replies.at(-1) ?? "", /\/weekly/);

  installWeeklySkill(codexHome);
  await send("help-after", "/help");
  assert.match(replies.at(-1) ?? "", /\/weekly/);

  await send("mail", "/wr mail");
  assert.equal(intentResolverCalls, 0);
  await send("collect", "继续整理本周周报");
  assert.equal(intentResolverCalls, 1);
  assert.equal(capabilityProviderCalls, 4);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.match(prompt, /\$manage-weekly-report/);
});

test("keeps installed Skill execution behind the existing project requirement", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-skill-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installWeeklySkill(root);
  const capabilities = await createInstalledSkillCapabilitiesProvider({ codexHome: root })();
  const replies: string[] = [];
  let runnerCalls = 0;
  const service = new BridgeService({
    config: { ...defaultConfig(root), allowedSenderIds: ["alice"] },
    stateStore: new RuntimeStateStore(resolveStatePaths(path.join(root, "state"))),
    channelCapabilities: () => capabilities,
    weixin: {
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "reply" };
      }
    },
    runner: {
      async run() {
        runnerCalls += 1;
        return { raw: "", text: "unexpected" };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({ id: "weekly", senderId: "alice", text: "/weekly", attachments: [], raw: {} });

  assert.equal(runnerCalls, 0);
  assert.match(replies.at(-1) ?? "", /还没有绑定 Codex 项目/);
});

test("keeps weekly-report knowledge outside codex-weixin core source", () => {
  const forbidden = /weekly-report|manage-weekly-report|weekly_|周报/i;
  const coreFiles = [
    ...fs.readdirSync(path.join(repositoryRoot, "src", "bridge"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(repositoryRoot, "src", "bridge", name)),
    path.join(repositoryRoot, "src", "server", "account-manager.ts"),
    path.join(repositoryRoot, "scripts", "install-local.mjs"),
    path.join(repositoryRoot, "taskboard", "inject", "codex-taskboard.user.js"),
    path.join(repositoryRoot, "taskboard", "scripts", "codex-injector.mjs")
  ];

  for (const file of coreFiles) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), forbidden, file);
  }
});
