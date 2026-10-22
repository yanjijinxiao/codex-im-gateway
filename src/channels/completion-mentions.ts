import type { ChannelStreamCheckpoint } from "./progress.js";
import type { ChannelCompletedCard } from "./types.js";
import { summarizeProgress } from "./progress-summary.js";

/** Only the acknowledged current segment, not a previous answer/steer card.
 * A paginated result must remain intact; it cannot fit in a single @ card. */
export function completedCardForMentions(checkpoint?: ChannelStreamCheckpoint): ChannelCompletedCard | undefined {
  const page = checkpoint?.terminalPages?.[0];
  if (!checkpoint?.finished || checkpoint.resultPresentation !== "card" || !checkpoint.terminal?.text
    || checkpoint.terminalPages?.length !== 1 || !page?.delivered || !page.messageId
    || page.messageId !== checkpoint.messageId) return;
  const entries = checkpoint.progressEntries.slice(-3).map(item => summarizeProgress(item, 180));
  return { messageId: page.messageId, text: checkpoint.terminal.text,
    summary: ["本轮处理已结束。", entries.length ? `最近进展：\n${entries.map(item => `- ${item}`).join("\n")}` : "",
      "完整结果与参与者 @ 已合并到下方的最终结果卡；此卡保留为进度小结。"].filter(Boolean).join("\n\n") };
}
