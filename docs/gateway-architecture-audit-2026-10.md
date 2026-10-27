# Gateway 架构与实现检查（2026-10-27）

## 范围与证据等级

仅检查 Gateway 仓库的 src、根测试、发布脚本和与 Taskboard 的集成边界。不修改 Farming，不重发历史用户任务，不恢复其他会话。

本次按三个层次检查：整体状态所有权和生命周期；模块职责、接口和故障路径；关键函数的异步间隔、持久化次序、数据校验与异常分类。对全部 src TypeScript/JavaScript 建立 AST 函数、分支、await、catch、throw 和依赖清单，用于定位重点。静态清单不等于人工审完每个函数；人工重点是提交、排队、身份、回执、授权、交互投递及进程切换。没有把测试通过解释为所有隐藏问题已排除。

## 架构约束

1. 原生 Codex 持有任务、FIFO 和待执行内容；Gateway 只保留来源、接收身份及投递证据。未知结果不自动重发，不借用另一后端。
2. account/conversation/actor/session/host/thread/turn 各有明确含义。跨 await 后必须重新验证写入目标，不能把当前会话名称当作身份。
3. 原生接收、执行完成、渠道 API 确认、手机实际渲染是独立事实。投递失败不解释为原生任务失败。
4. RuntimeStateStore 由账号生命周期统一持有。全局配置切换与新提交互斥；已有 Gateway 工作时拒绝配置提交，而不是先保存再打断执行。
5. 关键提交日志先持久化后外部写入。权威状态损坏时保留原文件并拒绝加载；可重建的引用缓存单独隔离，不冒充权限或提交证据。
6. 同一状态目录只有一个 Gateway 写进程。替换本地执行客户端前确认旧进程退出；关闭本地客户端不等于关闭远程共享 daemon。

## 已复现并修复

| 问题 | 触发与影响 | 修复及测试证据 |
| --- | --- | --- |
| Desktop 排队被错误禁止 | 只检查私有 follower 接口，忽略官方跨进程原子入队接口，导致 /queue 明确拒绝 | BackendRouter 按实际 owner 选择 admission-only；只调用 thread/queue/add，不 resume、改权限、整体替换队列或抢执行权。真实 Codex 隔离测试覆盖三进程并发追加、取消、提交端退出和原 owner 消费 |
| 入队准备期间绑定或权限变化 | inspect/附件准备后，旧目标可能已解绑或变更 | 冻结来源 actor，提交前检查账号生命周期、精确 session/host/thread、准入及角色；原生 RPC 发送前再检查，明确拒绝与未知提交分别记录 |
| 恢复陈旧进程锁的竞态 | 两个启动者都读到死 PID，较慢者删除较快者刚创建的新锁 | 用排他的恢复 claim 串行重读/删除，主锁带随机 token；确定 ESRCH 才回收，EPERM 不视为进程死亡。双子进程屏障测试复现旧行为并证明修复；同 PID 旧句柄不能删新 token |
| 全局保存配置打断工作 | PUT /api/config 保存后直接关闭 runner，活跃 Web/IM 工作被打断 | 提交前检查工作并进入配置互斥区；忙时 HTTP 409，配置文件、Taskboard 回调和 runner 均不变。准备失败会释放互斥区 |
| 合法 JSON 但错误容器类型丢回执 | receipts 为数组，给字符串键赋值后 stringify 丢弃该属性；原生已写入却没有持久回执 | 关键根对象、映射、队列回执和控制回执形状校验，拒绝数组冒充映射。测试确认保留原始字节并阻止写入 |
| 关键日志只有原子替换，缺少刷盘 | 崩溃时原生写入可能已发生而本地“发送前”证据未稳定落盘 | 提交、控制、恢复、问答、路由和 IDE 授权使用共用 durable 原子写；文件 fsync 后 rename，支持平台再刷目录。文件及目录刷盘故障注入均阻止后端写入；Windows 模拟保留文件刷盘，跳过不支持的目录句柄 |
| 旧执行进程尚未退出就重建 | 全量并发回归中，restart 队列恢复报已有 active writer | close 返回可等待的退出确认，Router/AccountManager 向上等待；私有客户端回收期间禁止新连接穿越。真实原生重启测试和延迟退出夹具覆盖 |
| 损坏的可选引用缓存阻塞账号 | 缓存 JSON/结构错误导致 resolve/remember 异常 | 单独保留 .corrupt 原件、从空可选缓存继续；引用保持 metadata-only，不谎称读到附件。语法、根类型、嵌套形状错误及重新接收测试覆盖 |

## 模块检查矩阵

| 模块边界 | 本轮重点 | 回归位置 |
| --- | --- | --- |
| state / AccountManager | 单写入者、外部刷新冲突、绑定持久化、配置互斥、停止期间提交 | architecture-state、architecture-web-state、runtime-state、account-manager、http-server |
| Bridge / 原生队列 | 来源冻结、幂等接收、未知不重放、精确取消、原 owner 消费、权限变化 | native-queue、desktop-native-queue、native-queue-integration、audit-persistence |
| BackendRouter / App Server | 选择主机及实际 owner、禁止跨后端 fallback、无 resume 的外部追加、退出确认 | codex-app-server、codex-runner、native-queue-integration |
| 审批 / 问答 / 路由 | 原生选项范围、答案确认与提示投递分开、pending/uncertain 保留、权威日志 durable 写入 | approval-scopes、user-input-controller、interaction-routing 及现有端到端交互回归 |
| 渠道 / 卡片 | 部分投递、原生 @、复制框、正文与流式状态、重复完成抑制 | dingtalk、progress、turn-presentation、completion-mentions 相关根测试 |
| IDE | 授权持久化、原账号与项目范围、入口和 WebSocket 生命周期、保存失败处理 | ide-authorization、ide-approval、ide-access、ide-manager 相关根测试 |
| 跟随 / 恢复 | host/thread/turn 隔离、缓存迁移不重放、终态与投递分开、损坏记录拒绝 | thread-event-hub、capacity-recovery、turn-audience 相关根测试 |
| 媒体 / 引用 | 下载预算、凭证不落引用缓存、跨群隔离、可选缓存损坏恢复 | inbound-references、inbound-bytes、附件转存相关根测试 |
| 进程 / 发布 | stale-lock 并发、未知 PID 权限、退出确认、隔离构建、版本一致、代码回滚不回退状态 | process-lock、release-local、desktop-native-queue |

## 函数层检查方法与边界

针对高分支和多 await 的入口检查每次外部写入前的身份、生命周期和能力核验；对持久化函数检查异常发生在 rename 前后的行为；对恢复函数检查 missing/unknown/cancelled/completed 是否被混同；对操作回执检查业务拒绝、明确未发送和接收未知是否被错误重试。新增测试使用屏障而非仅靠 sleep 驱动绑定变化、锁竞争和配置互斥；真实原生测试使用临时 CODEX_HOME、本地 mock Responses 服务，无真实凭证与外部模型请求。

原生队列接受后属于 Codex，撤销 Gateway 准入或解绑不会自动取消原生任务。未开始项需显式取消；对外部 owner，Gateway 不宣称通过持有执行回调控制其消费。原生版本缺少队列 API 时明确拒绝。纯 codex exec 不因本次修复获得队列能力。

仍需后续管理的风险：大型 HTTP/Bridge/App Server 协调函数有较高维护复杂度，应逐步按既有契约拆分；长期回执/去重墓碑需要有保留语义的归档方案，不能直接删除；恢复 claim 自身若崩溃遗留，启动会明确拒绝，需核验 owner 后清理，不能冒险自动抢锁；手机真实渲染、真实远程网络故障、真实 Windows 掉电未由本地模拟替代验收。独立 Taskboard 子工程已有测试基线问题，本次未修改或宣称其全套测试通过。

发布使用 release-local 的 prepare / seal / switch / verify：提交绑定全量根测试、类型检查和隔离制品，push 后核对提交与制品，再切换。切换前后对比授权、账号和绑定，不清空状态、不重放历史消息；只在校验失败时回滚代码制品。具体测试数量和运行版本由每次发布 manifest/verified 记录，避免把旧计数写成当前验收。
