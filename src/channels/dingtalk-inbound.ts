import type { ChannelAttachment, ChannelReference } from "./message.js";

type RecordValue = Record<string, unknown>;
const MAX_REFERENCE_DEPTH = 3;
const MAX_ATTACHMENTS = 20;

function record(value: unknown): RecordValue {
  if (typeof value === "string") { try { return record(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

/** Decode provider data only here; download credentials stay in opaque items. */
export function decodeDingTalkInbound(body: RecordValue, depth = 0): {
  text: string; attachments: ChannelAttachment[]; references: ChannelReference[]; supported: boolean;
} {
  const type = string(body.msgtype ?? body.msgType) || "text";
  const content = record(body.content);
  const textContainer = record(body.text);
  const result = { text: "", attachments: [] as ChannelAttachment[], references: [] as ChannelReference[], supported: true };
  const media = (kind: ChannelAttachment["kind"], value: RecordValue, label: string) => {
    const downloadCode = string(value.downloadCode ?? value.pictureDownloadCode);
    const downloadUrl = kind === "image" ? string(value.pictureUrl) : "";
    if (!downloadCode && !downloadUrl) return false;
    if (result.attachments.length >= MAX_ATTACHMENTS) throw new Error("DingTalk message has too many attachments");
    if (!result.attachments.some(item => item.kind === kind && item.item.downloadCode === (downloadCode || undefined)
      && item.item.downloadUrl === (downloadUrl || undefined))) {
      result.attachments.push({ kind, label, item: { ...(downloadCode ? { downloadCode } : {}), ...(downloadUrl ? { downloadUrl } : {}) } });
    }
    return true;
  };
  if (["text", "markdown", "reply"].includes(type)) {
    result.text = string(textContainer.content) || string(content.text) || string(content.content) || string(record(content.text).content) || string(body.text)
      || (typeof body.content === "string" && !body.content.trim().startsWith("{") ? body.content.trim() : "");
  } else if (type === "picture") {
    if (!media("image", content, "image")) result.supported = false;
  } else if (type === "file") {
    const file = Object.keys(content).length ? content : record(body.file);
    const name = string(file.fileName) || "file";
    if (!media("file", file, name)) {
      result.references.push({ type: "file", text: `[文件] ${name}`, attachments: [], availability: "metadata-only",
        reason: "钉钉未提供可下载凭据，本轮无法读取文件正文。" });
    }
  } else if (type === "richText") {
    const parts = Array.isArray(content.richText) ? content.richText : [];
    for (const raw of parts) {
      const part = record(raw);
      if (typeof part.text === "string") result.text += part.text;
      if (part.type === "file") media("file", part, string(part.fileName) || "file");
      else if (part.type === "picture" || part.pictureUrl || (!part.type && part.downloadCode)) media("image", part, "image");
    }
  } else if (type === "interactiveCard" || type === "actionCard") {
    const url = string(content.biz_custom_action_url ?? body.biz_custom_action_url);
    result.text = [string(content.title), string(content.text), /^https:\/\//i.test(url) ? url : ""].filter(Boolean).join("\n");
    result.supported = Boolean(result.text);
  } else result.supported = false;

  const container = textContainer.repliedMsg ? textContainer : content.repliedMsg ? content : body;
  const quoted = record(container.repliedMsg);
  if (Object.keys(quoted).length) {
    const id = string(quoted.msgId);
    const quotedType = string(quoted.msgType ?? quoted.msgtype) || "text";
    const decoded = depth < MAX_REFERENCE_DEPTH ? decodeDingTalkInbound({ ...quoted, msgtype: quotedType }, depth + 1) : undefined;
    const attachments = decoded?.attachments.map(item => ({ ...item, sourceMessageId: id || `reference:${depth}` })) ?? [];
    result.references.push({ messageId: id || undefined, senderId: string(quoted.senderId) || undefined,
      type: quotedType, text: decoded?.text || decoded?.references.find(item => item.type === quotedType)?.text,
      attachments, availability: attachments.length || decoded?.text ? "available" : "metadata-only",
      ...(!attachments.length && !decoded?.text ? { reason: decoded?.references[0]?.reason ?? "仅收到引用元信息，未取得原消息正文或附件下载凭据。" } : {}) });
    if (decoded) result.references.push(...decoded.references.filter(item => item.messageId));
    result.supported = true;
  }
  result.text = result.text.trim();
  if (result.attachments.length + result.references.reduce((n, r) => n + r.attachments.length, 0) > MAX_ATTACHMENTS) {
    throw new Error("DingTalk message has too many attachments");
  }
  return result;
}
