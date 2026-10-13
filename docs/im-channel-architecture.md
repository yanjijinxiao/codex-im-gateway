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
| 接收附件 | 图片、文件、视频、音频 | 图片、文件、富文本附件 | 图片、文件 | 未实现 |
| 发送附件 | 图片、文件、视频 | 文件 | 图片 | 未实现 |
| 每轮进度 | 合并文字 | 已配置模板时 AI Card，否则合并文字 | 合并文字 | 合并文字 |
| 选择/表单/任务卡片 | 命令文字降级 | 命令文字降级 | 原生交互卡片 | 命令文字降级 |
| 会话表格 | 紧凑文字列表 | 配置 AI 模板时 Markdown 表格，否则紧凑列表 | Card JSON 2.0 原生表格 | 紧凑文字列表 |
| 输入/处理标志 | typing | 原生思考表情由适配器按入站消息生命周期处理 | 未实现 | 未实现 |

`sendMedia` 接受统一附件种类；不可用时明确提示，而不是偷偷把本地路径当成已发送的文件。钉钉和飞书接收到尚未实现的消息类型时，交给 Gateway 完成权限检查后提示用户，不再直接静默丢弃。

附件发送只由显式 `codex-im-gateway-actions` 的 `send` 动作触发，兼容旧动作块名称。普通 Markdown 本地文件链接（包括图片和视频）不隐式上传：统一回复解析层将其保留为标签与路径引用，保留行号及所在行的说明文字。CLI / App 后端、各 IM 和 Web 历史共用这条规则；历史中的源码引用也不会生成失效附件。需要实际发送文件时必须输出显式动作块，远程源码引用不要求文件存在于 Gateway 本机。

微信加密附件由 `WeixinChannelAdapter` 调用原有媒体模块解析；其他渠道不再通过微信媒体客户端的函数形状来识别发送方式。文件进入 Codex 前统一检查真实路径、符号链接越界、普通文件类型与大小。

### 引用与入站文件

`ChannelMessage.references` 保存被引用的正文、资源和可用状态，和当前消息的命令文本分开。引用中的 `/stop` 等文字不会触发 Gateway 命令。共享客户端只合并一次当前与引用附件，并统一执行能力、数量和文件路径检查。引用原文读取、附件下载均在 Bridge 检查访问权限之后执行。

钉钉解析 `repliedMsg`（包括 JSON 字符串形式的引用正文）和文件 `downloadCode`；微信支持同一条消息同时携带直接媒体与引用媒体；飞书按 `parent_id` 读取原消息，并校验原消息属于当前聊天。飞书读取权限不足、钉钉只有文件名/ID 却没有下载凭据时，明确标记正文不可用；不推测文件内容，也不把文件 ID 当下载码。此前已下载的资源可由账号隔离、聊天隔离的引用缓存补齐；缓存保留 7 天、最多 200 条，剥离下载凭据，文件权限为 0600，重启后仍会重新校验附件路径。

钉钉与飞书下载采用有界流读取，超过 `maxInboundBytes` 就停止，不等完整下载后才检查大小。后端不与 IM 耦合：`CodexBridgeBackend.stageAttachments` 在远端执行前将附件转存到同一 SSH 主机，复用后端路由的 SSH 配置、核对内容摘要、使用隔离目录和非覆盖写入；本地执行沿用校验过的本机文件。普通输入、steer 和原生 queue 共用转存入口；转存失败不会提交无法读取的本机路径。自定义非 SSH 远端传输须实现自己的转存端口，不猜测另一台主机。

### 卡片启动与同步恢复

`ChannelStreamBootstrap` 单独记录实例 ID、目的聊天，以及创建、投递两个阶段。`messageId` 只代表已确认投递的句柄，不能用“创建已尝试”替代；`startTextStream.onBootstrap` 在每一步变更之前持久化，渠道 `resumeTextStream` 只投递已创建的原实例，不调用创建接口。飞书、微信、企业微信尚无该启动恢复能力时显式返回能力错误，既有可更新句柄的恢复路径不变。每个最终回复续页也保留自己的阶段与句柄，不重建整个长答复。

`/follow sync` 恢复明确拒绝或尚未尝试投递的原实例；创建/投递结果未知时保留记录，不盲目重发。控制者可显式使用 `/follow sync --retry-delivery` 确认一次未知投递的重试，沿用原实例与原聊天，可能重复通知；后台轮询、自然语言意图推断及普通同步不会开启该选项。创建结果未知且没有实例回执时仍不能重建卡片。

钉钉适配器只持久化账号隔离的公开路由字段（真实群/单聊类型、目标员工 ID/群 ID、机器人标识），文件权限 0600，不保存 webhook、access token、消息正文。重启不再按 `cid` 前缀推测群类型；路由未确认时先要求用户在原对话发消息，尚未创建的实例可在取得可信路由后安全启动。旧版本孤立记录仅在结构化日志有明确创建/投递成功回执时迁移为已创建/已投递；缺少投递回执保持未知，不触发任何 API 调用或改变绑定。

同步健康与历史结果交付分开：当前运行任务的卡片同步成功，即使旧答复仍待送达，也显示当前同步成功并单独显示待送达数量。旧结果每轮独立恢复，按 60 秒间隔限流，不占当前进度的串行队列；切换/关闭绑定后不继续投递。当前轮次结束但其最终答复未送达，仍显示同步失败。钉钉创建、投递、更新的错误保存明确阶段、白名单错误码、HTTP 状态与请求 ID；投递子结果 `success:false` 是明确拒绝，不误判为缺少回执，原始响应与凭证不写入日志。

回归：`test/stream-bootstrap.test.ts`、`test/session-follow.test.ts` 以及渠道、最终回复生命周期测试。真实未知投递重试需要用户明确确认，模拟通过不等于已验证实际聊天渲染。

### 完整答复分页

`result-pages.ts` 为最终回复和普通长文本提供共享 UTF-8 分页，默认每页不超过 6000 字节（保守的呈现预算，不宣称是平台官方上限）。原文完整保留；跨页代码块补齐显示围栏，表格尽可能重复表头，页码只用于显示。历史查询也走此发送边界，已完成的旧结果不会被自动重发。

卡片终态的第一页更新原进展卡，只有最终长答复才创建必要的续页；每页使用稳定 `streamId` 和持久回执。重启后沿用既有句柄，跳过已确认页，只恢复未确认页，不增加逐条进度消息，不采用文本降级。原生文本发送没有稳定的创建标识时，提交前记录尝试状态；不明回执不会自动重发，可用 `/history` 主动查看完整结果。所有页确认后才将轮次标记送达；部分失败不算整轮成功。钉钉底层不再静默截取前 50000 字符。

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

### 渠道接口校验（2026-10-13）

回执由渠道适配器按平台协议解释，通用层只检查统一回执并管理检查点；不能在 BridgeService 中混入供应商响应字段。

| 边界 | 成功判定与失败行为 | 验证范围 |
| --- | --- | --- |
| 钉钉 AI Card | HTTPS 与 SDK 共用 `dingtalk-card-response.ts`。要求 HTTP 2xx、`success:true` 及操作回执：创建为非空实例 ID，投递为非空且每项成功的数组，更新为 `result:true`。空响应、业务错误或缺字段不算成功。 | 协议及故障模拟；现有账号/模板的单张群卡真实创建、投递、进度、完成链路通过，用户确认完整正文可见 |
| 钉钉会话文字/文件 | 要求 `errcode:0`；没有平台消息 ID 时仅在成功后生成明确标注的本地回执，不伪装平台 ID。 | 故障模拟；本次没有另发真实文件或普通文字 |
| 飞书 | 文字、卡片、更新要求 `code:0`；发送还要求真实消息 ID。保留 SDK 图片上传返回非空 `image_key` 的专用响应形状。 | SDK 接口/正反向回归；本次未验收真实账号 |
| 企业微信 | 要求 SDK 返回 `errcode:0` 和非空 `headers.req_id`，不再用随机 ID 补缺失响应。 | SDK 接口/正反向回归；本次未验收真实账号 |
| 微信 iLink | 写操作须有显式零返回码；非零 `errcode` 即使同时 `ret:0` 也拒绝。客户端提交 ID 仅在业务成功后用作回执；原始错误正文不进入用户提示。 | 请求/回执/媒体回归；本次未验收真实账号 |
| Codex 后端 | 能力由 BackendRouter 声明并显式路由；提交结果不明不换后端重发。IPC/网络超时仅表示确认失败，不代表长任务已被停止。 | Desktop/CLI/App-server 路由、队列回执、审批及跟随回归；没有为本次测试启动真实任务 |

钉钉发布时写入非空首帧正文和完整状态参数，避免先投递空模板再依赖下一次更新。HTTPS/SDK 的流版本号统一单调递增，同一请求的重试复用版本号；HTTPS 单次卡片请求以及 SDK 连接/读取均有 30 秒上限。卡片创建、投递或响应不明时不自动另发文本；已明确投递的卡片后续失败保留其 ID。明确拒绝创建的一次性命令卡仍可沿用已有文字呈现策略。

创建尝试在发请求之前记入通用检查点。没有明确回执的创建（含长答案续页）不因终态或重启而自动重放；明确可重试的适配器错误才能释放重试标记。已知卡片的更新可按原恢复策略重试。这是防重复保护，不宣称跨进程请求具有平台端 exactly-once 保证。

卡片日志区分 `api_acknowledged` 与客户端渲染验收，记录操作、卡片 ID、HTTP 状态、请求 ID、正文大小/摘要指纹，不输出正文、凭证或原始业务错误。过去宽松回执检查确实会产生“假成功”；它是已确认的 Gateway 缺陷，但不能仅凭日志断言每一次历史空卡都是同一原因。

跟随状态也不能混淆后端与 IM：若 Desktop 快照称同一轮次仍 active，但该轮已有完成投递回执，则报告后端状态冲突（unconfirmed），不能提示“检查渠道权限”。不据此重开已结束的卡片、重发结果或自动操作 Codex；等待新的可信轮次状态。未加载或已归档的旧会话同样不等于 Gateway/钉钉连接断开。

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

### Codex 问题交互

问题、审批与进度是不同的领域事件。`CodexDesktopRequestMonitor` 复用一条本机 follower 连接收集待处理交互；旧审批监听器名称只作兼容导出。AccountManager 按 host + thread + turn 的发起绑定选择唯一目的聊天；重启后可由账号内的问题日志恢复原目的地，没有唯一绑定时留在 App，不按工作目录猜目标或广播到所有群。

两种 native 问题分别适配：

- App Server / Desktop `item/tool/requestUserInput` 保留原 `requestId`、`itemId` 和 question ID，返回 `{answers:{questionId:{answers:[text]}}}`。Desktop 使用 `thread-follower-submit-user-input`，App Server 直接回复原 JSON-RPC request；不通过普通消息、queue 或新任务替代。
- 截图中的异步问题来自 Desktop 的 `agentMessage.questions`。每道题的 `questionItemId` 是 `JSON.stringify(["request_user_input_async", item.id, index])`，分别跟踪；答复使用 App 原生的 `send_user_message_question_reply` 结构化信封。当前 Desktop IPC v1 通过专用的提问回复处理路径调用 follower steer 投递这个信封，不能启动新任务。v1 **不提供**服务端原子的 expected-turn 校验：Gateway 发送前核对仍然活跃的原题，回执必须返回同一个 turn ID；轮次不符、断连和超时均记为未确认，不自动重发。这个兼容路径不解除普通 `/steer` 的后端限制，也不宣称能消除 App 端的竞态。

`ChannelUserInputController` 是渠道中立的应用层控制器，持久化账号内 Q 编号、原生身份、目的聊天、过期条件、部分答复和投递状态，不包含 RPC 或 SDK。日志原子写入、权限 0600；回答成功或请求失效时移除答案正文。重启时重新看到同一个原生问题才恢复等待，沿用原 Q 编号、不重复发卡；可能已经投递但缺少回执的答案不重放。问题被 App 回答、取消、轮次结束或绑定切换后，迟到的 IM 回答不能提交；原生 `autoResolutionMs:null` 不会被 Gateway 自行替换为五分钟后跳过。敏感输入只提示回到 App，不向 IM 展示问题内容或收取答案。

飞书使用共享卡片上的原生输入框和选择/跳过按钮；钉钉、微信、企业微信沿用各自已经支持的普通交互通知，并完整展示 `/answer Q1 回答内容`、`/answer Q1 --option 1`、`/skip Q1`。这不是进度卡文本降级，不更新、覆盖或另建正在运行的进度卡。`/answer list` 显示当前绑定已恢复的待答问题。纯数字按文字答案处理，只有显式 `--option` 才选择；普通聊天消息不会被猜测成答案。命令/卡片回调共用 actor ACL 与 participant 权限，Q 编号不复用审批 A 编号，跳过不等于批准执行。

当前 Desktop 请求监听只连接本机 IPC；远程 Gateway 发起的 App Server 任务和原生 queue 使用同一个回答回调。不能以本机同名 thread 接管远程 Desktop 弹窗。相关回归覆盖 `test/user-input.test.ts`、`test/bridge-user-input.test.ts`、`test/codex-desktop-request-monitor.test.ts`、AccountManager 路由及既有审批测试；模拟通过不等于所有企业账号都已做真实表单验收。

旧 `weixin` 注入参数和 `NormalizedWeixinMessage` 类型保留为兼容入口，适配逻辑集中于 `channels/legacy.ts`；生产启动使用完整的新接口。旧的账号数据目录和轮询检查点无需迁移，历史 WeChat 提示仍可解析；新钉钉/飞书提示会标注实际来源。

新渠道至少应覆盖：完整方法与能力声明、真实 API 错误、原生/文字降级、发送回执、附件限制、群聊身份隔离、连接失败清理、去重、进度限流与终态收尾。测试入口：`test/channel-adapters.test.ts`、`test/network-family.test.ts` 及已有各渠道和 Gateway 测试。

这里的自动测试使用本地模拟 SDK/API，不向真实 IM 发送消息。真实账号的权限和手机端显示仍需端到端验证。
