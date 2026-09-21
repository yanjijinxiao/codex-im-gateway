import { constants } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PinnedNetworkLifecycleTransport } from "./network-family.js";

// A bounded Gateway upload budget, not a promise that every tenant/type is accepted.
export const DINGTALK_MAX_OUTBOUND_FILE_BYTES = 20 * 1024 * 1024;

export type DingTalkProactiveFileTarget =
  | { readonly type: "group"; readonly conversationId: string }
  | { readonly type: "user"; readonly staffId: string };

export type DingTalkFileTarget = DingTalkProactiveFileTarget | {
  readonly type: "session";
  readonly webhookUrl: string;
  readonly expiresAt: number;
  readonly proactiveTarget?: DingTalkProactiveFileTarget;
};

type FileSendInput = {
  readonly path: string;
  readonly robotCode: string;
  readonly target: DingTalkFileTarget;
  readonly lifecycleId: string;
  readonly getAccessToken: () => Promise<string>;
};

/** Upload and delivery share the caller's turn-scoped, address-family-pinned transport. */
export class DingTalkFileClient {
  constructor(
    private readonly transport: PinnedNetworkLifecycleTransport,
    private readonly maxBytes = DINGTALK_MAX_OUTBOUND_FILE_BYTES,
    private readonly timeoutMs = 60_000,
    private readonly now = Date.now
  ) {}

  async send(input: FileSendInput): Promise<{ messageId: string }> {
    this.resolveRoute(input.target); // Fail before reading/uploading when there is no usable destination.
    if (!input.robotCode.trim()) throw new Error("钉钉文件接收目标不完整，请重新向机器人发送一条消息");
    const bytes = await readLocalFile(input.path, this.maxBytes);
    const fileName = path.basename(input.path);
    const extension = path.extname(fileName).slice(1).toLowerCase();
    const fileType = /^[a-z0-9]{1,20}$/.test(extension) ? extension : "file";
    let accessToken: string;
    try {
      accessToken = (await input.getAccessToken()).trim();
      if (!accessToken) throw new Error();
    } catch {
      // SDK errors can include credentials/request configuration. Never forward them.
      throw new Error("钉钉文件发送：访问令牌获取失败，请检查机器人配置");
    }

    const uploadUrl = new URL("https://oapi.dingtalk.com/media/upload");
    uploadUrl.searchParams.set("access_token", accessToken);
    uploadUrl.searchParams.set("type", "file");
    const form = new FormData();
    form.append("media", new Blob([bytes], { type: "application/octet-stream" }), fileName);
    // The pinned HTTPS transport accepts bytes, not FormData. Let the runtime
    // encode multipart boundaries and filenames, then pass its exact bytes/headers.
    const multipart = new Request(uploadUrl, { method: "POST", body: form });
    const multipartBytes = new Uint8Array(await multipart.arrayBuffer());
    const headers = new Headers(multipart.headers);
    headers.set("Content-Length", String(multipartBytes.byteLength));
    const uploaded = await this.request(input.lifecycleId, uploadUrl, {
      method: "POST",
      headers,
      body: multipartBytes
    }, "上传", accessToken);
    if (String(uploaded.errcode) !== "0" || typeof uploaded.media_id !== "string" || !uploaded.media_id.trim()) {
      throw new Error("钉钉文件上传未返回有效 media_id，未发送文件消息");
    }

    const file = { mediaId: uploaded.media_id, fileName, fileType };
    // Upload can take time: re-check expiry before the first delivery attempt.
    // Never switch endpoints after an uncertain delivery (timeout/missing ack).
    const route = this.resolveRoute(input.target);
    if (route.type === "session") {
      const result = await this.request(input.lifecycleId, new URL(route.webhookUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": accessToken },
        body: JSON.stringify({ msgtype: "file", file })
      }, "会话回复", accessToken);
      // sendBySession can return only {errcode:0, errmsg:"ok"}; that is an
      // explicit acknowledgement, unlike an empty/HTTP-200-only response.
      if (result.errcode === undefined || String(result.errcode) !== "0") {
        throw new Error("钉钉文件会话回复未返回成功确认，结果无法确认；未自动重发，请先检查会话");
      }
      const key = typeof result.processQueryKey === "string" ? result.processQueryKey.trim() : "";
      // This is a local delivery receipt, NOT a provider message ID for recall.
      const receipt = key || `dingtalk-file-receipt:${createHash("sha256")
        .update(JSON.stringify([input.lifecycleId, file])).digest("hex")}`;
      return { messageId: receipt };
    }

    const group = route.type === "group";
    const recipient = route.type === "group" ? route.conversationId : route.staffId;
    const delivered = await this.request(input.lifecycleId, new URL(group
      ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
      : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": accessToken },
      body: JSON.stringify({
        robotCode: input.robotCode,
        msgKey: "sampleFile",
        msgParam: JSON.stringify(file),
        ...(group ? { openConversationId: recipient } : { userIds: [recipient] })
      })
    }, "发送", accessToken);

    if (!group) {
      for (const [field, reason] of [
        ["invalidStaffIdList", "接收人的员工 ID 无效"],
        ["filteredStaffIdList", "接收人被钉钉过滤，请检查应用可见范围"],
        ["flowControlledStaffIdList", "接收人触发钉钉限流，请稍后重试"]
      ] as const) {
        if (Array.isArray(delivered[field]) && delivered[field].length) {
          throw new Error(`钉钉文件发送失败：${reason}`);
        }
      }
    }
    if (typeof delivered.processQueryKey !== "string" || !delivered.processQueryKey.trim()) {
      throw new Error("钉钉文件发送未返回有效回执，结果无法确认；未自动重发，请先检查会话");
    }
    return { messageId: delivered.processQueryKey.trim() };
  }

  private resolveRoute(target: DingTalkFileTarget): DingTalkFileTarget {
    if (target.type === "session") {
      let url: URL;
      try { url = new URL(target.webhookUrl); } catch { throw new Error("钉钉文件会话回复地址无效"); }
      if (url.protocol !== "https:" || url.hostname !== "oapi.dingtalk.com"
        || url.port || url.username || url.password || url.hash
        || url.pathname !== "/robot/sendBySession" || !url.searchParams.get("session")?.trim()) {
        throw new Error("钉钉文件会话回复地址无效");
      }
      if (!Number.isFinite(target.expiresAt)) throw new Error("钉钉文件会话回复有效期无效，请重新发送消息");
      if (target.expiresAt > this.now()) return target;
      if (target.proactiveTarget) return this.resolveRoute(target.proactiveTarget);
      throw new Error("钉钉文件会话回复已过期，且没有主动发送目标，请重新向机器人发送一条消息");
    }
    const recipient = target.type === "group" ? target.conversationId : target.staffId;
    if (!recipient.trim()) throw new Error("钉钉文件接收目标不完整，请重新向机器人发送一条消息");
    return target;
  }

  private async request(
    lifecycleId: string, url: URL, init: RequestInit, phase: "上传" | "发送" | "会话回复", accessToken: string
  ): Promise<Record<string, unknown>> {
    let response: Response;
    let body: Record<string, unknown>;
    try {
      response = await this.transport.request(lifecycleId, url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      // In particular, do not leak the old upload API's access_token query.
      throw new Error(`钉钉文件${phase}网络异常或超时，结果无法确认；未自动重发，请先检查会话`);
    }
    try {
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      body = data as Record<string, unknown>;
    } catch {
      throw new Error(`钉钉文件${phase}返回无效响应（HTTP ${response.status}），结果无法确认；未自动重发`);
    }
    const failedCode = body.errcode !== undefined && String(body.errcode) !== "0" ? body.errcode
      : body.code !== undefined && String(body.code) !== "0" ? body.code : undefined;
    if (!response.ok || failedCode !== undefined || body.success === false) {
      const code = safeErrorCode(failedCode, [accessToken, url.searchParams.get("session")]);
      if (phase === "发送" && code === "chatbotId.notAllow.sendOTO") {
        throw new Error("钉钉拒绝机器人主动私聊发送（code chatbotId.notAllow.sendOTO）。请重新向机器人发一条消息后再要求发送文件，以使用当前会话回复；长期主动推送需检查开发者后台的机器人启用/发布状态及主动单聊能力。这不是文件格式错误。");
      }
      throw new Error(`钉钉文件${phase}失败（HTTP ${response.status}${code ? `，code ${code}` : ""}）；请检查机器人权限、接收范围及文件类型/大小限制`);
    }
    return body;
  }
}

function safeErrorCode(value: unknown, secrets: readonly (string | null)[]): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const code = String(value);
  return code.length <= 80 && /^[a-zA-Z0-9_.-]+$/.test(code)
    && !secrets.some(secret => secret && code.includes(secret)) ? code : undefined;
}

async function readLocalFile(filePath: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!path.isAbsolute(filePath)) throw new Error("钉钉文件发送需要本机绝对路径");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("钉钉文件大小限制配置无效");
  let handle;
  try {
    // O_NONBLOCK prevents a named pipe from hanging before the regular-file check.
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new Error("钉钉待发送文件不存在或无法读取；远程任务的文件需要先传到 Gateway 所在电脑");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("钉钉只能发送普通文件，不能发送目录或设备");
    if (stat.size === 0) throw new Error("钉钉不能发送空文件");
    if (stat.size > maxBytes) throw new Error(`钉钉文件超过 Gateway 上传上限 ${maxBytes} 字节`);
    // Bound the read even if the file grows after stat; do not readFile unbounded.
    const bytes = new Uint8Array(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size || (await handle.stat()).mtimeMs !== stat.mtimeMs) {
      throw new Error("待发送文件仍在写入，请等文件生成完成后重试");
    }
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
