import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveStatePaths } from "../src/state/paths.js";
import { createQrLoginSession, loginWithQr, WeixinQrLoginSession } from "../src/weixin/login.js";

test("the QR-owned expiry wins even if the wall clock has not reached its millisecond deadline", async t => {
  t.mock.method(Date, "now", () => 1000);
  const expiry = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => ms === 15 ? expiry.signal : new AbortController().signal);
  const session = new WeixinQrLoginSession("synthetic", "synthetic", "https://example.test",
    async () => new Promise<Response>(() => {}), 1015);
  const outcome = session.poll().then(value => ({ value }), error => ({ error }));
  expiry.abort(new DOMException("fixture deadline", "TimeoutError"));
  assert.deepEqual(await outcome, { value: { status: "expired" } });
});

test("the request budget timeout does not expire a QR code with remaining lifetime", async t => {
  t.mock.method(Date, "now", () => 1000);
  const request = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => request.signal);
  const reason = new DOMException("fixture request budget", "TimeoutError");
  const session = new WeixinQrLoginSession("synthetic", "synthetic", "https://example.test",
    async () => new Promise<Response>(() => {}), 61000);
  const rejected = assert.rejects(session.poll(), error => error === reason);
  request.abort(reason);
  await rejected;
});

test("an upstream timeout before the QR-owned expiry remains a network error", async t => {
  t.mock.method(Date, "now", () => 1000);
  t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  const reason = new DOMException("fixture upstream failure", "TimeoutError");
  const session = new WeixinQrLoginSession("synthetic", "synthetic", "https://example.test", async () => { throw reason; }, 1015);
  await assert.rejects(session.poll(), error => error === reason);
});

async function withMutedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

test("login uses current iLink QR GET endpoints and stores the confirmed account", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-weixin-login-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const account = await withMutedConsole(() => loginWithQr({
    paths: resolveStatePaths(root),
    pollMs: 0,
    timeoutMs: 1000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("get_bot_qrcode")) {
        return new Response(JSON.stringify({
          qrcode: "qr-token",
          qrcode_img_content: "qr-content"
        }));
      }
      if (String(url).includes("get_qrcode_status")) {
        return new Response(JSON.stringify({
          status: "confirmed",
          bot_token: "bot-secret",
          ilink_bot_id: "account-1",
          ilink_user_id: "user-1",
          baseurl: "https://region.example"
        }));
      }
      throw new Error(`unexpected url: ${String(url)}`);
    }
  }));

  assert.equal(account.accountId, "account-1");
  assert.equal(account.botId, "account-1");
  assert.equal(account.baseUrl, "https://region.example");
  assert.equal(account.enabled, true);
  assert.equal(calls[0].url, "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url, "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr-token");
  assert.equal(calls[1].init.method, "GET");
  assert.equal((calls[1].init.headers as Record<string, string>)["iLink-App-ClientVersion"], "1");
});

test("reusable login session exposes scanned state before confirmation", async () => {
  let statusCalls = 0;
  const session = await createQrLoginSession({
    timeoutMs: 1000,
    fetch: async (url) => {
      if (String(url).includes("get_bot_qrcode")) {
        return new Response(JSON.stringify({ qrcode: "token", qrcode_img_content: "content" }));
      }
      statusCalls += 1;
      return new Response(JSON.stringify(statusCalls === 1
        ? { status: "scaned" }
        : { status: "confirmed", bot_token: "secret", ilink_bot_id: "bot" }));
    }
  });

  assert.equal((await session.poll()).status, "scanned");
  const confirmed = await session.poll();
  assert.equal(confirmed.status, "confirmed");
  if (confirmed.status === "confirmed") {
    assert.equal(confirmed.account.accountId, "bot");
  }
});

test("reusable login session expires without another network request", async () => {
  let calls = 0;
  const session = await createQrLoginSession({
    timeoutMs: -1,
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ qrcode: "token", qrcode_img_content: "content" }));
    }
  });

  assert.equal((await session.poll()).status, "expired");
  assert.equal(calls, 1);
});

test("login follows scaned_but_redirect host before confirmation", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-weixin-login-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const calls: Array<{ url: string; init: RequestInit }> = [];
  let statusCalls = 0;
  const account = await withMutedConsole(() => loginWithQr({
    paths: resolveStatePaths(root),
    pollMs: 0,
    timeoutMs: 1000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("get_bot_qrcode")) {
        return new Response(JSON.stringify({
          qrcode: "qr-token",
          qrcode_img_content: "qr-content"
        }));
      }
      if (String(url).includes("get_qrcode_status")) {
        statusCalls += 1;
        if (statusCalls === 1) {
          return new Response(JSON.stringify({
            status: "scaned_but_redirect",
            redirect_host: "redirect.example"
          }));
        }
        return new Response(JSON.stringify({
          status: "confirmed",
          bot_token: "bot-secret",
          ilink_bot_id: "account-1"
        }));
      }
      throw new Error(`unexpected url: ${String(url)}`);
    }
  }));

  assert.equal(account.baseUrl, "https://redirect.example");
  assert.equal(calls[2].url, "https://redirect.example/ilink/bot/get_qrcode_status?qrcode=qr-token");
});
