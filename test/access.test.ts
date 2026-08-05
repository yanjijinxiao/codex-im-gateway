import assert from "node:assert/strict";
import test from "node:test";

import { AccessController } from "../src/bridge/access.js";

test("unknown users require approval from the local management page", () => {
  const access = new AccessController({ allowedSenderIds: [] });

  const challenge = access.requireAccess("alice@im.wechat");

  assert.equal(challenge.allowed, false);
  assert.match(challenge.message, /management page/i);
  assert.equal(access.isAllowed("alice@im.wechat"), false);

  access.allow("alice@im.wechat");

  assert.equal(access.isAllowed("alice@im.wechat"), true);
});

test("configured allowlist users are allowed without pairing", () => {
  const access = new AccessController({ allowedSenderIds: ["owner@im.wechat"] });

  assert.equal(access.requireAccess("owner@im.wechat").allowed, true);
  assert.equal(access.requireAccess("stranger@im.wechat").allowed, false);
});

test("an explicitly allowed conversation grants group-wide access while other chats do not", () => {
  const access = new AccessController({ allowedSenderIds: ["oc_trusted_group"] });

  assert.equal(access.requireAccess("ou_member", "oc_trusted_group").allowed, true);
  assert.equal(access.requireAccess("ou_member", "oc_other_group").allowed, false);
});
