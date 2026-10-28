import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "marked";
import { DingTalkHttpsAICardClient, DingTalkSdkAICardClient } from "../src/channels/dingtalk.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { ChannelTurnPresentation } from "../src/channels/turn-presentation.js";
import { withIDEEntry } from "../src/ide/completion.js";
import type { ChannelStreamCheckpoint } from "../src/channels/progress.js";

const first = "https://203.0.113.1/workspace/project", second = "https://203.0.113.2/workspace/project";

for (const mode of ["https", "sdk"] as const) test(`${mode}: real task projection gives stream, copy control and IDE footer separate ownership through restart/wait/final`, async t => {
  const calls: Array<{ kind: string; body: any }> = [];
  // A component-state model verifies region selection/ownership, not native
  // rendering. Only a real DingTalk client can verify its cursor and widgets.
  const values: Record<string, string> = {};
  const record = (kind: string, body: any) => {
    calls.push({ kind, body });
    if (body.cardData) Object.assign(values, body.cardData.cardParamMap);
    if (kind === "stream") values[body.key] = body.content;
  };
  const transport = mode === "https" ? new DingTalkHttpsAICardClient(async (url, init) => {
    const kind = String(url).endsWith("/streaming") ? "stream" : String(url).endsWith("/deliver") ? "deliver" : init?.method === "POST" ? "create" : "state";
    record(kind, JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ success: true, result: kind === "create" ? "instance" : kind === "deliver" ? [{ success: true }] : true }), { status: 200 });
  }, [0], async () => {}) : new DingTalkSdkAICardClient({
    async createCardWithOptions(body) { record("create", body); return { statusCode: 200, body: { success: true, result: "instance" } }; },
    async deliverCardWithOptions(body) { record("deliver", body); return { statusCode: 200, body: { success: true, result: [{ success: true }] } }; },
    async updateCardWithOptions(body) { record("state", body); return { statusCode: 200, body: { success: true, result: true } }; },
    async streamingUpdateWithOptions(body) { record("stream", body); return { statusCode: 200, body: { success: true, result: true } }; }
  } as never, [0], async () => {});
  const base = { accessToken: "fixture", contentKey: "msgContent", error: false };
  let url: string | undefined = first;
  const client = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available", turnStatusHeader: "available",
    progressFooter: "available", resumableProgress: true }, {
    async sendText() { throw Error("no replacement notification"); },
    async startTextStream(input) {
      await transport.create({ ...base, ...input, outTrackId: input.streamId!, cardTemplateId: "template", robotCode: "fixture", target: { type: "group", conversationId: "room" } });
      await transport.update({ ...base, ...input, outTrackId: input.streamId!, finalize: false });
      return { messageId: input.streamId! };
    },
    async updateTextStream(input) { await transport.update({ ...base, ...input, outTrackId: input.messageId, finalize: input.finalize ?? false }); }
  });
  const make = (restore?: ChannelStreamCheckpoint) => new ChannelTurnPresentation(client, "room", { restore, save() {},
    decorateProgress: text => withIDEEntry(text, url, { atEnd: true }) });
  let stream = make(); t.after(() => stream.suspend());
  const view = () => JSON.parse(values.sys_full_json_obj).order.map((key: string) => values[key]).join("\n\n");
  const running = (expected?: string) => {
    assert.equal(values.flowStatus, "2");
    assert.deepEqual(JSON.parse(values.sys_full_json_obj).order, ["msgContent", "staticMsgContent"]);
    assert.match(values.msgContent, /任务仍在执行$/);
    assert.deepEqual(Lexer.lex(values.msgContent).map(token => token.type), ["paragraph"], "rewrites never replace native block widgets");
    assert.doesNotMatch(values.msgContent, /(?:<br>\s*){2,}|\n/, "active snapshots have no empty display rows");
    assert.match(values.msgContent, /当前进展/);
    assert.match(values.msgContent, /正在检查选项定义/);
    assert.doesNotMatch(values.msgContent, /\/stop|打开项目 Web IDE|203\.0\.113/);
    assert.deepEqual(Lexer.lex(values.staticMsgContent).filter(token => token.type === "code").map(token => token.text), ["/stop"]);
    assert.equal(view().split("/stop").length - 1, 1);
    assert.equal(view().split("[打开项目 Web IDE]").length - 1, expected ? 1 : 0);
    if (expected) assert.ok(values.staticMsgContent.endsWith(`(${expected})`));
  };
  await stream.progress("正在检查选项定义"); running(first);
  // Reproduce the reported public-summary layout through the real projection
  // and both transports, not just a manually assembled Markdown string.
  await stream.progress("🤔 **Locating work item ID**\n\n**Setting up isolated worktree**");
  await stream.progress("🔎 正在执行命令：git status"); await stream.flush(); running(first);
  assert.match(values.msgContent, /Locating work item ID/);
  assert.match(values.msgContent, /Setting up isolated worktree/);
  assert.match(values.msgContent, /当前操作.*正在执行Git 操作/);
  await stream.progress("🤔 正在核对三类 property 规则"); await stream.flush();
  assert.match(values.msgContent, /\*\*公开摘要\*\*.*核对三类/);
  const id = stream.checkpoint().messageId;
  const states = calls.filter(call => call.kind === "state").length;
  // The screenshot's failing transition: partial table + unclosed inline code,
  // followed by a stop copy box and changing project link.
  for (const preview of ["新增 **SnapshotTableOptionsConfig**。\n\n| Option | 值 |\n|---|---|\n| `expiration",
    "新增 **SnapshotTableOptionsConfig**。\n\n| Option | 值 |\n|---|---|\n| `expiration_timestamp` | Timestamp |\n\n```java\nclass Config {"]) {
    await stream.answer(preview); await stream.flush(); running(first);
    assert.match(values.msgContent, /核对三类 property 规则/);
    assert.doesNotMatch(values.msgContent, /正在组织最终回复/);
    assert.equal(Lexer.lex(values.msgContent).filter(token => ["code", "table"].includes(token.type)).length, 0);
    assert.match(values.msgContent, /Option.*expiration/);
    assert.match(values.msgContent, /\*\*SnapshotTableOptionsConfig\*\*/);
    assert.doesNotMatch(values.msgContent, /表格将在最终答复中完整显示/);
  }
  assert.equal(calls.filter(call => call.kind === "state").length, states, "unchanged widgets are not rewritten by body/heartbeat frames");
  for (const activity of ["waiting-input", "waiting-approval", "unconfirmed"] as const) {
    await stream.setActivity(activity); await stream.flush();
    assert.equal(values.flowStatus, "3"); assert.deepEqual(JSON.parse(values.sys_full_json_obj).order, ["staticMsgContent"]);
    assert.equal(view().split("/stop").length - 1, 1);
    assert.equal(calls.at(-1)!.kind, "state", "waiting never finalizes the task stream");
  }
  await stream.setActivity("running"); await stream.flush(); running(first);
  url = second; await stream.synchronize(); running(second); assert.ok(!view().includes(first));
  const { statusHeader: _legacyHeader, ...saved } = stream.checkpoint(); await stream.suspend();
  stream = make({ ...saved, resultPageBytes: 6000, resultPresentation: "card" });
  url = undefined; await stream.synchronize(); running();
  assert.equal(stream.checkpoint().messageId, id); assert.equal(calls.filter(call => call.kind === "create").length, 1);
  assert.doesNotMatch(JSON.stringify(stream.checkpoint()), /203\.0\.113|progressLayout/);
  const final = withIDEEntry("| Option | 值 |\n|---|---|\n| `expiration_timestamp` | Timestamp |\n\n```java\nclass Config {}\n```", second);
  await stream.finalize(final);
  assert.equal(values.flowStatus, "3"); assert.match(view(), /expiration_timestamp/);
  assert.equal(Lexer.lex(view()).filter(token => token.type === "code")[0].text, "class Config {}");
  assert.equal(view().split("[打开项目 Web IDE]").length - 1, 1); assert.doesNotMatch(view(), /\/stop/);
  assert.equal(calls.filter(call => call.kind === "stream").at(-1)!.body.content, "回复已整理。");
  assert.ok(calls.filter(call => call.kind === "stream").every(call => !call.body.content.includes("/stop") && !call.body.content.includes("打开项目 Web IDE")));
  assert.equal(calls.filter(call => call.kind === "deliver").length, 1);
});
