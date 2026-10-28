# 消息渠道与任务通知配置

[中文](#中文) | [English](#english)

## 中文

所有渠道都在 Codex IM Gateway 本机管理页 `http://127.0.0.1:8787` 的“账号”页面添加。凭据只保存在私有状态目录（新安装默认 `~/.codex-im-gateway/`），管理 API 不会把 Secret 或 Token 返回给浏览器。

### 个人微信

1. 点击“添加渠道”，选择“个人微信（扫码）”。
2. 点击“扫码登录”，使用微信扫描二维码并在手机上确认。
3. 从需要使用 Codex 的微信联系人发送一条消息。
4. 回到管理页，在待授权联系人中明确允许该联系人。

个人微信不需要在其他后台配置。登录失效后重新扫码会刷新凭据，并保留本机备注、授权和会话；移除账号时可以选择保留历史。

### 企业微信

1. 在企业微信客户端的“工作台”中创建智能机器人，并选择 API 模式。
2. 启用长连接，复制机器人页面提供的 Bot ID 和 Secret。
3. 在管理页选择“企业微信智能机器人”，填写备注名称、Bot ID 和 Secret 后连接。
4. 向机器人发送一条消息，让服务登记可用于通知的会话或用户 ID。

- [打开企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame#apps)
- [企业微信智能机器人长连接文档](https://developer.work.weixin.qq.com/document/path/101463)

### 飞书

1. 在飞书开放平台创建企业自建应用并启用机器人能力。
2. 在“凭证与基础信息”中复制 App ID 和 App Secret。
3. 在“事件与回调”中选择长连接接收事件，并添加消息接收事件。
4. 发布应用，在管理页选择“飞书自建应用”，填写凭据后连接。
5. 向机器人发送一条消息，让服务登记可用于通知的会话或用户 ID。

飞书消息与卡片回调会分别保留“操作人”和“回复会话”。请在 Bridge 管理页明确允许具体飞书用户，或明确允许一个会话 ID；允许会话 ID 表示群成员可进入该聊天的准入范围；实际操作仍按各人的 viewer / participant / controller 角色检查，不授予所有成员相同控制权，也不构成个人 Web IDE 配对资格。服务不会因收到一条新消息而自动授权操作人或群聊。

- [打开飞书开发者后台](https://open.feishu.cn/app)
- [飞书长连接事件订阅文档](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)

### 钉钉

1. 在钉钉开放平台创建企业内部应用，并在“凭证与基础信息”复制 Client ID（AppKey）和 Client Secret。
2. 为应用添加机器人能力，消息接收模式选择 Stream 模式并发布应用。
3. 如需流式 AI Card，在钉钉卡片平台创建一个含 Markdown 文本字段的模板，并复制模板 ID 与内容字段名（例如 `content` 或 `msgContent`）。
4. 在管理页选择“钉钉企业内部应用”，填写备注、Client ID、Client Secret，以及可选的 AI Card 模板 ID 后连接。网络协议可选“自动”“IPv4”或“IPv6”。
5. 把机器人加入目标群或发起单聊，再发送一条消息以登记 conversation ID 和临时回复通道。

每次启动钉钉监听后，首条通过去重的有效回调会在本机服务日志中输出一次 `DingTalk callback identity`，仅包含账号 ID、`source: "callback"` 和原始 `robotCode`。字段缺失时记录 `null`，不会以配置中的 Client ID 代替；空字符串原样记录。该诊断不记录消息正文、用户身份、Webhook、Token 或 Secret，也不会逐条刷日志。它用于核对回调实际携带的机器人标识，不代表机器人已获得加群权限。

钉钉消息会把真实操作人作为授权身份、conversation ID 作为回复和 session 作用域；因此同一群聊会复用同一组选中项目和活动会话。文本命令 `/sessions`、`/session R1`、`/new` 和 `/stop` 与其他渠道完全一致。`picture` 和含图片的 `richText` 消息会通过 `/v1.0/robot/messageFiles/download` 换取临时下载地址，保存到账号独立的入站目录并作为图片附件交给当前 Codex session；下载失败会直接在原会话提示。Bridge 收到消息后会调用机器人表情接口，在原消息上贴 `🤔思考中`，处理完成或失败后自动撤回；表情接口失败只写本机告警，不影响主流程。配置模板后，Bridge 使用钉钉 OpenAPI 创建并投放 `callbackType: STREAM` 的 AI Card，以 500 ms 节流显示当前思考描述、最近命令/工具/文件步骤、可读 reasoning summary、累计用时和回答预览，最终以 `isFinalize: true` 关闭；原始隐藏推理不会发送到渠道。网络协议由独立的生命周期传输层管理：“自动”只允许在本轮首个请求被接受前尝试 IPv4/IPv6，一旦确定，图片、思考表情、卡片进度、最终帧和错误帧都会固定使用同一协议；显式选择 IPv4 或 IPv6 时完全不回退。已接受的 Agent 任务没有总时长上限，会运行到完成、主动停止或底层连接中断。原生进度卡创建、投递或更新失败保留原检查点，不自动改发文本；未知创建/投递回执不重发，已知卡片仅按恢复策略更新原实例。明确拒绝创建的一次性命令卡可以使用自己的文字回退策略。没有配置模板时仍沿用临时 `sessionWebhook`，服务重启或地址过期后需先再发一条消息。

钉钉现在支持把 Gateway 本机文件作为机器人文件消息发送到当前群聊或私聊，不需要 AI Card 模板。可以在对话中要求“把生成的文件发给我”；后端产生统一 `send` 文件动作后，Gateway 负责上传和发送。单文件需非空、不超过 20 MiB；远程主机的文件须先传到 Gateway 所在电脑。原文件名和内容保持不变，不会把 `.crt` 等文件伪装成其他类型；最终是否接受由钉钉的文件类型、大小和企业安全策略决定。

请确保应用具备媒体上传与机器人群聊/单聊发送接口所需权限，接收人处于应用可见范围，群聊中已加入机器人。上传失败、无效接收人、限流、缺少回执会明确提示，不能仅凭“HTTP 200”认定发送成功。超时或网络中断后不会自动重发，请先检查原会话。文件上传和发送沿用本轮固定的 IPv4/IPv6；单步网络超时不会改变 Agent 长任务本身的时长策略。钉钉已支持入站普通文件；出站图片/视频/音频仍未实现。

文件优先使用当前有效会话回复，过期或不可用时才使用主动发送接口。如果遇到 `chatbotId.notAllow.sendOTO`，含义是机器人主动私聊发送被拒绝，不是文件后缀有问题。请先向机器人重新发送一条消息，再要求发送文件，Gateway 会使用新的会话回复地址。长期无人交互的主动文件推送还需要检查开发者后台的机器人启用/发布状态和主动单聊能力。无论是哪种发送路径，返回结果不明时都不会自动换接口重发。

AI 任务卡首屏固定显示图形与状态文字，进展正文不会顶替状态：执行中、等待回答/审批、恢复中、状态待确认，以及已完成/失败/中断。原生渐变边框表示卡片流式通道尚未结束，不替代任务状态；阶段切换和解绑也不冒充任务完成。原生动效须由 AI 模板启用，Gateway 不发送逐帧假动画。状态、分页和重启恢复的设计见[任务卡状态说明](task-card-status.md)。

- [打开钉钉开发者后台](https://open-dev.dingtalk.com/)
- [钉钉 Stream 模式官方教程](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/overview)

### 项目任务通知

1. 先向企业微信、飞书或钉钉机器人发送一条消息，再从账号卡片复制最近使用的会话 ID；个人微信使用对应的用户 ID。
2. 在“账号”或“会话”页面找到项目，点击铃铛按钮。
3. 开启“任务结束时通知”，选择通知渠道并填写接收会话或用户 ID。
4. 保存后，项目名称旁会显示“通知已开启”，铃铛按钮显示为绿色。

服务会监听该项目下由聊天端、Web 和 Codex Desktop 发起的任务。任务成功、失败或中断时都会发送项目、任务和结果摘要。页面中的任务数量只表示当前正在运行的任务；完成后任务会从运行列表移除。

### Webhook 镜像

每个渠道账号都可以点击铅笔按钮打开“渠道设置”，选择通知平台并配置一个独立的 HTTP 或 HTTPS Webhook。配置后，每条成功收取或发出的渠道消息都会额外发送一次 `POST`；清除配置后立即停止推送。Webhook 请求最多等待 5 秒、不会重试，失败只记录本机警告，不阻塞原渠道的收发消息。

可选平台包括：

- **通用 JSON**：发送下方完整的 `channel.message` 事件，适合自建服务；
- **企业微信机器人**：发送 `msgtype: "text"`；
- **飞书 / Lark 机器人**：发送 `msg_type: "text"`；
- **钉钉机器人**：发送 `msgtype: "text"`；
- **Slack Incoming Webhook**：发送 `text`；
- **Discord Webhook**：发送 `content`。

旧配置没有保存平台类型时，会根据企业微信、飞书/Lark、钉钉、Slack 或 Discord 的官方 Webhook 域名自动识别；无法识别的地址继续使用通用 JSON。

管理 API 和页面只显示配置状态和平台类型，不会回显可能包含签名密钥的完整地址。所有请求使用 `Content-Type: application/json`。通用 JSON 的消息附件只包含类型和文件名，不包含渠道 Token、上下文 Token 或原始加密附件字段：

```json
{
  "schemaVersion": 1,
  "event": "channel.message",
  "occurredAt": "2026-08-04T12:00:00.000Z",
  "account": { "id": "account-one", "channel": "weixin" },
  "message": {
    "direction": "inbound",
    "id": "message-id",
    "senderId": "sender-id",
    "text": "消息内容",
    "attachments": [{ "kind": "image", "label": "photo.png" }]
  }
}
```

出站消息使用 `direction: "outbound"` 和 `recipientId`。`channel` 的值为 `weixin`、`wecom`、`feishu` 或 `dingtalk`。

### 运行审批

从个人微信、企业微信、飞书或钉钉发起的 Codex 任务需要运行命令、修改文件或申请额外权限时，审批请求会自动发送到发起任务的同一渠道账号和联系人。审批消息包含独立的 `A编号`、操作内容、工作目录和原因：

- `/approve A1` 或 `/ok A1`：批准一次；
- `/reject A1` 或 `/no A1`：拒绝；
- 只有一个待审批请求时可以省略编号；
- 10 分钟未回复、消息发送失败或任务已结束时自动拒绝。

审批只对原账号和原联系人有效，不能从另一个微信账号、企业微信会话、飞书用户或钉钉用户代为批准。审批能力依赖 Codex app-server；带审批的任务不会降级到非交互式 `codex exec`。

## English

Add all channels from the Codex IM Gateway **Accounts** page at `http://127.0.0.1:8787`. Credentials stay in the private state directory (new installations default to `~/.codex-im-gateway/`); the management API never returns secrets or tokens to the browser.

### Personal WeChat

Select **Add Channel → Personal WeChat**, scan the QR code, send one message, and explicitly authorize the pending sender in the console. Re-scanning refreshes expired credentials while preserving local authorization and sessions.

### Enterprise WeChat

Create a smart bot in API mode from the Enterprise WeChat client, enable long connection, and enter its Bot ID and Secret in the console. Send the bot one message so the service can record a recipient ID.

- [Enterprise WeChat admin console](https://work.weixin.qq.com/wework_admin/frame#apps)
- [Official smart-bot long-connection documentation](https://developer.work.weixin.qq.com/document/path/101463)

### Feishu

Create a custom app, enable its bot, configure message events over long connection, publish the app, and enter its App ID and App Secret in the console. Send the bot one message so the service can record a recipient ID.

Feishu messages and card callbacks keep the human actor separate from the reply conversation. Explicitly allow either a user or a conversation in the Bridge console. Allowing a conversation grants every member of that chat the same Bridge and Taskboard authority; receiving a message does not auto-authorize its actor or chat.

- [Feishu developer console](https://open.feishu.cn/app)
- [Official long-connection event documentation](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=en-US)

### DingTalk

Create an internal app in the DingTalk developer console, add a bot using Stream mode, and optionally create an AI Card template with a Markdown field. Enter the Client ID, Client Secret, optional template ID, and the template's content field name (for example `content` or `msgContent`) in Bridge. The account can use automatic, IPv4-only, or IPv6-only networking. Automatic mode may probe both families only before the first accepted request; it then pins that family for inbound media, the thinking emotion, all card updates, and the terminal frame until the turn ends. Explicit IPv4 or IPv6 never falls back mid-turn. `picture` messages and image-bearing `richText` messages are resolved through the robot message-file download API, stored in the account inbound directory, and attached to the active Codex session; download failures are reported in the originating conversation. Bridge attaches a `🤔 Thinking` emotion to the original inbound message while processing and recalls it on completion; emotion failures remain non-blocking. With a template, progress and answer deltas stream into one card and finalize at completion. Progress-card failures retain the checkpoint and never automatically resend as text; unknown create/delivery receipts are not replayed. A rejected one-shot command card has its own text fallback policy. DingTalk text commands reuse the same `/sessions`, `/session R1`, and `/new` router as every other channel.

Without AI Card, the session Webhook stays in process memory only. After a service restart or Webhook expiry, send the bot another message before expecting text fallback replies.

The first valid, non-duplicate callback after each DingTalk monitor start writes one local `DingTalk callback identity` diagnostic with only the account ID, `source: "callback"`, and the raw `robotCode`. A missing code is logged as `null`, never replaced by the configured Client ID; an empty string is preserved. No message content, user identity, Webhook, token, or secret is logged. This identifies the actual callback value, not permission to add the bot to a group.

- [DingTalk developer console](https://open-dev.dingtalk.com/)
- [Official DingTalk Stream tutorial](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/overview)

### Project task notifications

Open a project's bell menu, enable completion notifications, select a channel, and enter the recorded conversation or user ID. A green bell and enabled badge confirm the setting. Tasks started from chat, Web, or Codex Desktop send a summary after success, failure, or interruption.

### Webhook mirroring

Open a channel's pencil **Channel Settings** action, select Generic JSON, Enterprise WeChat, Feishu/Lark, DingTalk, Slack, or Discord, then configure an independent HTTP or HTTPS Webhook. Every successfully received or sent channel message is mirrored once using the selected provider's JSON shape; clearing the setting stops delivery immediately. Requests time out after five seconds and are not retried. Delivery failures produce a local warning but never block the original channel message.

The console and management API expose only the configured status and provider, never the potentially secret-bearing URL. Generic payloads use the `channel.message` schema shown in the Chinese section above. Inbound messages contain `senderId`; outbound messages contain `recipientId`. Attachments include only `kind` and `label`, without channel tokens, context tokens, or raw encrypted attachment fields. Legacy settings without a provider are auto-detected from known official Webhook hosts and otherwise remain Generic JSON.

### Runtime approvals

When a task started from personal WeChat, Enterprise WeChat, Feishu, or DingTalk asks to run a command, change files, or obtain additional permissions, the request returns to that same channel account and sender. Use `/approve A1` or `/ok A1` to approve once, and `/reject A1` or `/no A1` to decline. The ID may be omitted when exactly one request is pending. Requests time out safely after ten minutes and are isolated from every other account and sender. This flow requires Codex app-server and does not fall back to non-interactive `codex exec`.
