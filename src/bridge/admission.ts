import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonFile } from "../state/json-store.js";
import { channelPrincipalSchema, type ChannelPrincipal } from "../channels/principal.js";
import type { ChannelMessage } from "../channels/message.js";
import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";
import { copyBlock } from "../channels/copyable.js";

const id = z.string().regex(/^[a-f0-9]{12}$/);
const observationSchema = z.object({ id, version: z.string().regex(/^[a-f0-9]{64}$/), principal: channelPrincipalSchema,
  conversationId: z.string().min(1).max(500), kind: z.enum(["direct", "group"]),
  createdAt: z.number().safe(), expiresAt: z.number().safe(), phase: z.enum(["pending", "applying", "dismissed"]) }).strict();
export type AdmissionRequest = z.infer<typeof observationSchema>;
const schema = z.object({ version: z.literal(1), admins: z.array(channelPrincipalSchema).max(50),
  observations: z.array(observationSchema).max(500) }).strict();
const key = (p: ChannelPrincipal) => JSON.stringify([p.accountId, p.channel, p.providerId, p.actorId]);
export const admissionVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const admissionId = id;
export class AdmissionConflictError extends Error {}

/** Administrative admission is separate from chat participation, session roles,
 * native tool approvals and browser pairing. Only local management enrolls admins.
 * Web and IM decisions call the existing ACL owner; this is never a second ACL.
 */
export class AdmissionService {
  private readonly file: string;
  private state: z.infer<typeof schema> = { version: 1, admins: [], observations: [] };
  error?: string;
  constructor(private readonly options: { root: string; accounts: () => { accountId: string; channel: string; providerId: string }[];
    allowed: (accountId: string, actorId: string, conversationId: string) => boolean;
    allow: (accountId: string, target: string) => void; now?: () => number }) {
    this.file = path.join(options.root, "admission.json");
    try {
      this.state = schema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      if (new Set(this.state.observations.map(r => r.id)).size !== this.state.observations.length) throw Error("duplicate request");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = "准入审批记录无法读取，远程准入审批已关闭；原文件未覆盖。";
    }
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private valid(p: ChannelPrincipal) { return this.options.accounts().some(a => a.accountId === p.accountId && a.channel === p.channel && a.providerId === p.providerId); }
  private assertReady() { if (this.error) throw Error(this.error); }
  private save(next: typeof this.state) { this.assertReady(); writeJsonFile(this.file, next, { durable: true }); this.state = next; }
  private current(r: AdmissionRequest) { return r.expiresAt > this.now() && this.valid(r.principal); }
  private allowed(r: AdmissionRequest) { return this.options.allowed(r.principal.accountId, r.principal.actorId, r.conversationId); }
  isAdmin(p: ChannelPrincipal) { return !this.error && this.valid(p) && this.state.admins.some(a => key(a) === key(p)); }
  snapshot() {
    if (this.error) return { admins: [], candidates: [], requests: [], error: this.error };
    const rows = this.state.observations.filter(r => this.current(r));
    return structuredClone({ admins: this.state.admins, candidates: rows,
      requests: rows.filter(r => r.phase !== "dismissed" && !this.allowed(r)) });
  }
  observe(principal: ChannelPrincipal, conversationId: string, kind: "direct" | "group") {
    this.assertReady(); principal = channelPrincipalSchema.parse(principal);
    if (!this.valid(principal) || kind === "group" && principal.actorId === conversationId) throw Error("无法核验真实用户与渠道账号");
    const existing = this.state.observations.find(r => key(r.principal) === key(principal) && r.conversationId === conversationId && r.kind === kind && this.current(r) && r.phase !== "dismissed");
    if (existing) return structuredClone(existing);
    let requestId: string;
    do { requestId = crypto.randomBytes(6).toString("hex"); } while (this.state.observations.some(r => r.id === requestId));
    const record = observationSchema.parse({ id: requestId, version: crypto.randomBytes(32).toString("hex"),
      principal, conversationId, kind, createdAt: this.now(), expiresAt: this.now() + 24 * 60 * 60_000, phase: "pending" });
    const observations = this.state.observations.filter(r => this.current(r));
    if (observations.length >= 500 || observations.filter(r => key(r.principal) === key(principal)).length >= 8) throw Error("准入申请已达上限，请管理员先处理");
    this.save({ ...this.state, observations: [...observations, record] }); return structuredClone(record);
  }
  private request(requestId: string, version: string) {
    this.assertReady(); const r = this.state.observations.find(r => r.id === requestId && r.version === version && this.current(r));
    if (!r || r.phase !== "pending") throw new AdmissionConflictError("申请已处理、过期或渠道已改变，请重新查看申请。");
    return r;
  }
  setAdmin(requestId: string, version: string) {
    const r = this.request(requestId, version), admins = this.state.admins.filter(a => key(a) !== key(r.principal));
    if (admins.length >= 50) throw Error("准入审批管理员已达上限");
    this.save({ ...this.state, admins: [...admins, r.principal] });
  }
  forgetAccount(accountId: string) {
    this.save({ ...this.state, admins: this.state.admins.filter(a => a.accountId !== accountId),
      observations: this.state.observations.filter(r => r.principal.accountId !== accountId) });
  }
  removeAdmin(principal: ChannelPrincipal) {
    this.save({ ...this.state, admins: this.state.admins.filter(a => key(a) !== key(channelPrincipalSchema.parse(principal))) });
  }
  decideLocal(requestId: string, version: string, choice: "actor" | "conversation" | "deny") {
    return this.applyChoice(requestId, version, choice);
  }
  decideRemote(admin: ChannelPrincipal, requestId: string, version: string, choice: "actor" | "conversation" | "deny") {
    if (!this.isAdmin(admin)) throw Error("仅本渠道已指定的准入审批管理员可以处理");
    return this.applyChoice(requestId, version, choice, admin);
  }
  private applyChoice(requestId: string, version: string, choice: "actor" | "conversation" | "deny", admin?: ChannelPrincipal) {
    const r = this.request(requestId, version);
    if (admin && (admin.accountId !== r.principal.accountId || admin.channel !== r.principal.channel || admin.providerId !== r.principal.providerId))
      throw Error("不能跨渠道账号处理准入申请");
    if (this.allowed(r)) throw new AdmissionConflictError("此用户或会话已经获准，请刷新。");
    if (choice === "conversation" && r.kind !== "group") throw Error("此申请不是已核验的群聊，不能授权整个会话");
    // Persist the dispatch boundary before touching the existing ACL. A crash or
    // write failure must never replay an unconfirmed grant on restart.
    const replace = (phase: AdmissionRequest["phase"]) => ({ ...this.state, observations: this.state.observations.map(x => x.id === r.id ? { ...x, phase } : x) });
    this.save(replace(choice === "deny" ? "dismissed" : "applying"));
    if (choice !== "deny") {
      try {
        this.options.allow(r.principal.accountId, choice === "actor" ? r.principal.actorId : r.conversationId);
        this.save(replace("dismissed"));
      } catch {
        throw Error("这次准入授权结果未确认，未自动重试。请在本机账号授权中核对该用户或群，勿重复批准其他申请。");
      }
    }
    return choice === "deny" ? "已拒绝此准入申请，未修改访问权限。" : choice === "actor"
      ? `已仅允许用户 ${r.principal.actorId}，可使用 IM 并为本人浏览器配对 IDE；没有授予准入审批管理员权限。请申请人重新发送原消息。`
      : `已允许整个群聊 ${r.conversationId} 的成员使用 IM；不授予个人 IDE 配对资格。请申请人重新发送原消息。`;
  }
  notice(r: AdmissionRequest): ChannelActionCard {
    const body = `渠道账号：${r.principal.accountId}\n用户：${r.principal.actorId}\n来源${r.kind === "group" ? "群聊" : "私聊"}：${r.conversationId}\n用户准入包含 IM 使用和本人 IDE 浏览器配对资格；不含管理员权限。整个群聊准入只允许 IM，覆盖其他群成员。`;
    const choices = [{ label: "仅允许此用户", choice: "actor", confirm: "允许该用户使用 Codex 和本人 Web IDE 配对？" },
      ...(r.kind === "group" ? [{ label: "允许整个群聊", choice: "conversation", confirm: "群内所有成员都将获得 IM 使用权限，继续？" }] : []),
      { label: "拒绝", choice: "deny", confirm: "拒绝此准入申请？" }];
    return createChoiceCard({ title: `Gateway 准入申请 ${r.id}`, body, note: "只处理这条申请，不执行或重发申请人的消息。24 小时内有效。",
      fallbackText: [body, ...choices.map(c => `${c.label}\n\n${copyBlock(`/access ${c.choice} ${r.id} ${r.version}`)}`)].join("\n\n"),
      choices: choices.map(c => ({ label: c.label, command: "access", arg: `${c.choice} ${r.id} ${r.version}`, confirm: c.confirm,
        style: c.choice === "deny" ? "danger" : "default" })) });
  }
  command(p: ChannelPrincipal, conversationId: string, kind: "direct" | "group", arg: string): string | ChannelActionCard {
    if (!this.valid(p)) throw Error("渠道账号已改变，请重新核验身份");
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === "identity" && parts.length === 1) {
      this.observe(p, conversationId, kind);
      return `准入审批身份：${p.actorId}\n渠道账号：${p.accountId}\n${this.isAdmin(p) ? "已登记为本渠道准入审批管理员，可发送 /access 查看申请。" : "尚未登记为准入审批管理员。请在本机 Gateway「待审批 → 远程准入管理员」选中此身份登记一次；以后可在钉钉处理，无需访问本机页面。"}`;
    }
    if (!this.isAdmin(p)) return "你没有准入审批管理员权限。首次设置请发送 /access identity，再由本机管理页明确登记；个人准入、群授权和会话 controller 不能代替管理员资格。";
    if (!parts.length || parts.length === 1 && parts[0] === "list") {
      const rows = this.snapshot().requests.filter(r => r.principal.accountId === p.accountId && r.principal.providerId === p.providerId && r.principal.channel === p.channel);
      return rows.length ? ["待处理准入申请（不会执行申请人的原消息）", ...rows.slice(0, 10).map(r => `${r.principal.actorId} · ${r.kind === "group" ? "群聊" : "私聊"} ${r.conversationId}\n${r.phase === "applying" ? "上次授权结果未确认，请在本机核对。" : copyBlock(`/access show ${r.id}`)}`), ...(rows.length > 10 ? ["仅展示前 10 条；处理后再查看。"] : [])].join("\n\n") : "当前渠道没有待处理准入申请。";
    }
    const r = this.state.observations.find(r => r.id === parts[1] && r.principal.accountId === p.accountId && r.principal.channel === p.channel && r.principal.providerId === p.providerId);
    if (!r) throw new AdmissionConflictError("申请不属于当前渠道账号，或已经失效。");
    if (parts[0] === "show" && parts.length === 2) return this.notice(this.request(r.id, r.version));
    if (["actor", "conversation", "deny"].includes(parts[0]) && parts.length === 3) return this.decideRemote(p, r.id, parts[2], parts[0] as "actor" | "conversation" | "deny");
    return "用法：/access 查看申请；从申请详情发送完整决定命令。";
  }
}

export function admissionPrincipal(accountId: string | undefined, providerId: string | undefined, channel: string, message: ChannelMessage): ChannelPrincipal | undefined {
  if (!accountId || !providerId || !["direct", "group"].includes(message.conversationKind ?? "")
    || message.conversationKind === "group" && (!message.replyTargetId || message.senderId === message.replyTargetId)) return;
  return channelPrincipalSchema.safeParse({ accountId, providerId, channel, actorId: message.senderId }).data;
}
