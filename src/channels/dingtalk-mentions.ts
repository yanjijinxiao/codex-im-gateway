import type { ChannelMention } from "./types.js";
import { isDirectedMentionId } from "./mentions.js";

/** Provider-only presentation. Never extract a recipient from answer text. */
export function dingTalkMentionCard(text: string, mentions: readonly ChannelMention[]): {
  text: string;
  atUserIds: Record<string, string>;
} {
  if (!mentions.length || mentions.length > 50 || mentions.some(item => !isDirectedMentionId(item.userId))) {
    throw new Error("Invalid DingTalk directed mention recipients");
  }
  const recipients = new Map<string, string>();
  for (const item of mentions) {
    if (!recipients.has(item.userId)) recipients.set(item.userId, displayName(item.name));
  }
  const anchors = [...recipients].map(([id, name]) => `<a atId=${id}>${escapeHtml(name)}</a>`).join(" ");
  // Model-authored HTML anchors cannot create native mentions (including an
  // anchor for someone already in the trusted list). Markdown links stay intact.
  const body = text.replace(/<\/?a\b[^>]*(?:>|$)/gi, escapeHtml);
  return { text: `${anchors}\n\n${body}`, atUserIds: Object.fromEntries(recipients) };
}

/** The creation whitelist is distinct from delivery's notification map. Both
 * HTTPS and SDK must declare the same provider identity type before any write. */
export function dingTalkCardAtParameters(target: { type: "group" | "user" }, atUserIds?: Record<string, string>): {
  cardAtUserIds?: string[];
  userIdType?: 1;
} {
  if (!atUserIds) return {};
  const ids = Object.keys(atUserIds);
  if (target.type !== "group" || !ids.length || ids.length > 50
    || ids.some(id => !isDirectedMentionId(id) || typeof atUserIds[id] !== "string" || !atUserIds[id].trim())) {
    throw new Error("Invalid DingTalk group mention metadata");
  }
  return { cardAtUserIds: ids, userIdType: 1 };
}

function displayName(name?: string): string {
  return Array.from((name ?? "").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()).slice(0, 80).join("") || "参与者";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
