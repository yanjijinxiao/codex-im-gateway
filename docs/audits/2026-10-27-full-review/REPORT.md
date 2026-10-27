# Gateway 全量架构与代码自检

审查基线：055c402a236d7a39d77a4429cce2573c09198501。范围为 Gateway 自有 src、scripts、test；不包含 Farming、独立 taskboard 实现、第三方依赖、生成制品。Gateway 调用 Taskboard 的代码在范围内。

## 结论与检查方法

问题并非只有排版。多个入口对同一个身份或状态各自作推断：用目录代替项目身份、用当前相等代替请求来源租约、用连接存活代替交互 owner、用缺失回执代替执行结束。局部补丁及只验证顺利执行的测试不能覆盖这些组合，之前将现有测试通过表述为全面自检完成，证据不足。

本轮按用户要求做三层检查：

1. 整体架构：逐条跟踪入站消息、准入、绑定、原生提交/队列、进度、终态、附件、浏览器授权及重启恢复的事实来源与责任边界。
2. 模块：检查异常、并发、重试、取消、换绑、换连接、持久化失败、迟到回执、平台能力差异和兼容迁移。
3. 文件与函数：逐段阅读全部 399 个范围内文件（208 个源码/脚本，191 个测试/fixture），以 AST 清单定位函数体，并重新生成最终文件和函数哈希。阅读完成不代表每个函数都有独立测试，更不代表已证明不存在隐藏缺陷。

候选先记录在 candidates.md；确认缺陷要求隔离反例、修改前失败、修改后通过，或已有协议/状态回归明确证明。未确认的猜测不计为缺陷。未在生产会话发送验证卡、改绑、恢复任务或重放输入。

inventory.json 保留基线与逐文件阅读记录。reviewed-current.json 记录本轮最终版本的文件/函数位置及哈希，以及相对基线的变更范围；不能将基线函数行号直接用作修改后行号。

## 架构边界及本次处理

| 边界 | 必须保持的规则 | 实现与验证 |
| --- | --- | --- |
| 入站领取与执行 | Gateway 记录来源和接收事实；Codex 原生队列决定执行，不重发未知提交 | 部分日志追加回滚、回执版本比较、微信完成屏障、原生来源 ID/真实队列重启测试 |
| IM 与原生身份 | 对话、账号、主机、thread、项目 ID 分别明确；cwd 只是位置 | 公共项目身份解析；显式 ID 优先；同根多项目不猜测；换绑/模式往返使旧租约失效 |
| 控制和权限 | 异步准备后、真正原生写入前再次核对来源及角色 | stop、goal、取消 queue 的最终校验贯穿 Bridge、Router、Desktop、CLI/App Server |
| 执行与呈现 | 任务结果、提交回执、卡片投递是不同事实 | 中断保持 interrupted；未知状态不变成 idle/missing；失败卡片与原结果分别记录 |
| 连接归属 | 旧连接的异步操作不能写入替代连接或原聊天 | Desktop 握手期限/requestId/socket owner；Event Hub 客户端归属及历史卡修复校验 |
| 持久化 | 失败的修改不能污染内存，也不能由下一次提交意外落盘 | 状态验证后发布、迁移失败恢复、准入先持久化、IDE 引用先提交 |
| 数据与文件 | 路径属于执行主机；本机不能代替远端同名文件 | 恢复输出/历史主机限定；知识文件 canonical confinement；流式预算、断连清理 |
| 可选模块与 Web | 可选 Taskboard 不能阻塞主页面；旧异步响应不能覆盖新选择 | 核心刷新独立、各查询代数、明确对话选择、编辑焦点保护、reader 关闭 |

未为了拆文件而大规模重写 BridgeService/AccountManager。它们仍较大，后续拆分应沿上述契约逐步提取，而不能再复制一套身份、队列或授权状态机。

## 缺陷与测试映射

编号沿用初始候选，多个编号可能属于同一缺陷族，不能直接把编号数量宣传为 bug 数量。

| 候选 | 修复内容 | 主要新增回归 |
| --- | --- | --- |
| R01/R02/R03/R04/R10 | 解析/迁移/验证失败、追加失败、申请容量回收 | full-review-state、architecture-state、message-buffer |
| R05/R12/R29/R51 | 审批日志失败仍释放拒绝等待；问答投递/回答/到期/迟到回执；超时提示等待原生确认 | full-review-interactions、approval/user-input 相关测试 |
| R07/R21/R28/R35/R45/R48/R49/R74 | 主机与原生项目 ID、旧项目迁移、重绑、独立会话、HTTP 选择、Taskboard 本机边界；保留目录别名 | full-review-project-identity、full-review-external-projects、full-review-boundaries |
| R08/R11/R15/R16/R20 | 模式往返租约、控制最终校验、帮助能力和非法参数 | full-review-controls、session-control/session-catalog/native-queue |
| R09 | 跨对话访问回收过期缓冲 | message-buffer、full-review-controls |
| R13/R14/R24/R55/R56 | 引用/代码示例不执行；无效可选动作保留正文；稳定知识删除 ID；CRLF 与 UTF-8 分页 | full-review-actions、full-review-knowledge、full-review-presentation |
| R17/R33/R34/R36/R37/R38/R40/R41 | 只读队列不占写通道；重试未知提交保留 owner；目录错误不伪造 missing；协议异常形状/旧终态/工具连接归属 | full-review-protocol、full-review-desktop-connection、full-review-resources |
| R22/R23/R44 | 恢复输出和历史查询完整来源校验，远端文件不读本机 | full-review-output-ownership、result-delivery-lifecycle |
| R25/R26/R27/R47/R61 | 完整表单去重、SSE 分帧/预算/清理、原子变更评论、IPv6 回环 | full-review-taskboard、feishu-taskboard-interaction、taskboard-client |
| R32/R39/R42/R43/R57/R58 | 中断语义、批次回调隔离、发送连接 owner、清理失败继续、后台拒绝、未知提示不重复发送 | full-review-background、full-review-hub-owner、thread-event-hub、desktop-codex-runner |
| R46/R52/R53/R54 | 个人准入持久化、IDE 引用/共享下载、WebSocket 101 前重新核对项目与端点 | full-review-boundaries、full-review-resources、IDE authorization/endpoints/hotplug |
| R59/R60/R65/R66/R67 | 总网络期限与流式预算、SDK 回调领取失败、账号文件 schema/碰撞、微信 checkpoint 完成屏障 | full-review-network、full-review-accounts、full-review-weixin-checkpoint、DingTalk/Weixin 相关测试 |
| R62（确认部分） | 飞书菜单需要明确 code=0 的业务成功回执 | full-review-protocol、feishu-menu-sync |
| R63/R64/R68 | MCP 初始化共享及失败清理、旧知识文件 confinement、项目名 HTML 转义 | full-review-knowledge、full-review-boundaries |
| R69/R70/R71/R72/R73 | Taskboard/二维码/详情迟到响应；编辑控件；明确 IM 对话；Web 流 reader | full-review-web-races、architecture-round3 |

R06 已排除：调用链保存分用户/对话的项目候选快照。R31 已排除：停止操作要求明确绑定 thread。R19 是显式命令协议：普通自然语言直接转发，斜杠开头才进入命令分发；不能将所有自然语言都当成项目控制意图。

## 验证证据

- 初始基线 1708 项：1707 通过，1 项 Windows 平台跳过。
- 第八轮合并回归 1870 项：1869 通过，1 项 Windows 跳过，无失败/取消。
- 第九轮合并回归 1879 项：1878 通过，1 项 Windows 跳过，无失败/取消，包含真实安装 Codex 的原生队列集成。
- 第九轮之后补充本机 symlink 目录兼容反例：修改前失败，项目/Taskboard/管理层相关 83 项通过。发布准备必须对最终提交再运行完整测试和类型检查，以制品 tests.log 及 manifest.json 为准。
- 真实原生 queue 四个场景：空闲、忙碌、忙碌重启保留、跨进程只消费一次。使用全新临时 CODEX_HOME 及本机假模型，无生产任务或外部模型请求。
- 故障注入包括部分写、fsync/rename 失败、EACCES、挂起读取、断连、迟到事件、畸形 JSON/历史、读流超限、同根不同主机/项目、用户撤权、并发刷新。
- 所有失败轮次保留真实结果，progress.md 列明旧断言/夹具问题及修正，不把失败轮次计为通过。
- 测试默认每项 120 秒上限与发布工具一致。类型检查、diff whitespace 检查通过；最终发布准备重新执行。

## 已知限制与兼容行为

1. 远端制品没有通用回传端口。本次禁止读取本机同路径文件，并明确提示通过 Web IDE 获取；没有将它包装成已支持远端附件回传。
2. Taskboard 当前项目协议只有 workspacePath，没有主机/原生项目身份。远端或同根歧义项目不自动关联，独立 Taskboard 源码未改。
3. 队列核对总预算 3 秒、最多 100 页。超大历史或不可读时保留未确认收据，不自动重发；尚无持久历史索引游标。
4. CLI 目录读取已改异步并区分轮转与真实 I/O 错误，避免阻塞控制；极大历史仍需完整解析，未声称已有索引分页或容量基准证明。
5. 微信出站读/加密受 100 MiB 上限保护，仍占有有界内存，并非流式加密。第三方 SDK 自身的所有行为不能由本轮隔离测试证明。
6. 飞书菜单“保留自定义项后是否超出平台数量限制”的初始猜测未获得本轮可用官方契约证明，不据此硬编码数量限制或改写用户菜单。配置/能力/发布是平台多个调用，非跨调用原子事务；未用真实租户发布作测试。
7. 旧知识 K 编号删除将拒绝并要求刷新，避免删错；账号加载要求原始账号 ID 精确匹配，不再允许规范化别名选中另一个账号。坏文件保留，不自动覆盖修复。
8. 手机真实网络可达性不能由 Mac mini 本机测试代替；本轮可以验证服务、授权、路由与端点，不能把这些表述为手机端已验收。

## 发布约束

自检和本地验证完成后才提交、push；使用 scripts/release-local.mjs 隔离准备、seal、switch、verify。测试、类型检查、构建在停服之前完成；保持既有授权和精确绑定，不恢复旧状态或重发未确认输入。实际切换结果写在独立制品目录 verified.json，只有该验证成功才报告已上线。
