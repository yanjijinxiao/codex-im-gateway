import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TEXT_CAPABILITIES, createChannelClient } from "../src/channels/client.js";
import { ChannelTurnTextStream, type ChannelStreamCheckpoint } from "../src/channels/progress.js";
import { ChannelTurnPresentation } from "../src/channels/turn-presentation.js";
import { completedCardForMentions } from "../src/channels/completion-mentions.js";
import { DingTalkChannelAdapter, DingTalkHttpsAICardClient } from "../src/channels/dingtalk.js";
import { DingTalkCardRouting } from "../src/channels/dingtalk-card-routing.js";
import { ThreadEventHub } from "../src/server/thread-event-hub.js";
import type { CodexThreadSnapshot } from "../src/codex/backend.js";
import { turnStatusHeading, type TurnActivity, type TurnOutcome } from "../src/channels/turn-status.js";

function fixture(t: test.TestContext, budget = 6000) {
  const starts: Array<{ text: string; streamId?: string }> = [];
  const updates: Array<{ text: string; messageId: string; finalize?: boolean; error?: boolean }> = [];
  const client = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true,
    turnStatusHeader: "available", resultPageBytes: budget }, {
    async sendText() { throw Error("must not use fallback"); },
    async startTextStream(input) { starts.push(input); return { messageId: input.streamId! }; },
    async updateTextStream(input) { updates.push(input); }
  });
  let stream = new ChannelTurnPresentation(client, "room", { save() {} });
  t.after(() => stream.suspend());
  return { client, starts, updates, get stream() { return stream; },
    async restart() { const restore = stream.checkpoint(); await stream.suspend();
      stream = new ChannelTurnPresentation(client, "room", { restore, save() {} }); }
  };
}

test("status remains first above concrete commentary/tools; body text never determines task success", async t => {
  const f = fixture(t);
  await f.stream.progress("已完成一个步骤，但原任务继续");
  assert.ok(f.starts[0].text.startsWith(turnStatusHeading("running")));
  await f.stream.progress("✅ 检查通过"); await f.stream.answer("已完成（尚未收到原生完成事件）"); await f.stream.flush();
  assert.ok(f.updates.at(-1)!.text.startsWith(turnStatusHeading("running")));
  assert.equal(f.updates.at(-1)!.finalize, undefined);
  for (const status of ["waiting-input", "waiting-approval", "unconfirmed", "recovering"] as TurnActivity[]) {
    await f.stream.setActivity(status); await f.stream.flush();
    assert.ok(f.updates.at(-1)!.text.startsWith(turnStatusHeading(status)));
    assert.equal(f.stream.checkpoint().finished, false);
  }
  await f.restart(); await f.stream.synchronize();
  assert.ok(f.updates.at(-1)!.text.startsWith(turnStatusHeading("recovering")));
  await f.stream.progress("新的原生进展"); await f.stream.flush();
  assert.ok(f.updates.at(-1)!.text.startsWith(turnStatusHeading("running")));
  await f.stream.finalize("真实最终结果");
  assert.ok(f.updates.at(-1)!.text.startsWith(turnStatusHeading("completed")));
  assert.equal(f.updates.at(-1)!.finalize, true);
  assert.equal(f.stream.checkpoint().terminal!.text, "真实最终结果");
});

test("a state observation alone creates no placeholder; final pages and @ merging preserve status and budget", async t => {
  const f = fixture(t, 1300);
  await f.stream.setActivity("waiting-input"); assert.equal(f.starts.length, 0);
  await f.stream.progress("开始"); await f.stream.finalize("中文结果\n".repeat(500));
  const pages = f.updates.filter(item => item.finalize);
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.text.startsWith(turnStatusHeading("completed")) && Buffer.byteLength(page.text) <= 1300));
  assert.equal(completedCardForMentions(f.stream.checkpoint()), undefined);
  const short = fixture(t); await short.stream.progress("检查通过"); await short.stream.fail("具体错误", "interrupted");
  const combined = completedCardForMentions(short.stream.checkpoint())!;
  assert.ok(combined.text.startsWith(turnStatusHeading("interrupted")));
  assert.ok(combined.summary.startsWith(turnStatusHeading("interrupted")));
});

test("segment finalization is not task completion, including restored old-summary retries", async t => {
  const f = fixture(t); await f.stream.progress("上一阶段");
  await f.stream.startSegment({ id: "accepted", kind: "steer" });
  await f.stream.flush();
  assert.ok(f.updates.some(item => item.finalize && item.text.startsWith(turnStatusHeading("continued"))));
  assert.equal(f.stream.checkpoint().finished, false);
  assert.ok(f.starts.at(-1)!.text.startsWith(turnStatusHeading("running")));
});

test("pre-upgrade terminal page plans remain byte-for-byte unchanged", async t => {
  const f = fixture(t);
  const restore: ChannelStreamCheckpoint = { startedAt: 1, progressEntries: [], thought: "", answerPreview: "", finished: false,
    messageId: "old", resultPageBytes: 6000, resultPresentation: "card", terminal: { text: "old result", error: false } };
  const stream = new ChannelTurnTextStream(f.client, "room", { restore, save() {} });
  t.after(() => stream.suspend()); await stream.finalize("old result");
  assert.equal(f.updates.at(-1)!.text, "old result");
});

for (const outcome of ["completed", "failed", "interrupted"] as TurnOutcome[]) test(`real owner snapshot projects ${outcome}, not generic completed`, async t => {
  const f = fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-turn-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "active", activeTurnId: "turn", activeFlags: [] },
    turns: [{ id: "turn", status: "inProgress", messages: [{ id: "progress", role: "assistant", kind: "progress", text: "原生进展" }] }] };
  const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), subscriptions: () => [{ key: "binding", hostId: "local",
    threadId: "thread", recipientId: "room", client: f.client, managed: false }], backend: () => ({ async readThreadSnapshot() { return structuredClone(snapshot); } }) });
  t.after(() => hub.stop());
  await hub.synchronize("binding");
  snapshot.state.activeFlags = ["waitingOnUserInput"]; await hub.synchronize("binding");
  assert.ok(f.updates.at(-1)!.text.startsWith(turnStatusHeading("waiting-input")));
  snapshot.state.activeFlags = ["waitingOnApproval"]; await hub.synchronize("binding");
  assert.ok(f.updates.at(-1)!.text.startsWith(turnStatusHeading("waiting-approval")));
  snapshot.state.activeFlags = []; snapshot.state.runtimeStatus = "idle"; snapshot.state.activeTurnId = undefined;
  snapshot.turns[0].status = outcome as "completed" | "failed" | "interrupted";
  snapshot.turns[0].messages = [{ id: "answer", role: "assistant", text: "真实结束内容" }];
  await hub.synchronize("binding");
  assert.ok(f.updates.at(-1)!.text.startsWith(turnStatusHeading(outcome)));
  assert.equal(f.updates.at(-1)!.finalize, true);
});

test("DingTalk production REST lifecycle retains native streaming while active and closes animation only with final frame", async t => {
  const calls: Array<{ url: string; body: any }> = [];
  const cardClient = new DingTalkHttpsAICardClient(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ success: true,
      result: init?.method === "POST" ? String(url).endsWith("/deliver") ? [{ success: true }] : "card-instance" : true }), { status: 200 });
  }, [0], async () => undefined);
  const routes = new DingTalkCardRouting("fake"); routes.remember("room", "2", "staff", "fake");
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", cardContentKey: "msgContent", savedAt: "", enabled: true }, {
    cardRouting: routes, streamClient: { async getAccessToken() { return "fake"; } } as never, cardClient });
  const stream = new ChannelTurnTextStream(adapter.client, "room"); t.after(() => stream.suspend());
  await stream.progress("正在执行真实步骤"); await stream.progress("最新公开进展"); await stream.flush();
  assert.ok(calls.filter(call => call.url.endsWith("/streaming")).every(call => call.body.isFinalize === false));
  assert.ok(calls.find(call => call.body.content)?.body.content.startsWith(turnStatusHeading("running")));
  await stream.fail("具体错误", "interrupted");
  const last = calls.filter(call => call.url.endsWith("/streaming")).at(-1)!;
  assert.equal(last.body.isFinalize, true); assert.equal(last.body.isError, false); // Keep supplied error body visible.
  assert.ok(last.body.content.startsWith(turnStatusHeading("interrupted")));
  assert.equal(calls.at(-1)!.body.cardData.cardParamMap.flowStatus, "3");
  assert.equal(new Set(calls.map(call => call.body.outTrackId)).size, 1);
});
