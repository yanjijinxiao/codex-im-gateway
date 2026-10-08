import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import { DWClient, type DWClientDownStream } from "dingtalk-stream";
import { DiagnosticDingTalkStreamClient } from "../src/channels/dingtalk-stream-diagnostics.js";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import type { ChannelConnectionStatus } from "../src/channels/types.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const secret = "DO-NOT-LOG-secret-token-ticket";
const account = {
  channel: "dingtalk" as const, accountId: "diagnostic-test", clientId: "test-client",
  clientSecret: secret, savedAt: "", enabled: true
};
type RecordEntry = Record<string, string | number | undefined>;

function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  t.mock.method(console, "info", () => {});
  t.mock.method(Math, "random", () => 0);
  const records: RecordEntry[] = [];
  const endpoint = t.mock.method(DWClient.prototype, "getEndpoint", async function (this: DWClient) { return this; });
  const handshake = t.mock.method(DWClient.prototype, "_connect", async function (this: DWClient) { this.connected = true; });
  const client = new DiagnosticDingTalkStreamClient(account.accountId, account, {
    log: (level, record) => records.push({ level, ...record })
  });
  t.after(() => client.disconnect());
  return { client, records, endpoint, handshake };
}

function systemFrame(topic: string): DWClientDownStream {
  return { type: "SYSTEM", headers: { topic }, data: secret } as DWClientDownStream;
}

test("Stream diagnostics record successful phases once, with duration and account/run identity", async (t) => {
  const { client, records, endpoint, handshake } = fixture(t);
  endpoint.mock.mockImplementation(async function (this: DWClient) {
    t.mock.timers.tick(12);
    return this;
  });
  handshake.mock.mockImplementation(async function (this: DWClient) {
    t.mock.timers.tick(18);
    this.connected = true;
  });
  await client.connect();
  assert.deepEqual(records.map((item) => item.event), ["connect_attempt", "endpoint_ready", "connected"]);
  assert.equal(records[1].phaseElapsedMs, 12);
  assert.equal(records[2].connectElapsedMs, 30);
  assert.equal(records[2].disconnectedMs, 30);
  assert.equal(records[2].attempt, 1);
  assert.equal(records[2].retryCount, 0);
  assert.ok(records.every((item) => item.accountId === account.accountId && item.runId === records[0].runId));
  assert.equal(client.connectionStatus().state, "connected");
  assert.equal(client.connectionStatus().state, "connected");
  assert.equal(records.length, 3);
});

for (const [code, status, category] of [
  ["ENOTFOUND", undefined, "dns"],
  ["ETIMEDOUT", undefined, "network_timeout"],
  ["ECONNRESET", undefined, "transport"],
  ["CERT_HAS_EXPIRED", undefined, "tls"],
  ["ERR_BAD_REQUEST", 401, "authentication_or_permission"],
  ["ERR_BAD_RESPONSE", 503, "http_rejected"],
  [secret, undefined, "unknown"]
] as const) {
  test(`Stream endpoint failure is visible despite SDK catch, with safe ${category} fields (${code === secret ? "unknown" : code})`, async (t) => {
    const { client, records, endpoint } = fixture(t);
    endpoint.mock.mockImplementation(async () => { throw Object.assign(new Error(secret), {
      code, stack: secret, config: { clientSecret: secret, url: `https://example.test/?ticket=${secret}` },
      response: { status, data: { access_token: secret }, headers: { authorization: secret } }
    }); });
    await client.connect(); // Real SDK catches the error and schedules its own retry.
    const failure = records.find((item) => item.event === "connect_failed")!;
    assert.equal(failure.phase, "endpoint");
    assert.equal(failure.category, category);
    assert.equal(failure.code, code === secret ? undefined : code);
    assert.equal(failure.httpStatus, status);
    assert.equal(client.connectionStatus().state, "reconnecting");
    const retry = records.find((item) => item.event === "retry_scheduled")!;
    assert.equal(retry.retryDelayMs, 2_000);
    assert.equal(retry.nextAttempt, 2);
    assert.ok(!JSON.stringify(records).includes(secret));
  });
}

test("Stream handshake rejection records the stage and HTTP status without endpoint/ticket", async (t) => {
  const { client, records, handshake } = fixture(t);
  handshake.mock.mockImplementation(async () => { throw new Error("Unexpected server response: 403"); });
  await client.connect();
  const failure = records.find((item) => item.event === "connect_failed")!;
  assert.equal(failure.phase, "handshake");
  assert.equal(failure.httpStatus, 403);
  assert.equal(failure.category, "authentication_or_permission");
});

test("real SDK retry timer re-enters diagnostic hooks and records recovery without a second retry loop", async (t) => {
  const { client, records, endpoint } = fixture(t);
  let calls = 0;
  endpoint.mock.mockImplementation(async function (this: DWClient) {
    if (++calls === 1) throw Object.assign(new Error(secret), { code: "ECONNRESET" });
    return this;
  });
  await client.connect();
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(calls, 2);
  assert.equal(client.connectionStatus().state, "connected");
  assert.deepEqual(records.filter((item) => item.event === "connect_attempt").map((item) => item.attempt), [1, 2]);
  const recovered = records.find((item) => item.event === "connected")!;
  assert.equal(recovered.disconnectedMs, 2_000);
  assert.equal(recovered.retryCount, 1);
  assert.ok(recovered.lastConnectedAt);
  client.disconnect();
  const count = records.length;
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(calls, 2);
  assert.equal(records.length, count);
});

for (const phase of ["endpoint", "handshake"] as const) {
  test(`pending ${phase} warns after 30 seconds, throttles warnings and doesn't fake a timeout/retry`, async (t) => {
    const { client, records, endpoint, handshake } = fixture(t);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    if (phase === "endpoint") endpoint.mock.mockImplementation(async function (this: DWClient) { await pending; return this; });
    else handshake.mock.mockImplementation(async () => { await pending; });
    const connecting = client.connect();
    await flush();
    assert.equal(client.connectionStatus().state, "connecting");
    t.mock.timers.tick(30_000);
    assert.equal(client.connectionStatus().state, "error");
    for (let i = 0; i < 10; i++) client.connectionStatus();
    assert.equal(records.filter((item) => item.event === "connection_stalled").length, 1);
    t.mock.timers.tick(59_999);
    client.connectionStatus();
    assert.equal(records.filter((item) => item.event === "connection_stalled").length, 1);
    t.mock.timers.tick(1);
    client.connectionStatus();
    const warnings = records.filter((item) => item.event === "connection_stalled");
    assert.equal(warnings.length, 2);
    assert.equal(warnings[1].phase, phase);
    assert.equal(warnings[1].phaseElapsedMs, 90_000);
    assert.equal(warnings[1].code, undefined, "waiting isn't evidence of a network timeout error");
    assert.equal(records.filter((item) => item.event === "connect_attempt").length, 1);
    client.disconnect();
    const stoppedCount = records.length;
    release();
    await connecting;
    assert.equal(client.connectionStatus().state, "stopped");
    assert.equal(records.length, stoppedCount, "late SDK completion cannot reopen diagnostics after stop");
  });
}

test("server disconnect without a scheduled retry is reported as disconnected, not reconnecting", async (t) => {
  const { client, records } = fixture(t);
  await client.connect();
  t.mock.timers.tick(100);
  client.onDownStream(JSON.stringify(systemFrame("disconnect")));
  const status = client.connectionStatus();
  assert.equal(status.state, "error");
  assert.match(status.detail!, /已断开.*未观察到重连安排/);
  const disconnected = records.find((item) => item.event === "server_disconnect")!;
  assert.ok(disconnected.lastConnectedAt);
  assert.ok(disconnected.lastFrameAt);
  assert.ok(!JSON.stringify(records).includes(secret));
  t.mock.timers.tick(60_000);
  client.connectionStatus();
  assert.equal(records.filter((item) => item.event === "connect_attempt").length, 1);
  assert.equal(records.filter((item) => item.event === "disconnected_without_retry").length, 2);
});

test("SDK debug config, URLs, frames and raw failure messages are never forwarded", async (t) => {
  const { client, records } = fixture(t);
  const info = t.mock.method(console, "info", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  client.debug = true; // Even accidental enabling must not expose native debug output.
  client.printDebug({ clientSecret: secret });
  client.printDebug(`Connecting to dingtalk websocket @ wss://example.test/?ticket=${secret}`);
  client.printDebug(`res.data {"access_token":"${secret}"}`);
  client.printDebug(`Connect failed: ${secret}`);
  client.printDebug(`unknown future SDK debug message ${secret}`);
  client.printDebug("Reconnecting in 2.0 seconds... (attempt 2)");
  assert.equal(records.length, 1);
  assert.equal(records[0].event, "retry_scheduled");
  assert.equal(info.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
  assert.ok(!JSON.stringify(records).includes(secret));
});

test("a retry that was scheduled but never starts becomes a stalled retry warning", async (t) => {
  const { client, records } = fixture(t);
  client.printDebug("Reconnecting in 2.0 seconds... (attempt 1)");
  assert.equal(client.connectionStatus().state, "reconnecting");
  t.mock.timers.tick(31_999);
  assert.equal(client.connectionStatus().state, "reconnecting");
  t.mock.timers.tick(1);
  assert.equal(client.connectionStatus().state, "error");
  assert.equal(records.at(-1)?.event, "connection_stalled");
  assert.equal(records.at(-1)?.phase, "retry_wait");
  assert.equal(records.filter((item) => item.event === "connect_attempt").length, 0);
});

test("concurrent connects are logged but do not start a competing SDK attempt", async (t) => {
  const { client, records, endpoint } = fixture(t);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  endpoint.mock.mockImplementation(async function (this: DWClient) { await pending; return this; });
  const connecting = client.connect();
  await client.connect();
  await client.connect();
  assert.equal(endpoint.mock.callCount(), 1);
  assert.equal(records.filter((item) => item.event === "connect_skipped_pending").length, 1);
  release();
  await connecting;
  assert.equal(client.connectionStatus().state, "connected");
});

test("a failed diagnostic sink never changes connection behavior", async (t) => {
  fixture(t);
  const client = new DiagnosticDingTalkStreamClient("broken-log", account, { log() { throw new Error("sink failed"); } });
  t.after(() => client.disconnect());
  await client.connect();
  assert.equal(client.connectionStatus().state, "connected");
  client.onSystem(systemFrame("disconnect"));
  assert.equal(client.connectionStatus().state, "error");
});

test("adapter polls diagnostics during initial connect and abort cleans up a stuck connect", async (t) => {
  const { client, records, endpoint } = fixture(t);
  let reject!: (error: Error) => void;
  endpoint.mock.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const controller = new AbortController();
  const statuses: ChannelConnectionStatus[] = [];
  const off = t.mock.method(client, "off");
  const adapter = new DingTalkChannelAdapter(account, { streamClient: client });
  const monitoring = adapter.monitor({
    signal: controller.signal, onMessage: async () => {}, onStatus: (status) => statuses.push(status)
  });
  t.mock.timers.tick(30_000);
  assert.equal(statuses.at(-1)?.state, "error");
  assert.match(statuses.at(-1)?.detail ?? "", /endpoint.*30 秒/);
  controller.abort();
  await monitoring;
  assert.equal(statuses.at(-1)?.state, "stopped");
  assert.equal(off.mock.callCount(), 1);
  const count = records.length;
  const statusCount = statuses.length;
  reject(new Error(secret));
  await flush();
  t.mock.timers.tick(120_000);
  assert.equal(records.length, count);
  assert.equal(statuses.length, statusCount);
  assert.equal(records.filter((item) => item.event === "monitor_stopped").length, 1);
});

test("real SDK WebSocket close and automatic reconnect produce safe lifecycle diagnostics", { timeout: 5_000 }, async (t) => {
  // Use the SDK's ws dependency and a loopback server, never a real DingTalk account.
  const require = createRequire(import.meta.url);
  const { WebSocketServer } = require(require.resolve("ws", { paths: [require.resolve("dingtalk-stream")] }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = server.address().port;
  const records: RecordEntry[] = [];
  const nativeLogs: string[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => nativeLogs.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => nativeLogs.push(args.map(String).join(" ")));
  t.mock.method(Math, "random", () => 0);
  t.mock.method(DWClient.prototype, "getEndpoint", async function (this: DWClient) {
    // SDK's endpoint API is replaced; its real WebSocket handlers and retry timer run.
    (this as unknown as { dw_url: string }).dw_url = `ws://127.0.0.1:${port}/?ticket=${secret}`;
    return this;
  });
  const client = new DiagnosticDingTalkStreamClient("loopback-test", { ...account, keepAlive: false }, {
    log: (level, record) => records.push({ level, ...record })
  });
  t.after(async () => {
    client.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await client.connect();
  assert.equal(client.connectionStatus().state, "connected");
  const secondConnection = once(server, "connection");
  for (const socket of server.clients) socket.terminate();
  await secondConnection;
  // Wait for the client open callback and connect promise, not just server upgrade.
  for (let i = 0; i < 50 && records.filter((item) => item.event === "connected").length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(records.filter((item) => item.event === "connected").length, 2);
  assert.ok(records.some((item) => item.event === "socket_closed"));
  assert.ok(records.some((item) => item.event === "retry_scheduled"));
  assert.equal(client.connectionStatus().state, "connected");
  assert.ok(!JSON.stringify({ records, nativeLogs }).includes(secret));
});
