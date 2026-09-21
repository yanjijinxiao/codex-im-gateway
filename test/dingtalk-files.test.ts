import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import { DingTalkFileClient } from "../src/channels/dingtalk-files.js";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import { PinnedNetworkLifecycleTransport, type FamilyBoundFetch } from "../src/channels/network-family.js";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import type { ChannelMessage } from "../src/channels/message.js";

const token = "fake-access-token-never-log";
const uploaded = { errcode: 0, media_id: "media-test" };
const delivered = { processQueryKey: "query-test" };
const sessionSecret = "fake-session-secret-never-log";
const sessionTarget = () => ({
  type: "session" as const,
  webhookUrl: `https://oapi.dingtalk.com/robot/sendBySession?session=${sessionSecret}`,
  expiresAt: 10_000,
  proactiveTarget: { type: "user" as const, staffId: "staff-test" }
});
const json = (body: unknown, status = 200) => Response.json(body, { status });
const sendInput = (filePath: string) => ({
  path: filePath, robotCode: "robot-test", target: { type: "user" as const, staffId: "staff-test" },
  lifecycleId: "turn-test", getAccessToken: async () => token
});

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-dingtalk-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '根证书 NAS "test".crt');
  const bytes = Buffer.from("synthetic test certificate payload\n", "utf8");
  fs.writeFileSync(file, bytes);
  return { root, file, bytes };
}

function transportFixture(handler?: FamilyBoundFetch) {
  const calls: Array<{ family: number; url: URL; init: RequestInit }> = [];
  const transport = new PinnedNetworkLifecycleTransport("ipv4", async (family, url, init) => {
    calls.push({ family, url: new URL(url), init: init! });
    return handler ? handler(family, url, init) : json(new URL(url).pathname === "/media/upload" ? uploaded
      : new URL(url).pathname === "/robot/sendBySession" ? { errcode: 0, ...delivered } : delivered);
  });
  return { transport, calls };
}

test("session file replies do not call batchSend even when proactive OTO is prohibited", async (t) => {
  const { file } = fixture(t);
  const { transport, calls } = transportFixture(async (_family, url) => {
    if (new URL(url).pathname === "/media/upload") return json(uploaded);
    if (new URL(url).pathname === "/robot/sendBySession") return json({ errcode: 0, errmsg: "ok" });
    return json({ code: "chatbotId.notAllow.sendOTO" }, 400);
  });
  const client = new DingTalkFileClient(transport, 1024, 1000, () => 1);
  const receipt = await client.send({ ...sendInput(file), target: sessionTarget() });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, "/robot/sendBySession");
  assert.equal(calls[1].url.searchParams.get("session"), sessionSecret);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    msgtype: "file", file: { mediaId: "media-test", fileName: path.basename(file), fileType: "crt" }
  });
  assert.equal(new Headers(calls[1].init.headers).get("x-acs-dingtalk-access-token"), token);
  assert.match(receipt.messageId, /^dingtalk-file-receipt:[a-f0-9]{64}$/);
  assert(!receipt.messageId.includes(sessionSecret));
  assert.equal(transport.resolvedFamily("turn-test"), 4);
});

test("session replies retain a provider receipt when one is returned", async (t) => {
  const { file } = fixture(t);
  const { transport } = transportFixture();
  assert.deepEqual(await new DingTalkFileClient(transport, 1024, 1000, () => 1).send({
    ...sendInput(file), target: sessionTarget()
  }), { messageId: "query-test" });
});

for (const body of [{}, delivered, { errcode: 500 }, { errcode: sessionSecret }, { errcode: 0, success: false }]) {
  test(`session reply requires explicit success and never falls back after a response: ${JSON.stringify(body)}`, async (t) => {
    const { file } = fixture(t);
    const { transport, calls } = transportFixture(async (_family, url) =>
      json(new URL(url).pathname === "/media/upload" ? uploaded : body));
    await assert.rejects(new DingTalkFileClient(transport, 1024, 1000, () => 1).send({
      ...sendInput(file), target: sessionTarget()
    }), (error: Error) => {
      assert.match(error.message, /会话回复/);
      assert(!String(error.stack).includes(sessionSecret));
      assert(!String(error.stack).includes(token));
      return true;
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.pathname, "/robot/sendBySession");
  });
}

test("an uncertain session file reply cannot trigger proactive redelivery or leak its URL", async (t) => {
  const { file } = fixture(t);
  const { transport, calls } = transportFixture(async (_family, url) => {
    if (new URL(url).pathname === "/media/upload") return json(uploaded);
    throw new Error(`request failed ${url} ${token}`);
  });
  await assert.rejects(new DingTalkFileClient(transport, 1024, 1000, () => 1).send({
    ...sendInput(file), target: sessionTarget()
  }), (error: Error) => {
    assert.match(error.message, /会话回复网络异常.*未自动重发/);
    assert(!String(error.stack).includes(sessionSecret));
    assert(!String(error.stack).includes(token));
    return true;
  });
  assert.equal(calls.length, 2);
});

for (const webhookUrl of [
  `http://oapi.dingtalk.com/robot/sendBySession?session=${sessionSecret}`,
  `https://oapi.dingtalk.com.evil.test/robot/sendBySession?session=${sessionSecret}`,
  `https://oapi.dingtalk.com@evil.test/robot/sendBySession?session=${sessionSecret}`,
  `https://user:password@oapi.dingtalk.com/robot/sendBySession?session=${sessionSecret}`,
  `https://oapi.dingtalk.com:8443/robot/sendBySession?session=${sessionSecret}`,
  `https://oapi.dingtalk.com/robot/send?session=${sessionSecret}`,
  "https://oapi.dingtalk.com/robot/sendBySession",
  "not a URL"
]) {
  test(`reject unsafe session file destination before upload (${new URL(webhookUrl, "https://invalid.test").hostname})`, async (t) => {
    const { file } = fixture(t);
    const { transport, calls } = transportFixture();
    await assert.rejects(new DingTalkFileClient(transport, 1024, 1000, () => 1).send({
      ...sendInput(file), target: { ...sessionTarget(), webhookUrl }
    }), /会话回复地址无效/);
    assert.equal(calls.length, 0);
  });
}

for (const expiredDuringUpload of [false, true]) {
  test(`expired session selects proactive delivery ${expiredDuringUpload ? "after" : "before"} upload, without re-uploading`, async (t) => {
    const { file } = fixture(t);
    let now = expiredDuringUpload ? 1 : 10_000;
    const { transport, calls } = transportFixture(async (_family, url) => {
      now = 10_000;
      return json(new URL(url).pathname === "/media/upload" ? uploaded : delivered);
    });
    await new DingTalkFileClient(transport, 1024, 1000, () => now).send({ ...sendInput(file), target: sessionTarget() });
    assert.deepEqual(calls.map(call => call.url.pathname), ["/media/upload", "/v1.0/robot/oToMessages/batchSend"]);
  });
}

test("expired session without staff ID fails before uploading instead of guessing a private target", async (t) => {
  const { file } = fixture(t);
  const { transport, calls } = transportFixture();
  await assert.rejects(new DingTalkFileClient(transport, 1024, 1000, () => 10_000).send({
    ...sendInput(file), target: { ...sessionTarget(), proactiveTarget: undefined }
  }), /会话回复已过期/);
  assert.equal(calls.length, 0);
});

test("proactive OTO denial explains the robot capability, not file-type or size", async (t) => {
  const { file } = fixture(t);
  const { transport, calls } = transportFixture(async (_family, url) => new URL(url).pathname === "/media/upload"
    ? json(uploaded) : json({ code: "chatbotId.notAllow.sendOTO", message: token }, 400));
  await assert.rejects(new DingTalkFileClient(transport).send(sendInput(file)), (error: Error) => {
    assert.match(error.message, /主动私聊.*chatbotId.notAllow.sendOTO/);
    assert.match(error.message, /重新向机器人发一条消息/);
    assert(!error.message.includes("文件类型/大小限制"));
    assert(!error.message.includes(token));
    return true;
  });
  assert.equal(calls.length, 2);
});

for (const type of ["user", "group"] as const) {
  test(`DingTalk sends original CRT bytes and Unicode filename via ${type} file API`, async (t) => {
    const { file, bytes } = fixture(t);
    const { transport, calls } = transportFixture();
    const client = new DingTalkFileClient(transport);
    const receipt = await client.send({ ...sendInput(file), target: type === "user"
      ? { type, staffId: "staff-test" } : { type, conversationId: "cid-group" } });
    assert.deepEqual(receipt, { messageId: "query-test" });
    assert.equal(calls.length, 2);
    const upload = calls[0];
    assert.equal(upload.url.origin, "https://oapi.dingtalk.com");
    assert.equal(upload.url.pathname, "/media/upload");
    assert.equal(upload.url.searchParams.get("access_token"), token);
    assert.equal(upload.url.searchParams.get("type"), "file");
    assert.equal(upload.init.method, "POST");
    assert(upload.init.body instanceof Uint8Array);
    assert.equal(new Headers(upload.init.headers).get("Content-Length"), String(upload.init.body.byteLength));
    assert(upload.init.signal instanceof AbortSignal);
    const form = await new Request(upload.url, upload.init).formData();
    const media = form.get("media") as File;
    // Multipart decoders differ across supported Node versions on decoding %22.
    assert.equal(media.name.replaceAll("%22", '"'), path.basename(file));
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), bytes);
    assert.equal(calls[1].url.pathname, type === "user"
      ? "/v1.0/robot/oToMessages/batchSend" : "/v1.0/robot/groupMessages/send");
    assert.equal(new Headers(calls[1].init.headers).get("x-acs-dingtalk-access-token"), token);
    assert.equal(calls[1].url.search, "");
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
      robotCode: "robot-test", msgKey: "sampleFile",
      msgParam: JSON.stringify({ mediaId: "media-test", fileName: path.basename(file), fileType: "crt" }),
      ...(type === "user" ? { userIds: ["staff-test"] } : { openConversationId: "cid-group" })
    });
    assert.deepEqual(calls.map(c => c.family), [4, 4]);
    assert.equal(transport.resolvedFamily("turn-test"), 4, "client must not close a caller-owned turn");
  });
}

for (const invalid of ["relative", "missing", "directory", "empty", "oversize", "bad-limit"] as const) {
  test(`DingTalk rejects ${invalid} files before token retrieval or upload`, async (t) => {
    const { file, root } = fixture(t);
    const { calls, transport } = transportFixture();
    let inputPath = file;
    if (invalid === "relative") inputPath = "test.crt";
    if (invalid === "missing") inputPath = path.join(root, "missing.crt");
    if (invalid === "directory") inputPath = root;
    if (invalid === "empty") fs.truncateSync(file, 0);
    let tokens = 0;
    const client = new DingTalkFileClient(transport, invalid === "bad-limit" ? NaN : invalid === "oversize" ? 1 : 100);
    await assert.rejects(client.send({ ...sendInput(inputPath), getAccessToken: async () => { tokens++; return token; } }), /钉钉/);
    assert.equal(calls.length, 0);
    assert.equal(tokens, 0);
  });
}

test("DingTalk bounds uploads exactly at the configured byte limit", async (t) => {
  const { file, bytes } = fixture(t);
  const { transport, calls } = transportFixture();
  await new DingTalkFileClient(transport, bytes.length).send(sendInput(file));
  assert.equal(calls.length, 2);
});

for (const [name, response, expected] of [
  ["upload business failure", () => json({ errcode: 40005, errmsg: token }), /上传失败.*40005/],
  ["upload missing media", () => json({ errcode: 0 }), /media_id/],
  ["upload missing success marker", () => json({ media_id: "media" }), /media_id/],
  ["upload blank media", () => json({ errcode: 0, media_id: " " }), /media_id/],
  ["upload HTTP denial", () => json({ code: "Forbidden.AccessDenied", message: token }, 403), /上传失败.*403/],
  ["upload invalid response", () => new Response(token, { status: 502 }), /无效响应.*502/],
  ["upload null response", () => json(null), /无效响应/],
  ["upload unsafe error code", () => json({ errcode: token, errmsg: token }), /上传失败/],
  ["upload success false", () => json({ ...uploaded, success: false }), /上传失败/]
] as const) {
  test(`DingTalk ${name} is not reported as delivery and does not leak response secrets`, async (t) => {
    const { file } = fixture(t);
    const { transport, calls } = transportFixture(async () => response());
    await assert.rejects(new DingTalkFileClient(transport).send(sendInput(file)), (error: Error) => {
      assert.match(error.message, expected);
      assert(!String(error.stack).includes(token));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls.length, 1, "never send after failed upload");
  });
}

for (const [name, response, expected] of [
  ["missing receipt", () => json({}), /未返回有效回执/],
  ["blank receipt", () => json({ processQueryKey: " " }), /未返回有效回执/],
  ["invalid user", () => json({ ...delivered, invalidStaffIdList: ["staff-test"] }), /员工 ID 无效/],
  ["filtered user", () => json({ ...delivered, filteredStaffIdList: ["staff-test"] }), /可见范围/],
  ["rate-limited user", () => json({ ...delivered, flowControlledStaffIdList: ["staff-test"] }), /限流/],
  ["API denial", () => json({ code: "Forbidden.AccessDenied", message: token }, 403), /发送失败.*403/],
  ["HTTP 200 business failure", () => json({ code: "InvalidParameter.FileType", message: token }), /发送失败.*FileType/],
  ["business failure with receipt", () => json({ ...delivered, errcode: 500 }), /发送失败.*500/],
  ["malformed response", () => new Response(token), /无效响应/]
] as const) {
  test(`DingTalk ${name} does not invent success or retry the message`, async (t) => {
    const { file } = fixture(t);
    const { transport, calls } = transportFixture(async (_family, url) => new URL(url).pathname === "/media/upload" ? json(uploaded) : response());
    await assert.rejects(new DingTalkFileClient(transport).send(sendInput(file)), (error: Error) => {
      assert.match(error.message, expected);
      assert(!String(error.stack).includes(token));
      return true;
    });
    assert.equal(calls.length, 2);
  });
}

for (const phase of ["token", "upload", "send"] as const) {
  test(`DingTalk sanitizes ${phase} exceptions without retrying uncertain sends`, async (t) => {
    const { file } = fixture(t);
    const { transport, calls } = transportFixture(async (_family, url) => {
      if (phase === "upload" || new URL(url).pathname !== "/media/upload") throw new Error(`request access_token=${token}`);
      return json(uploaded);
    });
    await assert.rejects(new DingTalkFileClient(transport).send({ ...sendInput(file), getAccessToken: async () => {
      if (phase === "token") throw new Error(token);
      return token;
    } }), (error: Error) => {
      assert(!String(error.stack).includes(token));
      assert.equal(error.cause, undefined);
      assert.match(error.message, phase === "token" ? /令牌获取失败/ : /未自动重发/);
      return true;
    });
    assert.equal(calls.length, phase === "token" ? 0 : phase === "upload" ? 1 : 2);
  });
}

test("file upload and send inherit the turn's already selected IPv6, with no mid-turn IPv4 fallback", async (t) => {
  const { file } = fixture(t);
  const families: number[] = [];
  const transport = new PinnedNetworkLifecycleTransport("auto", async (family, url) => {
    families.push(family);
    if (family === 4) throw Object.assign(new Error("no IPv4"), { code: "ENETUNREACH" });
    return json(new URL(url).pathname === "/media/upload" ? uploaded : delivered);
  });
  await transport.request("turn-test", "https://api.dingtalk.com/initial");
  await new DingTalkFileClient(transport).send(sendInput(file));
  assert.deepEqual(families, [4, 6, 6, 6]);
});

test("a timed-out upload is bounded and cannot proceed to message delivery", async (t) => {
  const { file } = fixture(t);
  const { transport, calls } = transportFixture(async (_family, _url, init) => new Promise<Response>((resolve, reject) => {
    // Keep the test alive; AbortSignal.timeout itself is unref'd in Node.
    const watchdog = setTimeout(() => resolve(json(uploaded)), 200);
    init!.signal!.addEventListener("abort", () => { clearTimeout(watchdog); reject(init!.signal!.reason); }, { once: true });
  }));
  await assert.rejects(new DingTalkFileClient(transport, 1024, 10).send(sendInput(file)), /上传网络异常或超时/);
  assert.equal(calls.length, 1);
});

function adapterFixture(transport: PinnedNetworkLifecycleTransport, cardTemplateId?: string) {
  let listener!: (frame: DWClientDownStream) => void;
  const texts: string[] = [];
  const streamClient = {
    registerCallbackListener(_topic: string, callback: typeof listener) { listener = callback; },
    async connect() {}, disconnect() {}, off() {}, socketCallBackResponse() {},
    async getAccessToken() { return token; }
  };
  const adapter = new DingTalkChannelAdapter({
    channel: "dingtalk", accountId: "test-dingtalk", clientId: "robot-test", clientSecret: "fake-secret",
    createdAt: new Date().toISOString(), ...(cardTemplateId ? { cardTemplateId } : {})
  }, {
    streamClient, apiTransport: transport,
    emotionClient: { async reply() {}, async recall() {} },
    webhookSender: async ({ text }) => { texts.push(text); return { messageId: "text-test" }; },
    cardClient: { async create({ text }) { texts.push(text); }, async update() {} }
  });
  const dispatch = (overrides: Record<string, unknown> = {}) => listener({
    specVersion: "1.0", type: "CALLBACK",
    headers: { appId: "robot-test", connectionId: "connection", contentType: "application/json", messageId: "frame-test", time: "0", topic: TOPIC_ROBOT },
    data: JSON.stringify({
      senderStaffId: "staff-test", senderId: "encrypted-not-a-staff-id", conversationId: "cid-private-test",
      conversationType: "1", msgId: "turn-test", robotCode: "robot-test",
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=fake",
      sessionWebhookExpiredTime: 1_900_000_000_000, msgtype: "text", text: { content: "请发送文件" }, ...overrides
    })
  } as DWClientDownStream);
  return { adapter, dispatch, texts };
}

async function withMessage(
  fixture: ReturnType<typeof adapterFixture>, onMessage: (message: ChannelMessage) => Promise<void>,
  overrides: Record<string, unknown> = {}
) {
  const controller = new AbortController();
  const done = Promise.withResolvers<void>();
  const monitoring = fixture.adapter.monitor({ signal: controller.signal,
    onMessage: async (message) => { try { await onMessage(message); done.resolve(); } catch (error) { done.reject(error); } }
  });
  try { fixture.dispatch(overrides); await done.promise; }
  finally {
    controller.abort(); await monitoring;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test("DingTalk advertises only outbound file, and requires an established recipient", async (t) => {
  const { file } = fixture(t);
  const { transport, calls } = transportFixture();
  const { adapter } = adapterFixture(transport);
  assert.deepEqual(adapter.client.capabilities.outbound, {
    image: "not-implemented", file: "available", audio: "not-implemented", video: "not-implemented"
  });
  await assert.rejects(adapter.client.sendMedia({ toUserId: "cid-unknown", path: file, kind: "file" }), /会话未知/);
  await assert.rejects(async () => adapter.client.sendMedia({ toUserId: "cid-unknown", path: file, kind: "video" }), /outbound.video/);
  assert.equal(calls.length, 0);
});

test("file routing uses established private staff ID even when the conversation has a cid prefix and webhook expired", async (t) => {
  const { file } = fixture(t);
  const { transport, calls } = transportFixture();
  const fx = adapterFixture(transport);
  await withMessage(fx, async (message) => {
    await transport.request("turn-test", "https://api.dingtalk.com/initial");
    await fx.adapter.client.sendMedia({ toUserId: message.replyTargetId!, path: file, kind: "file" });
    assert.equal(transport.resolvedFamily("turn-test"), 4, "leave turn's lifecycle open until onMessage completes");
  }, { sessionWebhookExpiredTime: 1 });
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)).userIds, ["staff-test"]);
  assert.equal(transport.resolvedFamily("turn-test"), undefined);
});

test("a valid private session reply does not require or guess a staff ID", async (t) => {
  const { file } = fixture(t);
  const { transport, calls } = transportFixture();
  const fx = adapterFixture(transport);
  await withMessage(fx, async message => {
    await fx.adapter.client.sendMedia({ toUserId: message.replyTargetId!, path: file, kind: "file" });
  }, { senderStaffId: "" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, "/robot/sendBySession");
  assert.equal(JSON.parse(String(calls[1].init.body)).userIds, undefined);
});

for (const overrides of [{ senderStaffId: "", sessionWebhookExpiredTime: 1 }, { conversationType: "unknown" }]) {
  test(`file routing rejects ambiguous private target ${JSON.stringify(overrides)}`, async (t) => {
    const { file } = fixture(t);
    const { transport, calls } = transportFixture();
    const fx = adapterFixture(transport);
    await withMessage(fx, async (message) => {
      await assert.rejects(fx.adapter.client.sendMedia({ toUserId: message.replyTargetId!, path: file, kind: "file" }), /员工 ID|已过期/);
    }, overrides);
    assert.equal(calls.length, 0);
  });
}

test("standalone file sends release their own lifecycle on success and failure", async (t) => {
  const { file } = fixture(t);
  const { transport } = transportFixture();
  const closed: string[] = [];
  const close = transport.close.bind(transport);
  transport.close = id => { closed.push(id); close(id); };
  const fx = adapterFixture(transport);
  await withMessage(fx, async () => {});
  closed.length = 0;
  await fx.adapter.client.sendMedia({ toUserId: "cid-private-test", path: file, kind: "file" });
  await assert.rejects(fx.adapter.client.sendMedia({ toUserId: "cid-private-test", path: `${file}.missing`, kind: "file" }));
  assert.equal(closed.length, 2);
  assert(closed.every(id => id.startsWith("dingtalk-file-")));
  assert.notEqual(closed[0], closed[1]);
  assert(closed.every(id => transport.resolvedFamily(id) === undefined));
});

test("a newer inbound message cannot replace an in-flight file's reply context or network lifecycle", async (t) => {
  const { file } = fixture(t);
  const { transport } = transportFixture();
  const ids: string[] = [];
  const request = transport.request.bind(transport);
  transport.request = (id, url, init) => { ids.push(id); return request(id, url, init); };
  const fx = adapterFixture(transport);
  const controller = new AbortController();
  const firstEntered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const firstFinished = Promise.withResolvers<void>();
  const secondFinished = Promise.withResolvers<void>();
  const monitoring = fx.adapter.monitor({ signal: controller.signal, onMessage: async message => {
    try {
      if (message.id === "first-turn") {
        firstEntered.resolve(); await secondEntered.promise;
        await fx.adapter.client.sendMedia({ toUserId: message.replyTargetId!, path: file, kind: "file" });
        firstFinished.resolve();
      } else {
        secondEntered.resolve(); await firstFinished.promise;
        await fx.adapter.client.sendMedia({ toUserId: message.replyTargetId!, path: file, kind: "file" });
        secondFinished.resolve();
      }
    } catch (error) { firstFinished.reject(error); secondFinished.reject(error); }
  } });
  try {
    fx.dispatch({ msgId: "first-turn" }); await firstEntered.promise;
    fx.dispatch({ msgId: "second-turn" });
    await Promise.all([firstFinished.promise, secondFinished.promise]);
    assert.deepEqual(ids, ["first-turn", "first-turn", "second-turn", "second-turn"]);
  } finally { controller.abort(); await monitoring; }
});

for (const cardTemplateId of [undefined, "test-template.schema"]) {
  test(`Gateway action block reaches DingTalk file delivery ${cardTemplateId ? "with" : "without"} AI Card`, async (t) => {
    const { root, file } = fixture(t);
    const { transport, calls } = transportFixture();
    const fx = adapterFixture(transport, cardTemplateId);
    const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
    store.createProject("Files", root);
    const outbound: Array<{ id: string; attachments?: unknown[] }> = [];
    const service = new BridgeService({
      channel: fx.adapter.client, stateStore: store,
      config: { ...defaultConfig(root), allowedSenderIds: ["staff-test"], streamReplies: Boolean(cardTemplateId) },
      onOutboundMessage: message => outbound.push(message),
      runner: {
        async listProjects() { return { backend: "app-server", projects: [] }; },
        async listThreads() { return []; },
        async run() { return { raw: "", threadId: "thread-test", text: "文件已准备好。\n\n```codex-channel-bridge-actions\n"
          + JSON.stringify({ send: [{ type: "file", path: file }] }) + "\n```" }; },
        async stop() {}
      } as never
    });
    await withMessage(fx, message => service.handleMessage(message), { conversationType: "2", conversationId: "cid-group" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.pathname, "/robot/sendBySession");
    assert.equal(calls[1].url.searchParams.get("session"), "fake");
    assert.equal(JSON.parse(String(calls[1].init.body)).msgtype, "file");
    assert(outbound.some(message => message.id === "query-test" && message.attachments?.length === 1));
    assert(!fx.texts.some(text => /暂不支持|codex-channel-bridge-actions|Failed to send/.test(text)));
  });
}

test("Gateway reports failed DingTalk file delivery without logging an outbound attachment", async (t) => {
  const { root, file } = fixture(t);
  const { transport, calls } = transportFixture(async () => json({ errcode: 40005, errmsg: token }));
  const fx = adapterFixture(transport);
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  store.createProject("Files", root);
  const attachments: unknown[] = [];
  const service = new BridgeService({
    channel: fx.adapter.client, stateStore: store,
    config: { ...defaultConfig(root), allowedSenderIds: ["staff-test"], streamReplies: false },
    onOutboundMessage: message => { attachments.push(...(message.attachments ?? [])); },
    runner: {
      async listProjects() { return { backend: "app-server", projects: [] }; },
      async listThreads() { return []; },
      async run() { return { raw: "", threadId: "thread-test", text: "```codex-channel-bridge-actions\n"
        + JSON.stringify({ send: [{ type: "file", path: file }] }) + "\n```" }; },
      async stop() {}
    } as never
  });
  await withMessage(fx, message => service.handleMessage(message));
  assert.equal(calls.length, 1);
  assert.equal(attachments.length, 0);
  assert(fx.texts.some(text => /上传失败.*40005/.test(text)));
  assert(fx.texts.every(text => !text.includes(token)));
});
