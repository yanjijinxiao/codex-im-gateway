import assert from "node:assert/strict";
import test from "node:test";
import { channelHelpText, parseCommand } from "../src/bridge/channel-commands.js";
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

test("focused session help describes policies, permissions and backend limits", () => {
  const command = parseCommand("/h session")!;
  const text = channelHelpText([], command.arg);
  assert.equal(command.name, "help");
  assert.equal(chunkText(text).length, 1);
  for (const name of interventionCommands) assert.ok(text.includes(name));
  assert.match(text, /ask：先询问（默认）/);
  assert.match(text, /viewer：只读；participant：对话与插话；controller/);
  assert.match(text, /后端不支持时会提示改用 \/queue/);
  assert.match(text, /发送 \/help 查看全部命令/);
  assert.doesNotMatch(text, /\/task new/);
  assert.equal(channelHelpText([], "all"), channelHelpText([]));
  assert.match(channelHelpText([], "typo"), /^用法：\/help/);
});
