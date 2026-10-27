# Gateway 第三轮架构与实现自检（2026-10-27）

修复进展见 resolution.md；下文保留审计当时的基线结论。

基线：c3ff9ac5c3fc24426b8f51bf4c3af94b4dfcee4c。范围为 Gateway 的 src、scripts 及根测试，包括 Gateway 拥有的 Taskboard 集成边界；不检查 Farming，也不修改独立 Taskboard 子工程。

结论：确认 15 类缺陷（12 类本轮新增，3 类上轮已知仍未解决）。其中 4 项 P1、10 项 P2、1 项 P3。用 16 个隔离反例确认；反例通过表示问题仍然存在，不是修复完成。本轮没有修改运行代码，没有提交、push 或切换服务。

## 检查方法与覆盖边界

1. 整体架构：沿输入来源、权限、绑定、后端持有者、生命周期、投递回执、配置切换检查权威边界。
2. 模块：对照 Web、IM、原生队列、容量恢复、审批问答、IDE、状态存储、Taskboard 集成与发布的入口及交叉调用。
3. 文件及函数：对 src/scripts 的 198 个跟踪文件建立逐文件清单，其中 194 个 JS/TS 文件做完整 AST/语法扫描；共 42898 行（按清单换行统计），无语法扫描错误。对 76 个风险相关文件的关键函数和调用链人工复核，并对发现的缺口构造并发屏障、故障注入或边界反例。逐文件层级在 file-review.csv 明确记录；不能把“静态扫描过”写成“每一行都已人工穷尽审完”。

现有全量回归：1622 项，1621 通过、1 个 Windows 专属跳过、0 失败，启用真实隔离 Codex 原生队列。V8 表内 169 个文件的覆盖率为行 93.42%、分支 85.51%、函数 90.00%。这个百分比只针对表内实际加载文件；纯类型、独立脚本和 DOM/VM 执行的 Web 脚本不能直接套用这个分母。通过率与高行覆盖率都没有证明下面的时序组合安全。

## 第一层：整体架构的共性缺口

### A. 提交前核验没有贯穿到最后一次原生写入

应用层 TurnSubmission 调用 assertCurrent 后，后端还会等待串行门闩、连接与持有者查询。这些等待结束后没有携带同一核验契约到实际写入点；回调写入绑定也没有统一的代次条件。于是“准备阶段已检查权限”与“写入时权限仍然有效”成为两件不同的事。F01、F02 都属于这个边界。

应使用冻结的执行上下文：account、conversation、managed session、host、native thread、project/root scope、binding generation、actor/access epoch。最后一次外部写之前重新核验；原生接收事实独立落盘，后续绑定更新使用条件提交，迟到回执不得覆盖新代次。

### B. 生命周期与配置事务没有统一的资源登记

普通 IM/Web、原生队列和容量恢复拥有不同的在途集合；账号 UI 状态又被用作是否需要清理资源的条件。配置验证、资源切换和持久化仍分散。F03、F06、F10 都可能在停止或重配置时制造半完成状态。

应统一登记准备、待写、接收未确认、已接收观察及资源关闭租约；start/stop/refresh/remove 按账号串行并有代次。替换配置先完整验证和准备，再提交和切换；失败保留可用旧态或明确恢复，不应先停服务再发现新配置非法。

### C. 安全身份、展示信息和缓存淘汰没有充分分离

IDE 把整个展示对象序列化作授权 scope；交互来源按条数直接淘汰，却允许随后回落到另一个主群。F04、F05、F07 都表现为身份与来源边界未完全闭合。

主机/项目/目录权限及撤销代次应形成稳定安全身份，项目名、目录展示次序不参与。仍活跃或等待交互的来源必须固定；来源丢失时应保持不可路由，不能悄悄转到另一个群。Codex Home 应作为后端路由身份的一部分，贯穿启动、代理与元数据读取。

### D. 浏览器缺少与服务端一致的回执状态机和快照代次

后端已区分未提交、已接收、未确认，浏览器原生 fetch/read 断连仍丢掉这个分类；并发刷新也没有“较新的快照才能提交”的代次。F08、F09 分别会诱导重复发送与展示倒退。

## 第二、三层：模块与底层实现中的已确认缺陷

### F01 · P1 · 最后提交核验在后端等待后失效（新增）

位置：src/bridge/turn-submission.ts:53；src/codex/runner.ts:130、144。

反例：第一条原生执行保持未结束；第二条经过 assertCurrent 后进入 Router 的串行等待。此时撤销许可，释放第一条，第二条仍调用实际后端 run。核验仅执行了一次，原生写入执行了两次。

影响：准备后、真正写入前发生撤权/改绑，仍可能向旧目标执行。上一轮附件准备后的检查只堵住了前面的等待窗口。

补测：串行等待、连接建立、owner 观察后逐个暂停，再撤权、降角色、改 host/thread/project、开始停机；所有后端写入入口必须共同拒绝。仅在 TurnSubmission 调用前检查不能覆盖这些用例。

### F02 · P1 · Web 晚到完成回调覆盖明确重置后的绑定（新增）

位置：src/server/account-manager.ts:1416、1448；对照 resetSession:1219。

反例：Web 请求已开始并记录 old-thread；用户通过真实 manager.resetSession 清空 thread；随后释放原任务结果。Web 完成路径无条件 setSessionThread，又把 old-thread 写了回来。隔离测试走真实 AccountManager、状态存储与 Web 提交入口。

影响：用户看到“已经重置/切换”后，又被旧回执恢复；与 IM 上一轮补过的保护不一致。

补测：原生接收后、onThreadCreated 和最终结果回调前分别重置、改绑、删除及重建同名会话；迟到回执只能记录原任务事实，不能覆盖新绑定。

### F03 · P1 · 配置切换仍能关闭容量恢复正在使用的 runner（上轮遗留）

位置：src/server/account-manager.ts:492、502；src/server/capacity-recovery.ts 的 attempt。

反例：容量恢复已获 onTurnStarted，执行保持未结束；调用 reconfigureRuntime，配置回调仍提交，runner.close 被调用。容量恢复未登记到 respondingSessions 或 BridgeService.hasInFlightWork。

影响：配置屏障漏掉一整类原生执行；可能打断恢复观察甚至关闭实际执行资源。

补测：恢复准备、写入未确认、已接收、等待交互、终态待投递及并发配置保存。

### F04 · P1 · 自定义 Codex Home 在 daemon 路径丢失（新增）

位置：src/codex/app-server-daemon.ts:48、60；src/codex/app-server-runner.ts:1264。

反例：提供自定义 codexHome，在该目录创建只记录环境的假 Codex 可执行文件。transport 选择了该目录下的二进制，但 daemon start 子进程没有收到相同 CODEX_HOME；proxy 路径也只有 stdio 模式才注入这个环境。

影响：options 指向自定义 profile、进程环境却是另一个 Home 时，目录发现与原生后端可能读取不同状态目录。这个条件不代表当前默认 Home 线上实例已经串目录。

补测：环境 CODEX_HOME 与 options 相同/不同/未设置，auto/daemon/stdio，各自确认 daemon start 与 proxy 使用相同的明确 Home。

### F05 · P2 · 来源日志淘汰后，活跃旧轮次的新问题可能转入新主群（新增）

位置：src/bridge/interaction-routing.ts:75、78。

反例：合法来源日志有 2000 条，最早一条仍属于活跃轮次的 old-group；主交互群已经改为 new-group。再正常记录一个新轮次后，旧来源被按插入顺序删除。resolve 同一旧 turn 从 old-group 变成 new-group。

影响：达到该条数且旧轮次仍继续提问时，后续新交互可能改变投递目标。不是已经发出的题卡凭空被移动，也不是每轮都会发生。

补测：活跃/等待回答/已结束来源分别参与清理，跨账号与多绑定；丢失来源后不得静默回落到别群。

### F06 · P2 · 全局停止跳过连接中的账号（上轮遗留）

位置：src/server/account-manager.ts:464、483、502。

反例：monitor 为 connecting，entry 为 starting；调用 stopAll 后其 AbortSignal 仍未 abort，账号仍是 starting。

影响：全局停止或启动失败清理后，旧监视器/服务对象还在；配置切换也只选择 running 账号。

补测：connecting、error、reconnecting，与 start/stop/refresh/remove 并发；按资源存在性清理，并忽略旧代次的回调。

### F07 · P2 · IDE 授权因改显示名或目录次序而失配（新增）

位置：src/ide/manager.ts:130、131；src/ide/access-server.ts:145、380。

反例：同一 owner/host/project/workspace，入口 ID 保持相同；仅修改 projectName，或重排完全相同的 rootPaths，authorizationScope 已改变。原浏览器 token 对新 scope authenticate 返回 undefined。

影响：无需扩大任何目录权限的展示变化也会要求重新授权；连接的周期核验使用同一 scope，可因此断开。这是可以触发断开的条件，不能据此断言用户以前每次断开都由它造成。

补测：改名、同目录集合重排、存活别名切换应保留权限；目录扩大、主机/owner 改变和撤销代次变化仍必须失效。

### F08 · P2 · Web 网络断连丢失提交不确定性，原文重回待发送框（新增）

位置：src/web/app.js:2382、1758；服务端流接口 src/server/http-server.ts:707。

反例：浏览器已读到一条 progress，再模拟 reader.read 网络异常。streamApi 抛出的错误没有 submission；sendSessionMessage 会因此重新填回原文/文件，下一次发送又创建新 requestId。对没有 done 事件的正常 EOF 也没有严格的结束校验。

影响：可能已接收的任务被呈现为可直接重发，用户再点发送可能产生新执行；不是当前代码会自动重发。

补测：fetch 前、收到 headers 后、progress 后、accepted 后、done 前后断连及截断 NDJSON；保留原 requestId，区分明确未提交与接收未知。

### F09 · P2 · 旧 Web 刷新响应覆盖较新绑定快照（新增）

位置：src/web/app.js:397；同类风险在 loadSelectedSessionMessages:1392。

反例：调用真实 refreshData 函数，第一轮 5 个 API 响应暂停，第二轮先返回 version=2；随后释放第一轮，state.sessions 被写回 version=1。用 VM 运行原函数，只替换网络和渲染依赖。

影响：绑定、授权状态和执行列表可能显示倒退，造成“又没绑定了”的错觉。服务端是否真改绑应独立核验；本反例只证明前端陈旧快照覆盖。

补测：后台 5 秒轮询与手动刷新/操作后刷新交错、同 session 历史并发读取，以及读请求期间切账号或切 session。

### F10 · P2 · Taskboard 替换先关闭旧服务再验证新配置（上轮遗留）

位置：src/taskboard/lifecycle.ts:15、19。

反例：已有可正常关闭的旧服务；提供非法的非 loopback 替换 URL。apply 抛错时旧服务已经关闭，当前 service 为空。

影响：一次无效配置即可让原可用服务下线；仅涉及 Gateway 拥有的集成生命周期。

补测：URL 非法、端口占用、启动失败、持久化失败、旧服务关闭失败及连续保存；验证/准备前不得先销毁旧资源。

### F11 · P2 · 企业微信同步入站异常被 SDK 吞掉，绕过 Gateway 错误回执（新增）

位置：src/channels/wecom.ts:33、44。

反例：claimMessage 因回执写入故障同步抛错。它位于 onMessage 的 Promise.catch 之前。用已安装的真实 SDK MessageHandler 分发，SDK 记录一次错误，而 Gateway onMessageError 调用为 0。

影响：用户可能没有收到任何失败回执。已沿 SDK 复核：该 SDK 会捕获这个同步异常，所以不能把此问题写成“必然导致整个 Gateway 崩溃”。

补测：解析错误、缺字段、同步认领/落盘错误、异步处理错误、错误通知再次失败，均进入同一有界错误报告边界。

### F12 · P2 · 大小写不同的合法附件路径被当作同一文件（新增）

位置：src/bridge/actions.ts:79、164。

反例：同一 send 动作包含 /work/Report.csv 和 /work/report.csv；返回 send 列表只有 1 个。去重无条件转小写，没有按文件系统语义处理。

影响：区分大小写的本机卷或远程主机上，两个不同制品只发送一个。

补测：POSIX 不同大小写文件、Windows 语义、同路径多种媒体类型与跨动作块；不得用统一小写破坏真实路径身份。

### F13 · P3 · 以两个点起头的合法子目录被误判为越界（新增）

位置：src/state/config.ts:121；同类实现 src/server/account-manager.ts:2450。

反例：isWorkspaceAllowed('/allowed/..cache', ['/allowed']) 返回 false；该路径是合法子目录，没有跳到父目录。实现把所有 startsWith('..') 都当成父目录。

补测：相对路径 '..'、'../x' 必须拒绝，'..cache'、'...data' 应按真实目录允许；同时覆盖路径分隔符与不同盘符。

### F14 · P2 · Desktop 代码批注指令原样泄漏进 IM（截图追查新增）

位置：src/bridge/actions.ts 的 parseActionBlocks；src/server/thread-event-hub.ts:1079；src/channels/dingtalk-markdown.ts 的两种正文投影。

截图里，已呈现一遍的 review 结论后又出现了整段 ::code-comment{title=... body=... file=...}，长绝对路径挤占正文。当前基线的共享正文解析仅移除 Gateway action blocks，没有为 Desktop 专用展示指令提供语义投影。

反例：同一带 Desktop 批注的答复通过 parseActionBlocks、DingTalk 卡片正文和普通文本正文处理后，三者仍包含原始 ::code-comment 指令。这个测试核验当前源码，不借截图中的 review 请求启动任何任务。

影响：Desktop 上的代码批注控件在 IM 中变成原始属性串，正文重复且布局失控。不能只在某一张卡上加换行：需共享解析为安全展示数据，再按进度、最终卡、@ 卡、历史和纯文本能力渲染；不执行这些展示指令，不改写代码块内的字面示例。

补测：多条相邻指令、跨行、转义引号及正文中的花括号；正文与批注结论重复、仅批注无正文、畸形/未知指令、代码块和引用中的字面示例、长路径、静态/流式/普通文本/@ 卡与历史投影。用户说排版处理后仍需继续自检，本项作为跨界面展示边界核验；当前审计基线未把它标成已修复。

### F15 · P2 · 登录刷新失败后状态卡在 confirmed，无法由同一轮询恢复（新增）

位置：src/server/login-manager.ts:57；src/web/app.js:2032。

反例：假扫码接口确认后，真实 LoginManager 先写 record.status=confirmed，再保存账号并 await refreshAccount；让 refreshAccount 抛错。第一次 poll 抛错，第二次 poll 却直接返回 confirmed、account 缺失，而且 refreshAccount 没有再次调用。

影响：扫描身份确认与账号刷新完成混为一个状态，失败后对原登录记录的轮询不再尝试完成剩余步骤。前端遇错会停止轮询，而并发或后续轮询又可能看见“已确认”，不能据此判断渠道真的就绪。

补测：保存失败、账号刷新失败/延迟、并发 poll、已保存但未启动、刷新成功后响应丢失。应显式区分身份确认、账号已保存、渠道刷新待完成和真正完成；不得为重试再扫一次或重复覆盖别的账号。

## 模块检查记录

| 模块 | 本轮主要检查点 | 结果 |
| --- | --- | --- |
| 入站、ACL、提交与原生后端 | 最后写入核验、等待边界、Home、接收与观察分离 | F01、F02、F04 |
| 原生队列与跟随 | 上轮终态证据修复的回归、在途集合、完成/投递区分 | 既有队列回归通过；生命周期缺口归 F03/F06，不重复列已修复缺陷 |
| 审批、问答与交互路由 | 原生可选范围、持久化来源、异步答案、主群切换 | F05；本轮未另确认审批选项映射的新缺陷 |
| IDE、授权与入口 | 稳定身份、scope、别名、根目录、30 秒连接核验 | F07；未用本机测试代替手机网络验收 |
| 账号与配置 | start/stop/reconfigure、恢复资源与事务 | F03、F06、F10 |
| Web UI 与 HTTP | 刷新代次、流断连、回执分类与重试身份 | F08、F09；登录恢复 F15 |
| 渠道、媒体与错误处理 | 解析/认领异常、路径去重、SDK 边界 | F11、F12；跨界面批注投影 F14 |
| 状态、目录与持久化 | 原子写、快照代次、边界判断、来源淘汰 | F05、F13；没有把合法 JSON 等同于语义一致 |
| Taskboard 集成、发布、安装与重启 | Gateway 拥有的生命周期、独立制品、代码/状态回滚边界 | F10；本轮没有部署或修改独立子工程 |
| 私有知识/Skill/目录呈现 | 动作解析、引用隔离、消息控制边界、目录选择 | 关联既有回归和逐文件清单；未把没有新增确定缺陷写成模块无错 |

## 修复与验证优先级

第一批：统一最后写入核验和绑定条件提交（F01/F02），登记容量恢复并保护配置切换（F03），修复本地 Home 路由（F04）。这些是执行与身份边界，应先于排版调整。

第二批：固定活跃交互来源（F05），完整停止账号资源（F06），把 IDE 安全 scope 与展示字段分开（F07），处理 Web 回执/快照代次（F08/F09）。

第三批：配置准备/切换事务（F10）、渠道同步异常边界（F11）、附件及目录路径语义（F12/F13）、共享展示投影与登录恢复（F14/F15）。其中配置事务应与账号生命周期一起设计，不能再补各入口的孤立 if。

修复时把对应反例改成“必须拒绝旧写入/保留新绑定/保留正确授权”等正确行为断言，纳入正常回归门禁；增加真实 IPC/HTTP 与隔离 Codex 验证。跨入口、跨主机、重启、撤权和配置切换需组合测试。未确认接收的任务不自动重发，来源丢失不猜另一群，发布保留已有授权与绑定。

## 审计材料

- file-review.csv：198 个文件的静态扫描、人工复核层级及 V8 统计。
- counterexamples.test.ts：本轮新增缺口的隔离反例（含 IDE 两种变更）。
- lifecycle-open.test.ts、taskboard-open.test.ts：3 类上轮遗留缺陷在当前基线的重新确认。
- counterexamples-output.txt：16 个反例的实际输出。

这些反例位于 docs/audits，故意不加入正常 test/*.test.ts：它们当前断言的是缺陷行为。应从仓库根目录用安装好的 tsx 运行这三个测试文件；全部使用临时目录、假后端、本机假流或只记录环境的假 Codex 可执行文件，不提交真实用户任务。Windows 下的假 Unix 可执行文件反例需使用对应平台夹具。

完整测试与静态检查不是穷尽所有运行组合的证明；本轮没有宣称每个文件每一行都已人工证明正确，也没有宣称“全项目已经没有隐藏 bug”。
