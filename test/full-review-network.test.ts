import assert from "node:assert/strict";
import test from "node:test";
import { PinnedNetworkLifecycleTransport } from "../src/channels/network-family.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeixinApiClient } from "../src/weixin/api.js";
import { createQrLoginSession } from "../src/weixin/login.js";
import { sendLocalMediaFile } from "../src/weixin/media.js";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

test("network deadlines include a stalled first request and do not retry writes", async () => {
  let release!: (value: Response) => void;
  let calls = 0;
  const transport = new PinnedNetworkLifecycleTransport("auto", async () => {
    calls++;
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const request = transport.request("turn", "https://example.test", { method: "POST", timeoutMs: 20 } as RequestInit);
  const outcome = await Promise.race([request.then(() => "accepted", () => "rejected"), new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100))]);
  release(new Response("late"));
  await request.catch(() => undefined);
  assert.equal(outcome, "rejected");
  assert.equal(calls, 1);
  assert.equal(transport.resolvedFamily("turn"), undefined);
});

test("waiting behind family negotiation has its own total deadline", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transport = new PinnedNetworkLifecycleTransport("auto", async () => { await gate; return new Response("ok"); });
  const first = transport.request("turn", "https://example.test");
  const second = transport.request("turn", "https://example.test", { timeoutMs: 20 } as RequestInit);
  const outcome = await Promise.race([second.then(() => "accepted", () => "rejected"), new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100))]);
  release();
  await Promise.allSettled([first, second]);
  assert.equal(outcome, "rejected");
});

test("unknown length responses stop reading when their byte budget is exceeded", async () => {
  let cancelled = false;
  const transport = new PinnedNetworkLifecycleTransport("ipv4", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; }
  })));
  const response = await transport.request("turn", "https://example.test", { maxResponseBytes: 12 } as RequestInit);
  const reader = response.body!.getReader();
  try {
    assert.equal((await reader.read()).value?.length, 8);
    await assert.rejects(reader.read(), /limit|large|budget/i);
    assert.equal(cancelled, true);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
});

test("deadline also cancels a response that stalled after headers", async () => {
  let cancelled = false;
  const transport = new PinnedNetworkLifecycleTransport("ipv4", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const response = await transport.request("turn", "https://example.test", { timeoutMs: 20 } as RequestInit);
  const outcome = await Promise.race([response.text().then(() => "accepted", () => "rejected"), new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100))]);
  assert.equal(outcome, "rejected");
  assert.equal(cancelled, true);
});

test("HTTP responses without a body remain valid", async () => {
  const transport = new PinnedNetworkLifecycleTransport("ipv4", async () => new Response(null, { status: 204 }));
  const response = await transport.request("turn", "https://example.test");
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("Weixin API stops oversized untrusted JSON before parsing it", async () => {
  const api = new WeixinApiClient({ baseUrl: "https://example.test", token: "synthetic", fetch: async () => new Response(JSON.stringify({ ret: 0, padding: "a".repeat(2 * 1024 * 1024) })) });
  await assert.rejects(api.getUpdates(), /byte limit/);
});

test("Weixin QR polling cannot confirm a login that expired during the request", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let release!: () => void;
  const session = await createQrLoginSession({ timeoutMs: 15, fetch: async url => String(url).includes("get_bot_qrcode")
    ? new Response(JSON.stringify({ qrcode: "synthetic", qrcode_url: "synthetic" }))
    : new Promise<Response>(resolve => { release = () => resolve(new Response(JSON.stringify({ status: "confirmed", bot_token: "synthetic", ilink_bot_id: "test" }))); }) });
  const pending = session.poll().then(value => ({ value }), error => ({ error }));
  now += 35; release();
  assert.deepEqual(await pending, { value: { status: "expired" } });
});

test("Weixin outbound file budget is checked before requesting an upload", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-media-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oversize.bin"); fs.writeFileSync(file, "123456789");
  let upload = false;
  await assert.rejects(sendLocalMediaFile({ filePath: file, maxBytes: 8, toUserId: "test",
    client: { async getUploadUrl() { upload = true; throw Error("unexpected upload"); } } as never } as Parameters<typeof sendLocalMediaFile>[0]), /limit|大|budget/);
  assert.equal(upload, false);
});

test("native HTTPS transport exposes headers before the whole download is buffered", async t => {
  const incoming = Object.assign(new PassThrough(), { rawHeaders: [], statusCode: 200, statusMessage: "OK" });
  t.mock.method(https, "request", (_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
    const request = Object.assign(new EventEmitter(), { write() {}, end() { queueMicrotask(() => { callback(incoming); incoming.write(Buffer.alloc(8)); }); } });
    return request as never;
  });
  const transport = new PinnedNetworkLifecycleTransport("ipv4");
  const pending = transport.request("native", "https://example.test");
  const outcome = await Promise.race([pending.then(() => "headers"), new Promise(resolve => setTimeout(() => resolve("buffered"), 100))]);
  incoming.end();
  const response = await pending;
  assert.equal(outcome, "headers");
  assert.equal((await response.arrayBuffer()).byteLength, 8);
});

test("native HTTPS body is destroyed when streamed bytes exceed the budget", async t => {
  const incoming = Object.assign(new PassThrough(), { rawHeaders: [], statusCode: 200, statusMessage: "OK" });
  t.mock.method(https, "request", (_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
    return Object.assign(new EventEmitter(), { write() {}, end() { queueMicrotask(() => { callback(incoming); incoming.write(Buffer.alloc(32)); }); } }) as never;
  });
  const response = await new PinnedNetworkLifecycleTransport("ipv4").request("native", "https://example.test", { maxResponseBytes: 16 });
  await assert.rejects(response.arrayBuffer(), /byte limit/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(incoming.destroyed, true);
});
