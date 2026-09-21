import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
const fixture = {
  accountId: "test-dingtalk",
  channel: "dingtalk",
  displayName: "测试钉钉",
  clientId: "test-client",
  status: "running",
  sessionCount: 1,
  pairedSenderIds: [] as string[],
  lastActiveActorId: "test-actor-178912",
  lastActiveSenderId: "cid/test-conversation+=="
};

function harness(overrides: Partial<typeof fixture> = {}, confirmed = true) {
  const account = { ...fixture, ...overrides };
  const requests: { url: string; options: { method: string } }[] = [];
  const confirmations: string[] = [];
  const notices: string[] = [];
  const accountsList = { innerHTML: "", querySelectorAll: () => [] };
  const context = vm.createContext({
    document: { addEventListener() {} },
    window: { confirm(message: string) { confirmations.push(message); return confirmed; } },
    channelModeSettings: { summary: () => ({ qaLabel: "", defaultLabel: "会话", enabledLabel: "会话" }) },
    account,
    accountsList
  });
  vm.runInContext(source, context);
  vm.runInContext("state.accounts = [account]; els.accountsList = accountsList;", context);
  context.api = async (url: string, options: { method: string }) => { requests.push({ url, options: { method: options.method } }); };
  context.refreshData = async () => {};
  context.toast = (message: string) => notices.push(message);
  context.renderAccountProjects = () => '<section class="fixture-projects">Codex 项目</section>';
  return {
    account, requests, confirmations, notices,
    render() {
      context.renderAccounts();
      return accountsList.innerHTML;
    },
    async allow(scope = "actor", dataset: Record<string, string> = {}) {
      const button = {
        disabled: false,
        dataset: {
          accountAction: "allow", accountId: account.accountId,
          actorId: fixture.lastActiveActorId, conversationId: fixture.lastActiveSenderId,
          authorizationScope: scope,
          senderId: scope === "actor" ? fixture.lastActiveActorId : fixture.lastActiveSenderId,
          ...dataset
        }
      };
      await context.handleAccountAction({ target: { closest: () => button } });
      assert.equal(button.disabled, false);
    }
  };
}

for (const [channel, label] of [["dingtalk", "钉钉"], ["feishu", "飞书"], ["wecom", "企业微信"], ["weixin", "微信"]]) {
  test(`${channel} shows the actor, conversation and scoped authorization actions`, () => {
    const page = harness({ channel, pairedSenderIds: ["already-allowed-user"] }).render();
    assert.match(page, new RegExp(`新的${label}访问请求`));
    assert.match(page, /用户 Actor ID<\/dt><dd><code>test-actor-178912<\/code>/);
    assert.match(page, /来源 Conversation ID<\/dt><dd><code>cid\/test-conversation\+==<\/code>/);
    assert.match(page, /最近 Actor ID（发消息的用户）/);
    assert.match(page, /data-authorization-scope="actor" data-sender-id="test-actor-178912"/);
    assert.match(page, /仅允许此用户/);
    assert.match(page, /已有访问授权/);
    assert.ok(page.indexOf("访问请求") < page.indexOf('class="fixture-projects"'));
    if (channel !== "weixin") {
      assert.doesNotMatch(page, /新的微信访问请求/);
      assert.match(page, /data-authorization-scope="conversation" data-sender-id="cid\/test-conversation\+=="/);
      assert.match(page, /将包含其他群成员/);
    } else {
      assert.doesNotMatch(page, /允许整个会话/);
    }
  });
}

test("first pending request displays identity, not an anonymous allow button", () => {
  const page = harness().render();
  assert.match(page, /<strong>待授权<\/strong>/);
  assert.doesNotMatch(page, /已有访问授权|<span>允许访问<\/span>/);
});

test("already allowed actors or conversations do not show a redundant pending request", () => {
  for (const id of [fixture.lastActiveActorId, fixture.lastActiveSenderId]) {
    const page = harness({ pairedSenderIds: [id] }).render();
    assert.match(page, /已有访问授权/);
    assert.match(page, /最近 Actor ID（发消息的用户）/);
    assert.doesNotMatch(page, /data-account-action="allow"/);
  }
});

test("group channels never present a conversation ID as an unknown actor", () => {
  for (const channel of ["dingtalk", "feishu", "wecom"]) {
    const page = harness({ channel, lastActiveActorId: "" }).render();
    assert.match(page, /未获取，请重新发送消息/);
    assert.match(page, /无法确认访问者，暂不能授权/);
    assert.doesNotMatch(page, /data-account-action="allow"/);
  }
});

test("legacy personal WeChat still uses its sender as actor without offering a group grant", () => {
  const page = harness({ channel: "weixin", lastActiveActorId: "", lastActiveSenderId: "test@im.wechat" }).render();
  assert.match(page, /data-authorization-scope="actor" data-sender-id="test@im.wechat"/);
  assert.doesNotMatch(page, /允许整个会话/);
});

test("no received message renders the platform-specific empty state", () => {
  const page = harness({ lastActiveActorId: "", lastActiveSenderId: "" }).render();
  assert.match(page, /等待消息/);
  assert.match(page, /请先从钉钉向机器人发送一条消息/);
  assert.doesNotMatch(page, /data-account-action="allow"/);
});

test("authorization IDs are fully rendered and escaped in text and attributes", () => {
  const actor = '<actor" onmouseover="bad()">&';
  const conversation = 'cid"<script>bad()</script>' + "long-id".repeat(30);
  const page = harness({ lastActiveActorId: actor, lastActiveSenderId: conversation }).render();
  assert.doesNotMatch(page, /<script>|<actor| onmouseover="/);
  assert.match(page, /&lt;actor&quot; onmouseover=&quot;bad\(\)&quot;&gt;&amp;/);
  assert.ok(page.includes("long-id".repeat(30)));
});

test("user authorization confirms scope then sends only the displayed actor ID", async () => {
  const h = harness();
  await h.allow();
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /用户 Actor ID：test-actor-178912/);
  assert.ok(h.confirmations[0].includes(fixture.lastActiveSenderId));
  assert.match(h.confirmations[0], /不会授权同一聊天中的其他人/);
  assert.deepEqual(h.requests, [{ url: `/api/accounts/${fixture.accountId}/senders/${fixture.lastActiveActorId}/allow`, options: { method: "POST" } }]);
  assert.match(h.notices[0], /请回聊天重新发送消息/);
});

test("conversation authorization explicitly warns of other members and sends the conversation ID", async () => {
  const h = harness();
  await h.allow("conversation");
  assert.match(h.confirmations[0], /允许整个会话/);
  assert.match(h.confirmations[0], /其他群成员也将获得访问权限/);
  assert.deepEqual(h.requests, [{ url: `/api/accounts/${fixture.accountId}/senders/${encodeURIComponent(fixture.lastActiveSenderId)}/allow`, options: { method: "POST" } }]);
});

test("cancelling either authorization confirmation sends no request", async () => {
  for (const scope of ["actor", "conversation"]) {
    const h = harness({}, false);
    await h.allow(scope);
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.requests.length, 0);
  }
});

test("new incoming messages do not silently retarget an already displayed authorization", async () => {
  const h = harness({ lastActiveActorId: "new-actor", lastActiveSenderId: "new-conversation" });
  await h.allow();
  assert.match(h.confirmations[0], /test-actor-178912/);
  assert.doesNotMatch(h.confirmations[0], /new-actor|new-conversation/);
  assert.ok(h.requests[0].url.endsWith(`/senders/${fixture.lastActiveActorId}/allow`));
});

test("missing or mismatched identity and scope fail closed", async () => {
  for (const dataset of [
    { actorId: "" }, { senderId: fixture.lastActiveSenderId }, { authorizationScope: "" }
  ]) {
    const h = harness();
    await h.allow("actor", dataset);
    assert.equal(h.requests.length, 0);
    assert.equal(h.confirmations.length, 0);
    assert.match(h.notices[0], /授权对象信息不完整/);
  }
});
