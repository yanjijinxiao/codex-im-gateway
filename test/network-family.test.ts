import assert from "node:assert/strict";
import test from "node:test";

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
