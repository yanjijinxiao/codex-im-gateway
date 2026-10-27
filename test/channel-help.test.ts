import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_COMMAND_REGISTRY, channelHelpText, isReservedChannelCommandToken, parseCommand } from "../src/bridge/channel-commands.js";
import { EXEC_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { chunkText } from "../src/bridge/format.js";
import { normalizeDingTalkCardContent } from "../src/channels/dingtalk.js";

const interventionCommands = ["/history more", "/follow", "/leave", "/policy", "/role", "/steer", "/queue", "/intervene"];

test("DingTalk help keeps intervention commands in its first message with paragraph breaks", () => {
  const chunks = chunkText(channelHelpText([]));
  const rendered = chunks.map(normalizeDingTalkCardContent);
  for (const command of interventionCommands) {
    assert.ok(rendered[0].includes(command), `${command} must be visible without finding another help message`);
  }
  assert.ok(rendered[0].includes("\n\n/history more"));
  assert.ok(rendered[0].includes("\n\n/follow"));
  assert.ok(rendered.join("\n").includes("/reject"), "later sections must not be lost when split");
});

test("command inventory reserves every canonical command/alias and reports backend limits", () => {
  const help = channelHelpText([], "", { backendCapabilities: EXEC_BACKEND_CAPABILITIES, taskboardAvailable: false });
  for (const command of CHANNEL_COMMAND_REGISTRY) {
    assert.ok(isReservedChannelCommandToken(command.name), command.name);
    assert.ok(help.includes("/" + command.name), command.name);
    for (const alias of command.aliases) {
      assert.ok(isReservedChannelCommandToken(alias), alias);
      assert.equal(parseCommand("/" + alias)?.name, command.name);
    }
  }
  assert.match(help, /\/steer[^\n]+【当前后端不支持】/);
  assert.match(help, /\/follow[^\n]+【当前后端不支持】/);
  assert.match(help, /\/answer[^\n]+【当前后端不支持】/);
  assert.match(help, /\/task[^\n]+【需启用 Taskboard】/);
  assert.match(channelHelpText([], "session", { desktopOwned: true }), /Desktop 转发不支持此操作/);
});

test("focused session help describes policies, permissions and backend limits", () => {
  const command = parseCommand("/h session")!;
  const text = channelHelpText([], command.arg);
  assert.equal(command.name, "help");
  assert.equal(chunkText(text).length, 1);
  assert.match(text, /每页 10 个/);
  assert.match(text, /\/sessions size 50/);
  assert.match(text, /\/follow \[on\|off\|sync\]/);
  for (const name of interventionCommands) assert.ok(text.includes(name));
  assert.match(text, /steer：插入当前轮次（默认）/);
  assert.match(text, /viewer：只读；participant：对话与插话；controller/);
  assert.match(text, /后端不支持时明确拒绝，不暗中排队/);
  assert.match(text, /```text\n\/help\n```/);
  assert.match(text, /以下为命令语法参考/);
  assert.doesNotMatch(text, /```text\n\/session[^\n]*编号/);
  assert.doesNotMatch(text, /\/task new/);
  assert.equal(channelHelpText([], "all"), channelHelpText([]));
  assert.match(channelHelpText([], "typo"), /```text\n\/help session\n```/);
});
