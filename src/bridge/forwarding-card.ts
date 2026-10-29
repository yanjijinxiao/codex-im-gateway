import { createChoiceCard } from "../channels/action-card.js";
import type { ForwardingItem, ForwardingTarget } from "./forwarding-inbox.js";

const stateName = { pending: "已保存待转发", held: "需要核对", unconfirmed: "提交结果未确认" };
const preview = (text: string, limit: number) => text.replace(/\s+/g, " ").slice(0, limit).replace(/[\\`*_\[\]<>]/g, "\\$&");

export function forwardingCard(items: ForwardingItem[], arg: string, targetName: (target: ForwardingTarget) => string) {
  const detail = items.find(item => item.id === arg);
  if (detail) {
    const body = [`状态：${stateName[detail.state]}`, `原消息：${preview(detail.text, 800) || "（仅附件）"}`,
      ...(detail.attachments.length ? [`附件：${detail.attachments.map(a => preview(a, 80)).join("、")}`] : []),
      `原目标：${detail.target ? targetName(detail.target) : "未绑定"}`,
      `当前目标：${detail.currentTarget ? targetName(detail.currentTarget) : "未绑定"}`,
      detail.retryable ? "仅限已确认未提交的消息。选择转发后，会将这条已保存消息发送到上面显示的当前目标。"
        : "未确认的提交不自动重发；Gateway 操作可能已部分执行时也不重放。"];
    return createChoiceCard({ title: "已保存的转发消息", body: body.join("\n\n"), fallbackText: body.join("\n\n"), choices: [
      ...(detail.retryable && detail.currentTarget && detail.targetVersion ? [{ label: "转发到当前绑定", command: "inbox" as const,
        arg: `retry ${detail.id} ${detail.targetVersion}`, style: "primary" as const }] : []),
      ...(detail.cancellable ? [{ label: "取消转发", command: "inbox" as const, arg: `cancel ${detail.id}`, style: "danger" as const }] : []),
      { label: "返回转发记录", command: "inbox", arg: "" }
    ] });
  }
  const page = /^page\s+\d+$/.test(arg) ? Math.max(0, Number(arg.split(/\s+/)[1]) - 1) : 0;
  const rows = items.slice(page * 5, page * 5 + 5);
  const body = rows.length ? rows.map((item, i) =>
    `${page * 5 + i + 1}. ${stateName[item.state]}\n${preview(item.text, 100) || "（仅附件）"}${item.attachments.length ? ` · ${item.attachments.length} 个附件` : ""}`
  ).join("\n\n") : "当前没有待转发或待核对的已保存消息。";
  return createChoiceCard({ title: "消息转发记录", body, fallbackText: body, choices: [
    ...rows.map((item, i) => ({ label: `查看第 ${page * 5 + i + 1} 条`, command: "inbox" as const, arg: item.id })),
    ...(page ? [{ label: "上一页", command: "inbox" as const, arg: `page ${page}` }] : []),
    ...(items.length > (page + 1) * 5 ? [{ label: "下一页", command: "inbox" as const, arg: `page ${page + 2}` }] : [])
  ] });
}
