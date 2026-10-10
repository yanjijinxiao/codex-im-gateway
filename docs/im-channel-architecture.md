# IM 渠道架构

Gateway 有两个相互独立的适配维度：IM 渠道负责输入和呈现，Codex 后端负责项目、会话与执行。选择钉钉、微信或飞书，不会改变 Codex CLI / App 后端的路由规则，也不会改变新会话的项目归属规则。

## 统一入口与职责

- `src/channels/factory.ts`：唯一的生产渠道分发入口，创建微信、钉钉、飞书或企业微信适配器。AccountManager 对所有渠道调用同一个 `monitor`，不再单独启动微信轮询。
- `src/channels/message.ts`：统一消息信封。`senderId` 必须是发言人，`replyTargetId` 是回复目标/群聊；权限检查不得把群当成人。渠道原始数据 `raw` / `item` 只由对应适配器解释。
- `src/channels/types.ts`：完整 `ChannelClient` 契约，包括文本、附件、卡片、进度和输入状态；`ChannelAdapter` 另负责监控、去重认领、检查点与连接状态。
- `src/channels/client.ts`：能力检查、回执校验、卡片降级为分段文字、下载后文件的真实路径和大小校验。不可用操作抛出明确的能力错误，不用缺少某个函数表示支持情况。
- `src/channels/progress.ts`：统一的每轮进度生命周期，直接执行和跟随已有 session 共用。每轮开始时固定呈现方式：可编辑渠道复用原卡片，创建或更新失败不会自动切换为文字进度；纯文本渠道走 `text-progress.ts`，按 30 秒窗口合并、去重，只保留最近 3 条简短进展，每条最多 180 字符。`progress-summary.ts` 将工具命令转换成操作类别与数值结果，不展示 shell 源码、路径和参数；公开 commentary 保留。思考摘要更新卡片当前状态，不逐条另发消息。完成/失败会清理定时器并等待已开始的发送结束，避免最终答案后继续冒出旧进度。
- `src/bridge/service.ts`：只处理权限、命令、会话、任务和渠道中立的回复；不再调用微信上传、下载或解密 API。

命令侧默认使用 `BridgeService({ channel: adapter.client, ... })`。新增 IM 时不应在 BridgeService 或 Codex runner 中增加渠道分支。

## 显式能力

每项功能分别声明 `available`（适配器已实现且具备必要配置）、`not-configured`（缺配置）、`not-implemented`（该实现尚未提供）或 `unsupported`（明确不支持）。`available` 不代表凭证/权限已经在线验证成功。

以下是当前代码实现范围，不是各平台的理论能力上限：

| 能力 | 微信 | 钉钉 | 飞书 | 企业微信 |
| --- | --- | --- | --- | --- |
| 接收文字 | 支持 | 支持 | 支持 | 支持 |
| 接收附件 | 图片、文件、视频、音频 | 图片、富文本中的图片 | 图片 | 未实现 |
| 发送附件 | 图片、文件、视频 | 文件 | 图片 | 未实现 |
| 每轮进度 | 合并文字 | 已配置模板时 AI Card，否则合并文字 | 合并文字 | 合并文字 |
| 选择/表单/任务卡片 | 命令文字降级 | 命令文字降级 | 原生交互卡片 | 命令文字降级 |
| 会话表格 | 紧凑文字列表 | 配置 AI 模板时 Markdown 表格，否则紧凑列表 | Card JSON 2.0 原生表格 | 紧凑文字列表 |
| 输入/处理标志 | typing | 原生思考表情由适配器按入站消息生命周期处理 | 未实现 | 未实现 |

`sendMedia` 接受统一附件种类；不可用时明确提示，而不是偷偷把本地路径当成已发送的文件。钉钉和飞书接收到尚未实现的消息类型时，交给 Gateway 完成权限检查后提示用户，不再直接静默丢弃。

附件发送只由显式 `codex-im-gateway-actions` 的 `send` 动作触发，兼容旧动作块名称。普通 Markdown 本地文件链接（包括图片和视频）不隐式上传：统一回复解析层将其保留为标签与路径引用，保留行号及所在行的说明文字。CLI / App 后端、各 IM 和 Web 历史共用这条规则；历史中的源码引用也不会生成失效附件。需要实际发送文件时必须输出显式动作块，远程源码引用不要求文件存在于 Gateway 本机。

微信加密附件由 `WeixinChannelAdapter` 调用原有媒体模块解析；其他渠道不再通过微信媒体客户端的函数形状来识别发送方式。文件进入 Codex 前统一检查真实路径、符号链接越界、普通文件类型与大小。

## 表格与列表呈现

`ChannelActionCard.table` 承载渠道中立的行列数据；`tableLayout` 显式声明 `native / markdown / list`。核心命令不按 IM 名称分支，不把同一段 Markdown 当作所有渠道都能渲染的表格。表格能力独立于按钮能力：钉钉现有 AI 模板显示表格，但仍通过 `/session R1` 选择，不宣称提供原生选择按钮。

`/sessions` 默认每页 30 行，103 条会话显示为 4 页；`/sessions size 50` 可调整为 5-50 行，按账号、聊天、发言人持久保存。大小仅影响展示，不限制后端发现数量。有效快照内改变条数保留原来的排序、筛选和 R 编号，并定位到包含原页首的页面。

先对整个快照按项目分组排序，再分页：当前项目优先，其余项目按名称自然排序（例如 2 在 10 前），组内按最近更新时间倒序，无项目会话最后。同名项目用短编号和主机区分；项目名称来自当前后端目录，读取名称不会触发注册或绑定。组身份包含主机，App 严格使用原生 `projectId`，不会将同目录的独立会话塞进项目；CLI 适配器提供只用于展示的 `workspaceProjectId`，对应自身工作目录目录项，不改变原生 `projectId` 或 `unassigned` 的含义。分组信息随 15 分钟快照固定，跨页、修改条数或查看详情均不重新排序。

总览只显示编号、会话、归属和状态；纯文字渠道每项一行，去掉重复字段标签及段间空行，客户端自然折行。飞书将大页分为多个最多 10 行的原生表格组件，仍在同一张消息卡片内完整发送，不引入额外 Gateway 页。标题按 Unicode 字素截断，Markdown 单元格转义换行、竖线、标签和链接语法；ID、目录、主机及更新时间放在只读的 `/sessions detail R1` 中。详情和切换共用账号/发言人隔离的 15 分钟编号快照；翻页不改变编号，查看详情不改变绑定。纯文字超长时沿用渠道分片发送，不静默丢弃后半页。

- 钉钉：既有 AI 模板发送已完成的 Markdown 表格，保留表头前空行和行间换行；创建失败时改发紧凑列表，不把 Markdown 表格源码交给普通文本 webhook。参考[官方连接器的表格渲染说明](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/releases/tag/v0.7.8)。
- 飞书：有表格的选择卡片使用 Card JSON 2.0 原生 `table`，普通卡片保留既有格式；按钮携带原始 host + thread ID，发送、更新和回调均保留业务错误检查。参考[表格组件](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table)。原生发送失败可按既有策略降级为文字。
- 微信、企业微信：当前适配器走一行一项、自然折行的紧凑列表，不用空格伪造等宽列，也不发送原始 Markdown 表格。此为当前接口实现范围，不是平台所有产品的能力判断。

自动测试验证结构化数据、各渠道载荷、分页、转义、只读详情与降级；不等同于所有手机端版本的实际渲染验收。

## 发送结果与失败

返回回执只表示渠道 API 已确认请求，不保证手机端已经渲染成功。飞书发送和卡片更新必须检查业务 `code`；不能把 HTTP 200 或随机 UUID 当成成功。

普通选择、表格等一次性卡片降级成多条文本时，回执包含实际成功的分段。中途失败会报告已发送分段，不自动从头重发，从而避免重复刷屏。这与每轮进度卡是两条独立路径：进度卡没有自动文字降级，终态更新失败时保留原卡片及最终载荷。

### 进度呈现与恢复契约

- `sendText` 发送普通消息，允许渠道选择一次性卡片呈现；`startTextStream / updateTextStream` 创建、更新和关闭同一轮的可更新卡片；`sendProgressText` 明确发送普通文字，仅用于原生纯文本进度或一次终态送达失败提示，不能再次转换为新卡片。钉钉的普通文字接口直接使用已建立的会话 webhook。已有卡片的检查点恢复后仍使用原卡，不因当前配置变化切换为文字进度。
- `ChannelProgressError` 提供 `retryable`、可选 `retryAfterMs`、已确认的 `messageId` 及适配器显式标注的 `recoveryProbe`。能力/配置/权限错误停止自动重试；DNS、超时、连接异常、HTTP 408/429/5xx 采用 5、10、20、40、60 秒封顶的退避。钉钉适配器仅将 `IpNotInWhiteList` 标记为路由相关拒绝：通用层只对已有卡片按 30、60、120 秒间隔进行最多 3 次恢复探测，不重建卡、不更换本轮网络协议，不扩大白名单或绕过权限。钉钉 HTTPS 层不对 403 再做即时重试。恢复策略在通用层，具体 API 调用和错误来源在适配器中。
- 卡片 ID 和每轮 `streamId` 保存在检查点中。重试更新沿用原卡片；重试创建沿用同一逻辑标识。钉钉在创建、投递成功但首帧更新失败时返回携带卡片 ID 的错误，通用层直接恢复更新，不重新创建。
- 断网期间保留最新状态和最近进展，恢复后只更新原卡的当前完整快照。不补发积压摘要，不追加“进度卡不可用”或 `【进展】` 普通消息；永久权限错误停止探测并记录日志。原生纯文本渠道的正常合并进度不属于卡片降级，保持既有呈现方式。
- 终态在等待在途请求前就锁定。失败的终态载荷保留在检查点中，允许原卡片随后关闭；迟到摘要、心跳和连接重试不能恢复“正在思考”。最终答复无法更新原卡时，最多发送一次简短送达失败提示，指引用户查看原 Codex 会话，不另发完整答案或新卡片。提示成功的回执状态持久化，重启后不重复发送。跟随会话的终态重试继续由 `ThreadEventHub.terminalPending` 持久恢复。

恢复日志包含时间、卡片/流标识、阶段、探测次数与退避时间，不包含原始异常正文、命令或凭证。回归覆盖临时故障后恢复原卡、创建首帧失败、IP 白名单恢复与探测上限、永久权限拒绝不追加进度、原生纯文本合并、长命令摘要、终态送达失败提示去重、结束与创建/发送并发、结束后迟到事件及服务重启。测试使用本地模拟 API，不代表真实账号权限与客户端渲染已经验收。

未暴露原始内部推理；进度源仍是可见 commentary、公开摘要和工具状态。

### 钉钉文件发送

`DingTalkChannelAdapter.sendMedia(kind: "file")` 调用独立的 `DingTalkFileClient`；BridgeService、Codex CLI / App 后端和其他 IM 不增加渠道分支。文件不依赖 AI Card 模板，图片/视频/音频的出站能力仍未实现。

- 先检查本机绝对路径、普通文件、非空、未在写入及 Gateway 的 20 MiB 上限，再上传原文件。读取有界，不会因文件增长而无界占用内存；不会修改内容或伪造扩展名。远程文件需先传到 Gateway 所在电脑。
- `POST /media/upload?type=file` 的 multipart 字段为 `media`；使用返回的 `media_id` 和原始文件名/类型发送文件。类型和权限仍可能被平台拒绝，不承诺任意后缀均可发送。
- 优先回复本轮入站消息提供的有效 `sessionWebhook`，载荷为 `{msgtype:"file",file:{mediaId,fileName,fileType}}`，不要求开通主动单聊推送。仅接受 HTTPS 的 `oapi.dingtalk.com/robot/sendBySession` 地址，须含 session 参数，不接受其他域名、端口、URL 用户名/密码。接收目标直接由会话回复地址确定。
- 会话回复缺失或过期时才选主动接口：群聊走 `/v1.0/robot/groupMessages/send` 的 `openConversationId`，私聊走 `/v1.0/robot/oToMessages/batchSend` 的 `userIds`；载荷使用 `sampleFile` 和 `msgParam`。不根据 `cid` 前缀猜类型，不把加密 sender ID 当作 staff ID；没有有效会话回复且私聊缺员工 ID 时先报错，不上传。上传前后均检查有效期，只在尚未尝试投递时换路由，不对拒绝或结果不明的发送自动换接口重发。
- 上传与消息发送复用同一轮的 IPv4/IPv6 生命周期；不在两步之间切换协议。同聊天的新入站消息不能替换前一轮的回复地址或网络生命周期。独立发送使用自己的生命周期并在成功/失败后释放。服务重启后需收到一条消息来确认接收目标。
- 会话回复须明确返回 `errcode:0` 才确认成功；如果没有平台消息 ID，则产生标注为 `dingtalk-file-receipt:` 的本地投递回执，不得用于平台消息撤回。主动接口仍要求 `processQueryKey`，且私聊没有无效/过滤/限流接收人。HTTP 200 不等于成功。网络异常/单步 60 秒超时不自动重发；用户需先确认会话，以免重复发送。
- 失败提示包含上传/发送/会话回复阶段和安全错误码，不回显 access token、session 参数、原始响应内容或 SDK 请求对象。`chatbotId.notAllow.sendOTO` 单独提示主动私聊受限，不能误报文件类型问题。

参考[上传媒体文件](https://open.dingtalk.com/document/orgapp/upload-media-files)、[机器人消息类型](https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-robots)、[群消息接口](https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message)。回归测试 `test/dingtalk-files.test.ts` 覆盖文件字节/名称、群私聊路由、能力声明、大小限制、错误回执、凭证脱敏、网络协议和 Gateway action 到渠道的完整模拟链路；模拟成功不代替真实账号权限与客户端收件验收。

会话文件载荷另核对了 [QwenPaw 的 DingTalk 会话附件实现](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/app/channels/dingtalk/channel.py)（`_send_media_part_via_webhook`）。这提供接口适配依据，不表示所有企业的权限与客户端均已实测。

## 连接、恢复与网络

`monitor` 报告 `connecting / connected / reconnecting / stopped / error`；轮询型渠道用不透明检查点恢复。账号接口同时返回 `connection` 和 `capabilities`。`running` 由适配器就绪信号驱动，不能仅因启动函数被调用就宣称已连接。接收侧短暂重连不会清除任务跟随的卡片与投递游标。

### 钉钉 Stream 连接诊断

`dingtalk-stream-diagnostics.ts` 在 SDK 外记录结构化日志，前缀为 `[codex-im-gateway] DingTalk Stream`。每条包含 UTC 时间、账号 ID、运行标识、连接阶段、尝试/重试次数和阶段耗时；失败只记录白名单错误码、HTTP 状态和错误类别，恢复时补充断线时长及最近连接/收帧时间。SDK 原始 debug 不会开启，配置对象、连接 URL/ticket、回调正文和原始异常对象不会进入新增诊断日志。

- `connect_attempt / endpoint_ready / connected / registered`：连接地址请求、WebSocket 握手、连接成功及注册。
- `connect_failed / retry_scheduled`：记录 SDK 内部吞掉的失败，以及 SDK 实际安排的退避重试。重试仍由 SDK 单独负责，不增加第二套自动恢复循环。
- `socket_closed / server_disconnect / disconnected_without_retry`：区分断开原因与未观察到重连安排，后者显示为 `error`，不再只因 `connected=false` 就宣称正在重连。
- `connection_stalled`：阶段等待超过 30 秒，或超过重试计划时间 30 秒时告警，持续停滞每 60 秒最多记录一次。这是观测阈值，不会中止请求，也不等于已证实网络超时；管理接口返回安全的阶段说明。
- `monitor_stopped`：账号停止时移除健康检查定时器和监听器。初次连接尚未完成也能停止监控，迟到的结果不会重新发布诊断状态。

诊断识别当前 SDK `2.1.6-beta.1` 的固定生命周期消息；升级 SDK 时必须运行 `test/dingtalk-stream-diagnostics.test.ts` 的真实 SDK 重试与本地 WebSocket 断线回归。未知 debug 文本默认丢弃，不能为了诊断打开会输出凭证的 SDK debug。日志不追溯部署前未记录的失败；上线需构建并重启 Gateway。

去重由 AccountManager 提供持久化的 `claimMessage`，适配器在处理同一消息/回调之前认领；长任务仍由统一任务层执行。一次消息接收成功不代表附件下载或后端执行一定成功。

钉钉的现有 IPv4/IPv6 生命周期传输增加了并发协商互斥：同轮多个初始 API 请求只协商一次，接受响应后不再更换协议。本次没有把其他 SDK 的所有网络请求改造成这一传输层。

## 兼容与验证

旧 `weixin` 注入参数和 `NormalizedWeixinMessage` 类型保留为兼容入口，适配逻辑集中于 `channels/legacy.ts`；生产启动使用完整的新接口。旧的账号数据目录和轮询检查点无需迁移，历史 WeChat 提示仍可解析；新钉钉/飞书提示会标注实际来源。

新渠道至少应覆盖：完整方法与能力声明、真实 API 错误、原生/文字降级、发送回执、附件限制、群聊身份隔离、连接失败清理、去重、进度限流与终态收尾。测试入口：`test/channel-adapters.test.ts`、`test/network-family.test.ts` 及已有各渠道和 Gateway 测试。

这里的自动测试使用本地模拟 SDK/API，不向真实 IM 发送消息。真实账号的权限和手机端显示仍需端到端验证。
