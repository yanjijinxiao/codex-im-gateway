# 候选缺陷（未确认不算已发现）

最终处置已闭环，见 REPORT.md 和 progress.md 的“最终补充与候选闭环”。以下保留初始疑点与当时进展，不代表最终未完成清单。R06/R31 排除，R19 为显式协议；R62 的平台数量猜测未证实，仅业务回执缺失部分确认修复。其余项按报告的缺陷族映射及明确能力边界处理。

当前修复与验证进展见 progress.md；本文件保留最初疑点，不能按未更新的疑点文字解释为尚未修复或已经确认。

- R74（新增待核对）：本机文件观察完成通知/外部审批后备/项目运行任务投影仍有仅按目录或未限定主机的 thread 匹配；在同目录多原生项目、同名本地/远端 thread 下，需证明不会错误通知、隐去任务或挑错后备审批目标。Taskboard 仅有 workspacePath 的映射也需明确主机边界（R28）。

基线 055c402。只读源码层先记录候选，独立复现后另标结果；不据此修改线上状态。

- R01 runtime-state.refresh：在 normalizeRuntimeState 之前赋值 revision；字段结构异常导致规范化抛错后，下一次 refresh 可能因 revision 一致直接返回旧内存状态。需验证持续失败关闭与旧状态暴露边界。
- R02 runtime-state.updateKnowledgeBase：先改 name，后验证 root 是否重复。失败请求可能改变内存，后续无关 save 使失败修改落盘。检查同类多字段更新。
- R03 admission.observe：容量和每人上限统计含已处理 dismissed。处理申请不能释放上限，达到 500/8 后 24h 内新申请被阻塞，提示“先处理”不能解决。
- R04 inbound-receipts.save：append 部分写入失败未恢复文件长度；同进程后续 append 可能把破损中间行保留，重启解析失败。需故障注入后再写一条并重启验证。
- R05 approval.settle：超时和异步投递失败回调中 audit 写失败可抛出未捕获异常，并使原生等待未能拒绝/结束。需子进程故障注入与恢复语义验证。
- R06 project-selection 编号：项目序号按当前项目列表即时解释，没有冻结候选快照；旧 P/C 指令在列表重排后可能选到另一项目。需对照命令出站值和调用方才能确定是否已有保护。
- R07 runtime-state host normalization：缺失 projectId 的远端会话按本机 workspace 建项目，可能跨主机归属。需核实是否存在支持范围内的合法迁移输入。
- R08 sessionExecutionScope：mode 切换后切回、跨 session 切走切回的旧执行租约是否都受 executionGeneration 保护；需检查所有入口，避免仅用当前相等判断。
- R09 PromptBuffer：TTL 只在同一 key 被访问时清理，闲置 key 可能永久保留。需验证是否由调用层全局回收，单次上限是否掩盖总体无界。

更新（仍未上线）：
- R01/R02/R03/R04：新增正确行为反例在基线失败，本地修复后通过。R01 保持解析失败关闭；R02 多字段更新先验证后提交；R03 完成申请释放容量但不淘汰 applying；R04 部分追加回滚，无法修复则禁止继续追加。
- R05 已复现：审批日志写失败使 declineAll 抛错，剩余原生等待无法拒绝。修复允许拒绝在日志失败时仍释放等待；允许操作仍要求日志提交成功。
- R06 已排除：BridgeService 保存分对话/用户的候选快照，不直接按最新目录解释旧序号。纯函数不足以证明调用链漏洞。
- R08 未确认：activateSession 已有 executionGeneration，A→B→A 不只是比较当前 ID；模式变化须检查真实原生目标是否改变。
- R10 已复现并修复：迁移写失败后错误恢复递归触发同一迁移写，改为恢复读取不再次持久化。
- R12 已复现并修复：提问卡片发送挂起阻塞回答/超时；旧控制器的延迟投递回执覆盖新日志；回答写失败残留 answered/占住参与者；超时写失败异常。新增六项反例在基线全部失败，本地交互回归 48 项通过。

新增待验证候选：
- R11 控制写入（取消 queue / stop / goal）在异步读取后是否重新核对绑定、权限和原生目标，不能只看普通消息 run 的执行租约。
- R13 actions 正则可能执行外层代码示例和引用中的内层动作块；跨块 remember 上限未全局限制。
- R14 单个动作 JSON 损坏会导致已完成原生结果转为投递错误，正常正文丢失；需明确无副作用的错误呈现策略。
- R15 Desktop /help 固定宣称 queue 不支持，与原生队列能力冲突；指定轮次 /steer 的限制另有理由，不能一并移除。
- R16 /ide identity 帮助仍要求首次本机注册，与统一个人准入授权不一致。
- R17 native queue 的读取/历史页在超时返回后是否继续占住写入锁，需故障和大历史复现。
- R19 未知斜杠/路径文本的拦截是否符合显式命令协议，不能仅由 parseCommand 认定缺陷。
- R20 /plan 非法参数会静默切换模式，应核实用法及回归。
- R21 重绑已有 managed session 未更新原生已知变化的 cwd/projectMembership；须核对后续事件是否已修正。
- R22 applyRecoveredOutput 的身份检查只有 managed ID，需对照恢复协调器的完整执行范围。
- R23 /history 并发或绑定切换时是否回传旧目标内容。
- R24 个人知识删除命令使用当前 K 编号；列表变化后旧卡片是否会删除不同内容。
- R25 TaskboardSubmissionDeduplicator 忽略正文/version，仅比较 operation/project/identifier，需验证同 request ID 不同输入的冲突语义。
- R26 Gateway Taskboard SSE 仅以 LF LF 找边界，CRLF CRLF 可能不解析；未限制未结束帧大小。
- R27 Web Taskboard move 先评论后迁移，与渠道使用原子 transition endpoint 不一致；并发 version 冲突可能留下孤立评论。
- R28 Gateway Taskboard 对 host 同路径的项目映射可能混淆；未知提交的去重恢复是否跨重启可靠。先核对支持契约，不修改独立 Taskboard 源码。
- R29 超长 autoResolutionMs 超出 Node timer 范围可能被压为 1ms，需确定输入范围和到期检查。
- R30 CLI 目录和 inspect 同步扫描全目录，长历史可能阻塞事件循环；需规模测试而非只看有 timeout。
- R31 stop 未指定 ID 可能误停其他任务的猜测已排除：BridgeService 只有 session.threadId 非空才调用 stop。
- R32 Desktop execute 将所有 success=false 统一报 failed，忽略 completion.outcome=interrupted；应保持原生终态。
- R33 app-server busy 分支重试后通信失败是否保留未确认提交和审批处理器；原生请求超时已有 unconfirmedStarts 保护，需按具体失败类型验证。
- R34 inspectThread 的目录回查 findListedThread 吞掉读取错误，可能在归档/活动目录不可读时把会话判定 missing。
- R35 resolveProjectId 按项目 ID 或 cwd 找首个匹配，缓存也只按 cwd；同根多项目下可能忽略显式项目 ID。
- R36 IPC / JSONL 收到合法 JSON null 等非对象会导致未捕获异常；嵌套列表 null 与越界时间戳也需验证。
- R37 旧 turn/completed 通知无条件清除线程级 handler 和状态，需验证晚到完成不能覆盖新轮次。
- R38 dynamic tool 请求没有像审批一样冻结传输 owner，异步结果可能回到替代连接；同步回调抛错还有协议循环异常风险。
- R39 CodexSessionCompletionMonitor 批量行在处理前整块推进 offset，某回调抛错可能丢弃同块后续完成/进度；需检查下游 durable outbox 的承诺。
- R40 live completion 仅 object error 算失败，与 startup recovery 的 truthy error 语义不一致；parseThreadState 未知状态默认 idle 是否满足只读真实性契约也需验证。
# Additional review candidates (not yet verified defects)

- R68: Knowledge-base HTML renderer inserts bound project names without escaping. Verify with literal markup in a project name.
- R69: Optional Taskboard requests are awaited before the main browser view refresh, and knowledge-binding controls are replaced every refresh even while focused. Test independence and interaction stability.
- R70: Taskboard detail/list fetches have no shared generation fence; a late old response may overwrite a newer selected issue or refreshed state.
- R71: QR login start/poll callbacks do not check the current dialog/login generation; late old requests may replace/close a newer QR dialog.
- R72: New managed-session UI selects only an account and silently derives a conversation from last activity/first allowlist identity. Review explicit target choice against binding invariants.
- R73: Browser streaming parser does not cancel its reader on parse/error paths and has no line-size bound; review malformed/oversized progress and cleanup.

- R63: Knowledge MCP start returns as soon as the child exists, before initialization completes; concurrent calls or initialization failure may bypass protocol readiness. Verify child ownership and cleanup as well.
- R64: Legacy knowledge document confinement is lexical only and follows symlinks on read; output/file size is also unbounded. Test canonical-root confinement.
- R65: Account files are cast without schema validation; normalized IDs can alias distinct strings. Verify HTTP validation and invalid-file failure isolation before changing compatibility.
- R66: Weixin persists the next polling checkpoint before messages reach durable native submission. Analyze crash windows and receipt reconciliation without introducing a second execution queue or replaying uncertain submissions.
- R67: Weixin attachment paths preserve dot/dot-dot sender segments, use unbounded body reads when Content-Length is absent, and outbound files use synchronous unbounded reads. Test path confinement and resource budgets. Weixin API/login/CDN requests also need bounded deadlines (related R59).

- R41: Desktop request-monitor handshake has no response deadline; test a connected peer that never initializes.
- R42: Event-hub subscription identity may omit recipient/client generation. Check shutdown fencing before treating this as a defect.
- R43: Account shutdown can exit on an earlier journal failure without cleaning later runtime resources. Exercise every shutdown phase.
- R44: Outbound local-path actions and attachment lookups do not carry a host-qualified filesystem identity. Test equal local/remote paths without sending files.
- R45: Managed-project synchronization chooses workspace/host before an explicit source project ID; test multiple native projects sharing a root.
- R46: Personal admission mutates the in-memory access controller before durable paired-sender persistence. Test failed grants and subsequent unrelated saves.
- R47: Some Taskboard loopback checks compare URL.hostname to unbracketed IPv6. Verify IPv6 configuration compatibility.
- R48: HTTP project selection accepts only workspace and may pick the wrong host/project among equal paths.
- R49: HTTP project creation widens allowed-workspace configuration before creating the project; test failure atomicity.
- R50: Session attachment response disconnect does not explicitly destroy its file read stream. Reproduce resource cleanup on abort.
- R51: Approval timeout notice claims automatic rejection before native acknowledgement. Check accurate pending/acknowledged wording.
- R52: IDE entry references change in memory before disk persistence; test failed write, retry and restart. Also inspect aliases/pinning.
- R53: IDE installers for different hosts share the same cached asset output; test concurrent downloads and temporary-stage cleanup.
- R54: IDE WebSocket upgrade has an asynchronous membership/authorization race. Confirm existing generation and periodic checks before changing security behavior.
- R55: Assistant prose token offsets may not match CRLF input after Markdown lexer normalization; preserve literal/code/quote boundaries.
- R56: Valid result-page reserved-byte boundary can leave less than one Unicode code point and stop the split loop making progress. Test in a bounded subprocess.
- R57: Background progress/presentation promises can reject from journal persistence outside their error handlers; test unhandled-rejection behavior in isolation.
- R58: Terminal fallback notice marks sent only after acknowledgement and can automatically repeat an uncertain plain-message send.
- R59: DingTalk emotion, webhook and inbound-download operations lack explicit deadlines; the pinned HTTPS implementation buffers the full response before inbound size checks.
- R60: DingTalk callback casts parsed JSON without validating object/string fields, and routing persistence exceptions can escape the listener; extend protocol-boundary fault tests.
- R61: Feishu fallback action identity excludes form contents. Check whether a corrected form submission is incorrectly deduplicated after an invalid first submission.
- R62: Feishu menu mutation success accepts missing business code, and preserving custom top-level menus plus adding three shortcuts may exceed provider limits. Check before any configuration mutation.
