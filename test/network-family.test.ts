import assert from "node:assert/strict";
import test from "node:test";

test("concurrent first requests negotiate once and never overwrite the pinned family", async () => {
  const calls: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transport = new PinnedNetworkLifecycleTransport("auto", async (family) => {
    calls.push(family);
    if (calls.length === 1) { await gate; throw Object.assign(new Error("IPv4 unavailable"), { code: "ENETUNREACH" }); }
    return new Response("ok");
  });
  const first = transport.request("turn", "https://example.test");
  const second = transport.request("turn", "https://example.test");
  assert.deepEqual(calls, [4]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [4, 6, 6]);
  assert.equal(transport.resolvedFamily("turn"), 6);
});

test("a request waiting for network negotiation can be cancelled independently", async () => {
  let release!: () => void;
  const transport = new PinnedNetworkLifecycleTransport("auto", async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return new Response("ok");
  });
  const first = transport.request("turn", "https://example.test");
  const controller = new AbortController();
  const second = transport.request("turn", "https://example.test", { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, { name: "AbortError" });
  release(); await first;
});

import {
  PinnedNetworkLifecycleTransport,
  type ResolvedNetworkFamily
} from "../src/channels/network-family.js";

test("auto network policy pins the first accepted family for the whole lifecycle", async () => {
  const families: ResolvedNetworkFamily[] = [];
  const transport = new PinnedNetworkLifecycleTransport("auto", async (family) => {
    families.push(family);
    return new Response("ok", { status: 200 });
  });

  await transport.request("turn-1", "https://api.dingtalk.com/first");
  await transport.request("turn-1", "https://api.dingtalk.com/second");

  assert.deepEqual(families, [4, 4]);
  assert.equal(transport.resolvedFamily("turn-1"), 4);
});

test("auto network policy may change family only before the lifecycle is accepted", async () => {
  const families: ResolvedNetworkFamily[] = [];
  const transport = new PinnedNetworkLifecycleTransport("auto", async (family) => {
    families.push(family);
    if (family === 4) {
      return new Response(JSON.stringify({ code: "Forbidden.AccessDenied.IpNotInWhiteList" }), {
        status: 403
      });
    }
    return new Response("ok", { status: 200 });
  });

  await transport.request("turn-2", "https://api.dingtalk.com/first");
  await transport.request("turn-2", "https://api.dingtalk.com/second");

  assert.deepEqual(families, [4, 6, 6]);
  assert.equal(transport.resolvedFamily("turn-2"), 6);
});

test("an explicit IPv6 policy never falls back or changes family mid-lifecycle", async () => {
  const families: ResolvedNetworkFamily[] = [];
  const transport = new PinnedNetworkLifecycleTransport("ipv6", async (family) => {
    families.push(family);
    return new Response("ok", { status: 200 });
  });

  await transport.request("turn-3", "https://api.dingtalk.com/first");
  await transport.request("turn-3", "https://api.dingtalk.com/second");

  assert.deepEqual(families, [6, 6]);
  assert.equal(transport.resolvedFamily("turn-3"), 6);
});
