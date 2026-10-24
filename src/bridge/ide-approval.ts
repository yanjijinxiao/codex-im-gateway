import type { IDEApprovalService } from "../ide/approval-service.js";
import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";
import type { ChannelMessage } from "../channels/message.js";
import { IDE_APPROVAL_CHOICES, ideConfirmationCommand } from "../ide/approval-presentation.js";
import { copyBlock } from "../channels/copyable.js";

/** Explicit control commands only; never resolved from model/friendly intent or
 * quoted content. Unknown conversation kinds fail closed, even if IDs match. */
export function isIDEApprovalCommand(name: string, arg: string): boolean {
  return name === "ide" && Boolean(arg.trim()) && arg.trim().toLowerCase() !== "status";
}
export async function ideApprovalCommand(input: { service?: IDEApprovalService; accountId?: string;
  providerId?: string; channel: string; message: ChannelMessage; arg: string }): Promise<string | ChannelActionCard> {
  const kind = input.message.conversationKind;
  if ((kind !== "direct" && kind !== "group") || (kind === "group"
    && (!input.message.replyTargetId || input.message.replyTargetId === input.message.senderId)))
    return "IDE 身份与审批命令仅支持渠道已核验的私聊或群聊，且必须能够区分真实发送人与群会话。群白名单不能批准浏览器。";
  if (!input.service || !input.accountId || !input.providerId || !["dingtalk", "feishu", "wecom", "weixin"].includes(input.channel)) return "此渠道的 IDE 审批服务尚未就绪，请使用本机 Gateway 管理页。";
  const args = input.arg.trim().split(/\s+/);
  try {
    const principal = input.service.principal(input.accountId, input.channel, input.message.senderId, input.providerId);
    if (args.length === 1 && args[0] === "identity") {
      const status = input.service.registrationStatus(principal);
      const description = status === "registered"
        ? "审批资格：已登记为 IDE 审批管理员，重启后保留，无需重复登记。管理员资格与浏览器访问授权不同；新浏览器仍需核对授权页并发送所选命令，一次即可。"
        : status === "unregistered"
          ? "审批资格：当前个人身份未登记。首次请在本机 Gateway → Web IDE → 授权管理员选择该渠道账号并登记个人 ID。不要填写群 ID。"
          : "审批资格：暂时无法核验。请在本机管理页检查管理员记录或渠道配置；无法核验不表示登记已丢失。";
      return `IDE 个人身份与审批资格\n渠道账号：${principal.accountId}\n渠道：${principal.channel}\n${description}\n\n个人 ID（单独复制下方内容）：\n\n${copyBlock(principal.actorId)}`;
    }
    if (args.length === 2 && args[0] === "auth" && /^\d{6}$/.test(args[1])) {
      const { request, token, shortCode } = input.service.preview(principal, args[1]);
      const directories = request.rootPaths ? `工作区目录（${request.rootPaths.length} 个，权限涵盖全部所列目录）：\n${request.rootPaths.join("\n")}` : `目录：${request.workspace}`;
      const body = `请核对原浏览器识别码：${request.code}\n项目：${request.projectName}\n主机：${request.hostId}\n${directories}\n允许项目编辑和终端访问，具备运行用户的开发权限，不是文件系统沙箱。\n「并信任」还会启用所列目录的任务、调试及扩展。仅批准你本人发起的申请；授权 15 天，可在本机撤销。`;
      const panel = request.url ? `\n\n[打开确认复制面板](${new URL(`/approval/${token}`, request.url).href})\n面板按钮只复制命令，不会授权。复制后由本人在本机器人私聊或群聊发送；原浏览器申请仍为 5 分钟有效。` : "";
      return createChoiceCard({ title: "确认 Web IDE 浏览器授权", body,
        note: "支持按钮的渠道可点击；钉钉请打开确认复制面板，或发送下方一条短命令。仅当前已登记个人账号能确认。",
        fallbackText: `${body}${panel}\n\n二次确认：仅发送你选择的一条短命令。也可直接输入，不必依赖钉钉代码块的复制图标。\n\n${IDE_APPROVAL_CHOICES.map(c => `${c.label}\n\n${copyBlock(ideConfirmationCommand(shortCode, c.choice))}`).join("\n\n")}`,
        choices: IDE_APPROVAL_CHOICES.map(c => ({ label: c.label, command: "ide", arg: `${c.choice} ${shortCode}`, style: c.style })) });
    }
    const short = args.length === 2 && ["trust", "access", "deny"].includes(args[0]) && /^[a-f0-9]{12}$/.test(args[1]);
    const legacy = args.length === 3 && args[0] === "confirm" && /^[a-f0-9]{32}$/.test(args[1]) && ["trust", "access", "deny"].includes(args[2]);
    if (short || legacy) {
      const choice = (short ? args[0] : args[2]) as "trust" | "access" | "deny";
      await input.service.decide(principal, args[1], choice);
      return choice === "deny" ? "已拒绝该浏览器申请，未签发访问授权。" : `已批准原浏览器${choice === "trust" ? "并信任所示精确目录" : "访问，未自动信任目录代码"}。请回到原页面，它会自动继续。授权 15 天、重启保留；没有提交 Codex 任务或修改绑定。`;
    }
    return ["用法：从授权页复制一种命令，由已登记本人在对应机器人私聊或群聊发送一次即可处理；不要求聊天绑定 session。群内回复对群成员可见，群白名单不能代替个人审批资格。",
      ...IDE_APPROVAL_CHOICES.map(c => `${c.label}（请用授权页的实际编号替换“十二位编号”）：\n\n${copyBlock(ideConfirmationCommand("十二位编号", c.choice))}`),
      `查看本人资格：\n\n${copyBlock("/ide identity")}`,
      `兼容流程核对申请：\n\n${copyBlock("/ide auth 六位识别码")}`].join("\n\n");
  } catch (error) { return error instanceof Error ? error.message : "IDE 审批未完成，请在原浏览器刷新后重试。"; }
}
