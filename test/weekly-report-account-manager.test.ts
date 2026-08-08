import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChannelCapabilityProvider } from "../src/bridge/channel-capability.js";
import { AccountManager } from "../src/server/account-manager.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";

test("passes the live channel capability provider to every account Bridge", async (t) => {
  // Given
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-weekly-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  saveAccount(paths, {
    accountId: "account-one",
    userId: "user-one",
    token: "token-one",
    baseUrl: "https://example.test",
    cdnBaseUrl: "https://cdn.example.test",
    savedAt: new Date().toISOString(),
    enabled: true
  });
  const provider: ChannelCapabilityProvider = () => [];
  let capturedProvider: ChannelCapabilityProvider | undefined;
  const manager = new AccountManager({
    paths,
    configProvider: () => defaultConfig(root),
    channelCapabilities: provider,
    bridgeFactory: (input) => {
      capturedProvider = input.channelCapabilities;
      return { async handleMessage() {} } as never;
    },
    clientFactory: () => ({ accountId: "account-one" }) as never,
    monitor: async ({ signal }) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
    runnerFactory: () => ({
      async warmUp() {},
      close() {}
    }) as never
  });
  t.after(() => manager.stopAll());

  // When
  await manager.startAccount("account-one", false);

  // Then
  assert.equal(capturedProvider, provider);
});
