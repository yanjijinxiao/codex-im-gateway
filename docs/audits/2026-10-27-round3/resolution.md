# 第三轮问题修复与验证

本文件记录 report.md 所列基线缺陷的修复。report.md、file-review.csv 和 docs 下的反例保留为历史证据，不能把它们的“缺陷行为成立”断言当作新版发布门禁。正常回归位于 test/；原始审计范围、人工检查层级和覆盖率分母不变。

## 统一边界

- 提交：TurnSubmission 携带同一个来源核验到 Router 串行等待、本地 CLI spawn、App Server 初始化/项目创建/元数据/队列/turn 写入、Desktop owner 观察之后。接收事实与绑定更新仍分别记录。
- 绑定：sessionExecutionScope 冻结来源和拓扑；独立 executionGeneration 防止重置、解绑再绑定及切走再切回的 ABA。人工活跃时间属于到期策略，不改变执行代次。只有当前来源的原生线程回执可以推进该代次。
- 生命周期：账号操作按规范账号 ID 串行；停止与配置切换按资源存在性处理，不只筛选 running。容量恢复准备、执行与未确认阶段都进入切换屏障。配置变更返回补偿操作，已知启动失败时恢复旧配置及原账号集合。
- IDE：安全 scope 只包含 owner、host、project、workspace 和目录集合。展示名称、目录次序、别名和原生轮次不参与；权限扩大和准入撤销仍拒绝。旧 grant 仅在原完整 scope 可核对时增加 securityScope，原 token 哈希、scope、到期时间、CSRF、主体及目录信任保持不变；无法核对的旧授权不会猜测迁移。发布检查允许这一项经过格式校验的增量字段，其余授权内容仍严格比对。
- 展示：Desktop 专用代码批注先投影成惰性正文，再进入卡片、普通文本、进度和历史路径；代码块、行内代码及引用中的字面示例保留。精确重复的批注正文可省略，不按语义猜测删掉不同结论。源码引用保留文件、行号和说明，不隐式发送附件。

## 缺陷与回归对应

| 缺陷 | 实现与验证 |
| --- | --- |
| F01 | 来源核验贯穿最后写入；Router 串行等待、真实 App Server 初始化屏障、真实 Desktop IPC owner 恢复后撤权测试；既有跨后端原生队列/审批测试 |
| F02 | Web onThreadCreated、最终绑定及完成通知条件提交；真实 AccountManager 执行中 reset 测试，executionGeneration 的 reset/切换/解绑 ABA 测试 |
| F03 | CapacityRecoveryCoordinator.hasInFlightWork 纳入配置屏障；已接收且未完成恢复期间拒绝配置提交，runner 不关闭 |
| F04 | daemon start 与本地 proxy 显式携带同一 CODEX_HOME；临时假可执行文件记录环境验证，既有 stdio/daemon 传输回归 |
| F05 | 取消按 2000 条盲目删除来源；旧活跃 turn 经过新来源增长后仍投递旧群。保留不可路由 tombstone；安全归档策略未实现前宁可保留，状态文件会继续增长 |
| F06 | starting/error/reconnecting 资源纳入停止，旧监视器回调不更新新 entry；connecting 停机及配置失败恢复测试，既有账号适配器生命周期测试 |
| F07 | 共用稳定 scope 与规范目录集合；旧文件迁移、改名/重排/别名、目录扩大、撤权、迁移落盘失败、发布 grant 指纹测试 |
| F08 | 网络、JSON、NDJSON 截断或缺少终态均保持 unconfirmed；保留请求 ID，只有明确 not-submitted 才把原输入放回编辑框；done 到达后不再等待坏连接。真实 Web 函数 VM 测试覆盖断连阶段及输入恢复策略 |
| F09 | 总览刷新和同会话历史各有独立请求代次；较旧成功/失败不能覆盖较新响应；真实 Web 函数并发测试 |
| F10 | Taskboard 验证后替换，不同端口先准备；同端口失败恢复旧启动参数。测试非法 URL、不同端口启动失败、同端口启动失败、账号 runner 重启失败及配置补偿 |
| F11 | WeCom 解码/认领/处理均在 Gateway 的 Promise 错误边界内；真实 SDK 分发同步认领失败，Gateway 收到错误而不是只在 SDK 内吞掉；停机前等候已开始的异步认领属于测试显式步骤 |
| F12 | 附件路径按精确身份去重，不统一转小写；POSIX 大小写不同的两个文件都保留，既有跨块去重保持 |
| F13 | 判断真正的父目录分量，合法 ..cache 不再被拒绝；上级逃逸继续拒绝 |
| F14 | 共享 assistant-presentation；相邻/多行、引号与花括号、畸形指令后正文、精确重复、代码/引用字面示例、长路径、卡片和纯文本、历史源码引用测试 |
| F15 | 原生身份确认与完成区分，缓存确认和已保存账号；并发 poll 共用一次工作，失败继续同一登录。HTTP 返回 scanned/retryPending，Web 保持轮询；恢复/并发/HTTP 测试 |

追加 F16：远程 relay 在控制 socket 已关闭、SSH stdin 仍被 Gateway 持有时未退出，会使已初始化的传输持续假活。隔离真实 Unix socket/WebSocket 握手反例在修复前失败（700ms 后仍存活），修复后约 51ms 退出并返回非零状态。现在控制 socket 关闭会结束 readline 和 stdin；原生接收仍由原回执核对，不自动重放写入。remote-codex-host 纳入这一回归。

主要新增门禁：architecture-round3、architecture-boundaries-round3、architecture-lifecycle-round3、architecture-config-round3，以及扩充 architecture-web-state、desktop-owner-observation、ide-authorization、http-server、login-manager。既有引用断言更新为新的紧凑展示，仍核验说明文字、文件和行号，无隐式附件。

## 截图中的远程报错

用户随后截图的消息属于另一个远程 review 会话。该时段有多个远程线程 follow-synchronize 超时；SSH 探测成功，之后用 Gateway 的 metadata-only 控制通道只读检查目标会话也成功（约 1.3 秒，idle）。因此已明确错误提示为“状态读取超时，未提交、未入队”，并移除可选 /status 的大复制框。不能把这个错误称为已入队，也不能由一次恢复探测推断当时所有超时的唯一根因。没有重发截图中的请求、重置其任务或改绑。

## 发布边界

使用 scripts/release-local.mjs 的独立制品目录执行全量回归、类型检查和编译；真实 Codex 队列测试仅使用隔离 Home。只有 prepare 成功才 push/seal/switch。切换核验新进程及制品身份、原账号连接、完整绑定边及授权指纹；失败只回滚代码，不恢复旧运行状态或旧授权。

本轮自动化验证不能代替手机端视觉和网络可达性验收，也不意味着已经穷尽全项目所有隐藏问题。
