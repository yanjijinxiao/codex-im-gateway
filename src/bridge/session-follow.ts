import type { CodexThreadState } from "../codex/backend.js";
import type { ManagedSession } from "../state/runtime-state.js";
import type { ChannelStreamBootstrap, ChannelStreamFailure } from "../channels/stream-bootstrap.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { copyableChoices } from "../channels/copyable.js";
export type FollowSyncOptions = { confirmUncertainDelivery?: boolean };

/** Application port: commands never own transport subscriptions or card handles. */
export type SessionFollowPort = {
  status(session: ManagedSession): SessionFollowStatus;
  synchronize(session: ManagedSession, options?: FollowSyncOptions): Promise<SessionFollowStatus>;
};

export type FollowSyncFailure = {
  code: "timeout" | "connection" | "permission" | "backend" | "unconfirmed" | "orphan-turn" | "presentation" | "binding-changed" | "unavailable";
  /** Safe, transport-neutral explanation; never raw provider errors or commands. */
  message: string;
};

export type SessionFollowStatus = {
  status: "disabled" | "suspended" | "pending" | "syncing" | "synced" | "stale" | "unconfirmed" | "failed";
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  snapshotAt?: string;
  runtime?: CodexThreadState;
  failure?: FollowSyncFailure;
  presentation?: "updated" | "text-only" | "off" | "idle";
  /** Delivery acknowledgements are independent of the backend execution state. */
  resultDelivery?: { pending: number; deferred?: number; lastDeliveredTurnId?: string };
  progressDelivery?: { stage: ChannelStreamBootstrap["stage"] | "legacy-unconfirmed"; requiresConfirmation: boolean; failure?: ChannelStreamFailure };
  runtimeRecovery?: { turnId: string; phase: "recovering" | "restoring" | "waiting" | "recovered" | "deferred" | "unsupported" | "failed" | "cancelled";
    attempts: number; message: string; updatedAt: number };
};

export function followSyncFailure(error: unknown): FollowSyncFailure {
  if (error instanceof CodexCommunicationError) return error.code === "timeout"
    ? { code: "timeout", message: "读取 Codex 当前状态超时；原任务与绑定未改变，跟随继续等待可信状态。" }
    : { code: "connection", message: "Codex 状态读取连接中断；原任务与绑定未改变，跟随继续等待连接恢复。" };
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout/i.test(message)) return { code: "timeout", message: "读取 Codex 当前状态超时；请检查对应主机或 Codex App 的连接后重试。" };
  if (/EACCES|EPERM|permission denied|forbidden|unauthorized|access denied/i.test(message)) return { code: "permission", message: "读取 Codex 状态被拒绝；请检查对应主机或后端的访问权限。" };
  if (/ECONN|ENOTFOUND|EHOST|EPIPE|socket.*(?:closed|missing)|connection.*(?:closed|refused|failed)|SSH.*(?:failed|exit)/i.test(message)) return { code: "connection", message: "Codex 状态读取连接不可用；请检查本机 App、对应远程主机或 SSH 连接。" };
  return { code: "backend", message: "无法读取 Codex 当前状态；请检查对应后端连接，详细诊断见本机服务日志。" };
}

export function formatFollowStatus(state: SessionFollowStatus): string[] {
  const labels: Record<SessionFollowStatus["status"], string> = {
    disabled: "已关闭", suspended: "会话已归档，跟随暂停（绑定保留）", pending: "等待首次同步", syncing: "正在同步", synced: "同步成功",
    stale: "同步已过期", unconfirmed: "状态未确认", failed: "同步失败"
  };
  const time = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
  const runtimeLabel = state.status === "synced" ? "已确认状态" : "最近快照状态（不代表当前）";
  return [
    `跟随同步：${labels[state.status]}`,
    ...(state.runtimeRecovery ? [`系统状态恢复：${state.runtimeRecovery.message}`] : []),
    `最后成功同步：${state.lastSyncedAt ? time(state.lastSyncedAt) : "尚未成功同步"}`,
    ...(state.lastAttemptAt ? [`最近尝试：${time(state.lastAttemptAt)}`] : []),
    ...(state.snapshotAt ? [`最近快照读取：${time(state.snapshotAt)}`] : []),
    ...(state.failure ? [`原因：${state.failure.message}（${state.failure.code}）`] : []),
    ...(state.progressDelivery ? [`卡片投递：${({ "create-pending": "创建中", "create-rejected": "尚未创建/创建被拒绝", "create-unconfirmed": "创建结果未知",
      created: "已创建，待投递", "delivery-pending": "投递中", "delivery-rejected": "投递被拒绝，可重试原实例", "delivery-unconfirmed": "已创建，投递结果未知",
      delivered: "已确认投递", "legacy-unconfirmed": "旧记录缺少分阶段回执" })[state.progressDelivery.stage]}`,
      ...(state.progressDelivery.failure ? [`渠道错误：${state.progressDelivery.failure.operation} / ${state.progressDelivery.failure.code}${state.progressDelivery.failure.httpStatus ? ` / HTTP ${state.progressDelivery.failure.httpStatus}` : ""}`] : []),
      ...(state.progressDelivery.requiresConfirmation ? [copyableChoices("未自动重发未知投递。仅在接受可能重复通知的风险后重试原实例。", [{ label: "确认重试未知投递（可能重复通知）", value: "/follow sync --retry-delivery" }])] : [])] : []),
    ...(state.resultDelivery?.pending ? [`最终答复投递：${state.resultDelivery.pending} 轮待送达；任务完成不等于回答已送达`]
      : state.resultDelivery?.lastDeliveredTurnId ? ["最终答复投递：已确认送达"] : []),
    ...(state.resultDelivery?.deferred ? [copyableChoices(`其中 ${state.resultDelivery.deferred} 轮为未建立卡片的历史答复，已保留，不自动补发新消息。`, [{ label: "查看结果历史", value: "/history" }, { label: "查看更早结果", value: "/history more" }])] : []),
    ...(state.runtime?.activeFlags.includes("waitingOnApproval") ? [`${runtimeLabel}：等待审批`]
      : state.runtime?.activeFlags.includes("waitingOnUserInput") ? [`${runtimeLabel}：等待用户确认`]
      : state.runtime ? [`${runtimeLabel}：${({ active: "正在执行", idle: "空闲", notLoaded: "未加载，无法确认执行状态", unknown: "未知", systemError: "系统错误" })[state.runtime.runtimeStatus]}`] : []),
    ...(state.presentation === "updated" ? ["进度呈现：已更新当前卡片"]
      : state.presentation === "text-only" ? ["进度呈现：渠道原生文本；未补发历史进展"]
      : state.presentation === "off" ? ["进度呈现：已关闭；保留最终结果同步"] : [])
  ];
}
