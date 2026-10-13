import assert from "node:assert/strict";
import test from "node:test";
import { resultPages } from "../src/channels/result-pages.js";
import { ChannelTurnTextStream, type ChannelStreamCheckpoint } from "../src/channels/progress.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

test("long UTF-8 results preserve every source character, Markdown fences, table headers and the final tail", () => {
  for (const text of ["中文😀".repeat(4000) + "最后完整尾部", "```sql\n" + "SELECT '中文😀';\n".repeat(600) + "```\n结尾", "|列|值|\n|---|---|\n" + "|中文|数据|\n".repeat(800) + "最后结论"]) {
    const pages = resultPages(text, 2000);
    assert.ok(pages.length > 1);
    assert.equal(pages.map(page => page.source).join(""), text);
    assert.ok(pages.every(page => Buffer.byteLength(page.text) <= 2000 && !page.text.includes("\ufffd")));
    assert.ok(pages.at(-1)!.text.includes(text.slice(-4)));
    for (const page of pages) assert.equal((page.text.match(/^```/gm) ?? []).length % 2, 0);
  }
  assert.deepEqual(resultPages("短回复"), [{ source: "短回复", text: "短回复" }]);
});

test("long terminal cards reuse page one and resume only unacknowledged continuation pages after restart", async () => {
  let saved: ChannelStreamCheckpoint | undefined, fail = true;
  const starts: string[] = [], updates: string[] = [];
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true, resultPageBytes: 1200 }, {
    async sendText() { throw new Error("no fallback"); },
    async startTextStream(input) { starts.push(input.streamId!); return { messageId: input.streamId! }; },
    async updateTextStream(input) { updates.push(input.messageId); if (fail && input.messageId.endsWith("_page_2")) throw Object.assign(new Error("offline"), { code: "ENOTFOUND" }); }
  });
  const first = new ChannelTurnTextStream(client, "chat", { save(value) { saved = value; } });
  await first.progress("处理任务");
  const original = first.checkpoint().messageId;
  assert.equal(await first.finalize("中文".repeat(1300)), false);
  assert.equal(saved?.terminalPages?.[0].delivered, true);
  await first.suspend();
  fail = false;
  const retry = new ChannelTurnTextStream(client, "chat", { restore: saved, save(value) { saved = value; } });
  assert.equal(await retry.finalize("中文".repeat(1300)), true);
  assert.equal(updates.filter(id => id === original).length, 1);
  assert.equal(starts.filter(id => id.endsWith("_page_2")).length, 1);
  assert.ok(saved!.terminalPages!.every(page => page.delivered));
  await retry.suspend();
});

test("uncertain native-text page submission is never automatically replayed after restart", async () => {
  let saved: ChannelStreamCheckpoint | undefined, calls = 0;
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, resultPageBytes: 1200 }, {
    async sendText() { if (++calls === 2) throw new Error("uncertain acknowledgement"); return { messageId: `text-${calls}` }; }
  });
  const first = new ChannelTurnTextStream(client, "chat", { save(value) { saved = value; } });
  assert.equal(await first.finalize("中文".repeat(1000)), false);
  await first.suspend();
  const retry = new ChannelTurnTextStream(client, "chat", { restore: saved, save(value) { saved = value; } });
  assert.equal(await retry.finalize("中文".repeat(1000)), false);
  assert.equal(calls, 2);
  await retry.suspend();
  // Enabling a card template must not convert an uncertain text submission
  // into a duplicate card delivery while restoring the same terminal turn.
  const changed = createChannelClient("generic", { ...TEXT_CAPABILITIES, progress: "available" }, {
    async sendText() { throw new Error("must not resend"); },
    async startTextStream() { throw new Error("must not create a replacement card"); },
    async updateTextStream() { throw new Error("must not update a text receipt as a card"); }
  });
  const restored = new ChannelTurnTextStream(changed, "chat", { restore: saved, save() {} });
  assert.equal(restored.supported, false);
  assert.equal(await restored.finalize("中文".repeat(1000)), false);
  await restored.suspend();
});
