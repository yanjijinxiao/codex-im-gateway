import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Lexer } from "marked";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { ChannelTurnPresentation } from "../src/channels/turn-presentation.js";
import type { ChannelStreamCheckpoint } from "../src/channels/progress.js";
import { withIDEEntry, ideEntryLink } from "../src/ide/completion.js";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { dingTalkLoadingBody, normalizeDingTalkCardContent } from "../src/channels/dingtalk-markdown.js";

const first = "https://203.0.113.1:8790/workspace/project", second = "https://203.0.113.2:8790/workspace/project";
function fixture(t: test.TestContext) {
  const starts: Array<{ text: string; streamId?: string }> = [], frames: Array<{ text: string; finalize?: boolean; activity?: string; messageId: string }> = [];
  let url: string | undefined = first;
  const client = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available", turnStatusHeader: "available", progressFooter: "available", resumableProgress: true }, {
    async sendText() { throw Error("must keep the original card"); },
    async startTextStream(input) { starts.push(input); return { messageId: input.streamId! }; },
    async updateTextStream(input) { frames.push(input); }
  });
  let stream: ChannelTurnPresentation;
  const make = (restore?: ChannelStreamCheckpoint) => new ChannelTurnPresentation(client, "group", { restore, save() {}, decorateProgress: text => withIDEEntry(text, url, { atEnd: true }) });
  stream = make(); t.after(() => stream.suspend());
  return { starts, frames, get stream() { return stream; }, entry(value?: string) { url = value; },
    async restart() { const restore = stream.checkpoint(); await stream.suspend(); stream = make(restore); } };
}
function footer(text: string, url: string) {
  assert.ok(text.endsWith(ideEntryLink(url)), "the single entry is the final card paragraph");
  assert.equal(text.split("[打开项目 Web IDE]").length - 1, 1);
  assert.equal(Lexer.lex(text).filter(token => token.type === "code").length, 0, "optional stop does not create a full copy widget");
  assert.match(text, /停止任务：`\/stop`/);
  const rendered = normalizeDingTalkCardContent(dingTalkLoadingBody(text));
  assert.ok(rendered.endsWith(ideEntryLink(url)));
  assert.equal(Lexer.lex(rendered).filter(token => token.type === "code").length, 0);
  assert.match(rendered, /停止任务：`\/stop`/);
}

test("running, waiting, recovering, unconfirmed and answer-preview cards share the bottom entry; terminal decoration stays independent", async t => {
  const f = fixture(t); await f.stream.progress("正在检查编译结果"); footer(f.starts[0].text, first);
  for (const activity of ["waiting-input", "waiting-approval", "running"] as const) {
    await f.stream.setActivity(activity); await f.stream.flush(); footer(f.frames.at(-1)!.text, first);
    assert.equal(f.frames.at(-1)!.activity, activity);
  }
  await f.stream.waitForRecovery("原生后端正在重试"); footer(f.frames.at(-1)!.text, first);
  await f.stream.waitForBackend("正在核对原任务状态"); footer(f.frames.at(-1)!.text, first);
  await f.stream.answer("正在生成最终说明"); await f.stream.flush(); footer(f.frames.at(-1)!.text, first);
  assert.doesNotMatch(JSON.stringify(f.stream.checkpoint()), /203\.0\.113|打开项目 Web IDE/, "generated links are not task/checkpoint facts");
  const result = withIDEEntry("完整结果", first); await f.stream.finalize(result);
  assert.equal(f.frames.at(-1)!.text.split("[打开项目 Web IDE]").length - 1, 1);
  assert.ok(f.frames.at(-1)!.text.endsWith(ideEntryLink(first))); assert.equal(f.frames.at(-1)!.finalize, true);
});

test("queued updates re-project the entry at actual send time; restart, removal, IP change and segment rotation never restore a stale footer", async t => {
  const f = fixture(t); await f.stream.progress("第一步正在执行");
  const original = f.stream.checkpoint().messageId;
  await f.stream.progress("下一步正在执行"); f.entry(second); await f.stream.flush();
  footer(f.frames.at(-1)!.text, second); assert.ok(!f.frames.at(-1)!.text.includes(first));
  await f.restart(); f.entry(); await f.stream.synchronize();
  assert.doesNotMatch(f.frames.at(-1)!.text, /打开项目 Web IDE|203\.0\.113/);
  assert.equal(f.frames.at(-1)!.messageId, original); assert.equal(f.starts.length, 1);
  f.entry(second); await f.stream.synchronize(); footer(f.frames.at(-1)!.text, second);
  await f.stream.startSegment({ id: "answer", kind: "answer" }); footer(f.starts.at(-1)!.text, second);
  assert.equal(f.starts.length, 2); assert.notEqual(f.stream.checkpoint().messageId, original);
});

test("a quiet card heartbeat refreshes only the visible footer; metadata failure does not replace the card or affect loading", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = fixture(t); await f.stream.progress("长任务仍在执行");
  f.entry(second); t.mock.timers.tick(30_000); await f.stream.flush();
  footer(f.frames.at(-1)!.text, second); assert.equal(f.starts.length, 1);
  f.entry("invalid-url"); await f.stream.synchronize();
  assert.doesNotMatch(f.frames.at(-1)!.text, /打开项目 Web IDE|invalid-url|203\.0\.113/);
  assert.equal(f.frames.at(-1)!.activity, "running"); assert.equal(f.starts.length, 1);
  assert.equal(f.stream.checkpoint().terminal, undefined);
});

for (const managed of [false, true]) test(`${managed ? "managed" : "followed"} hub projection uses the current subscription and retains the unique final footer`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-hub-progress-ide-"));
  let url: string | undefined = first;
  const starts: string[] = [], updates: string[] = [], finals: string[] = [];
  const sub: ThreadSubscription = { key: "exact-binding", hostId: "remote:project", threadId: "thread", recipientId: "group", managed,
    client: createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available", turnStatusHeader: "available", progressFooter: "available", resumableProgress: true }, {
      async sendText() { throw Error("no fallback"); },
      async startTextStream(input) { starts.push(input.text); return { messageId: "card" }; },
      async updateTextStream(input) { (input.finalize ? finals : updates).push(input.text); }
    }) };
  const hub = new ThreadEventHub({ filePath: path.join(root, "hub.json"), subscriptions: () => [sub], backend: () => ({} as never),
    decorateProgress: (current, text) => { assert.equal(current.key, sub.key); assert.equal(current.hostId, sub.hostId); return withIDEEntry(text, url, { atEnd: true }); },
    decorateFinal: (_sub, text) => withIDEEntry(text, first) });
  t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  let stream: ChannelTurnPresentation | undefined;
  if (managed) { stream = await hub.prepareManagedStream(sub); await hub.managedTurnStarted(sub, "turn"); await stream.progress("任务运行中"); }
  else { await hub.started(sub.hostId, sub.threadId, "turn", new Date().toISOString()); await hub.activity(sub.hostId, sub.threadId, "turn", "任务运行中"); }
  footer(starts[0], first);
  url = undefined;
  if (stream) { await stream.progress("继续检查修改"); await stream.flush(); }
  else {
    await hub.activity(sub.hostId, sub.threadId, "turn", "继续检查修改");
    for (let n = 0; n < 150 && !updates.length; n++) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(updates.length); assert.doesNotMatch(updates.at(-1)!, /打开项目 Web IDE/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "hub.json"), "utf8"), /203\.0\.113/);
  if (managed) await hub.managedCompletion(sub, "turn", "结果"); else await hub.completion(sub.hostId, sub.threadId, "turn", "结果");
  assert.ok(finals.at(-1)?.endsWith(ideEntryLink(first))); assert.equal(finals.at(-1)!.split("[打开项目 Web IDE]").length - 1, 1);
});

test("a progress footer stays outside an unfinished code preview and at the bottom even when prose references the same URL", () => {
  const text = `正在检查 ${first}\n\n\`\`\`text\n待完成的示例`;
  const rendered = withIDEEntry(text, first, { atEnd: true });
  const tokens = Lexer.lex(rendered);
  assert.ok(rendered.endsWith(ideEntryLink(first)));
  assert.equal(tokens.filter(token => token.type === "code")[0].text, "待完成的示例");
  assert.equal(tokens.at(-1)!.type, "paragraph");
  assert.equal(rendered.split("[打开项目 Web IDE]").length - 1, 1);
});

test("text-only progress does not gain repeated IDE links; its final answer keeps the existing footer", async () => {
  const texts: string[] = [];
  const client = createChannelClient("generic", TEXT_CAPABILITIES, {
    async sendText(input) { texts.push(input.text); return { messageId: "final" }; },
    async sendProgressText(input) { texts.push(input.text); return { messageId: "progress" }; }
  });
  const stream = new ChannelTurnPresentation(client, "chat", { save() {}, decorateProgress: text => withIDEEntry(text, first, { atEnd: true }) });
  try {
    await stream.progress("已完成编译，继续检查测试");
    await stream.finalize(withIDEEntry("最终结果", first));
    assert.ok(texts.length >= 2);
    assert.ok(texts.slice(0, -1).every(text => !text.includes(first)));
    assert.ok(texts.at(-1)!.endsWith(ideEntryLink(first)));
  } finally { await stream.suspend(); }
});

test("standalone Bridge progress uses the current managed session and the terminal path retains one footer", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-progress-ide-")), store = new RuntimeStateStore(resolveStatePaths(root));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = store.createProject("project", root), session = store.createSession("alice", root, "task", project.id);
  store.setStreamRepliesOverride("alice", true);
  const frames: string[] = [], final: string[] = [];
  let lookupSession: string | undefined;
  const service = new BridgeService({ config: { ...defaultConfig(root), streamReplies: true, allowedSenderIds: ["alice"] }, stateStore: store,
    channel: createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available", turnStatusHeader: "available", progressFooter: "available" }, {
      async sendText() { return { messageId: "text" }; },
      async startTextStream(input) { frames.push(input.text); return { messageId: "card" }; },
      async updateTextStream(input) { (input.finalize ? final : frames).push(input.text); }
    }),
    ideProgressEntry: current => { lookupSession = current.id; return current.projectId ? first : undefined; },
    ideEntry: () => first,
    runner: { async run(input: { onProgress?: (text: string) => Promise<void> }) { await input.onProgress?.("编译检查进行中"); return { text: "完成", raw: "", threadId: "thread" }; }, async stop() {} } as never });
  await service.handleMessage({ id: "request", senderId: "alice", text: "检查代码", raw: {} });
  assert.equal(lookupSession, session.id); assert.ok(frames.some(text => text.endsWith(ideEntryLink(first))));
  assert.ok(final.at(-1)?.endsWith(ideEntryLink(first)));
});
