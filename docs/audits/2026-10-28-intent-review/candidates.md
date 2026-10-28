# 本轮候选与验证过程

所有候选均需核对调用链、现有测试与隔离反例；不以疑点数量宣传 bug 数量。

- C01 配置边界：loadConfig 仅校验部分字段，`...loaded` 可将非数组 allowedSenderIds、非法缓冲参数等直接带入运行时。需检查入口是否最终强校验、是否可能发生字符串 includes 的部分身份匹配。非法安全配置应失败关闭且保留原文件，不能以宽松默认值扩大权限。
- C02 Taskboard IPv6：HTTP configSchema 使用 `::1`，URL.hostname 实际为 `[::1]`；Client/embeddedTaskboardPort 已接受 `[::1]`，但 embedded listener 仍只绑定 127.0.0.1。检查配置 API、启动、健康检查与客户端的统一契约。
- C03 安装脚本 Windows：直接 spawn npm.cmd 且无 shell/CLI 解析，与已有更新器的 Windows npm 启动规则不一致。需通过无 shell 的 bundled npm CLI 选择及测试确认，不使用有注入风险的 shell 拼接。
- C04 Web 异步表单：knowledge-bases.js 保存未绑定 dialogSession；旧保存返回后可能关闭新打开的编辑对话框。IDE refresh 缺少请求代际，旧 GET 返回可能覆盖新保存/编辑状态。需真实 DOM 异步反例，不能只检查源码字符串。
- C05 服务生命周期：index.ts 启动失败清理顺序遇 stopAll 拒绝可能跳过 HTTP/Taskboard/锁释放；restart helper 未确认 spawn 就进入服务退出。需故障注入，核对是否已有下层兜底。
- C06 本地知识库主机：resolveQaKnowledgeBase(kind=project) 未显式拒绝远程 project，却通过本机 LlmWikiInspector 读取其 workspace；Web account-mode-settings 同样列出所有项目。需检查上游是否已限定本机，不能凭远端目录字符串访问本机同名路径。
- C07 文档默认值：README /sessions 描述默认每页 30，但 DEFAULT_SESSION_PAGE_SIZE 为 10。核对其余帮助、配置、界面默认值及历史设计文档标识。
- C08 Taskboard start 配置提交：/api/taskboard/start 先 apply 再 saveConfig，持久化失败可能留下运行服务与禁用配置不一致；与完整 /api/config 更新的事务/回滚契约比较后复现。
- C09 源码发行与 Web updater：当前 package 为 private 且 README 明确只经 GitHub 分发，但默认更新检查仍查询同名 npm registry，UI 可能给源码部署显示不可执行的安装操作。当前源码安装会被 installCurrentRuntimeVersion 拒绝，不能将其夸大为已证实的任意包安装；需检查能力声明与展示。
- C10 首屏仍等待可选 Taskboard：昨天修正了 refreshData，但 bootstrap 仍 Promise.all 等待可选服务，随后还等待 issue 列表，导致可选服务挂起时整个页面首屏不可用。已补首屏独立运行时反例，原版失败；本地改为核心先渲染、可选状态后台读取。
- C11 主交互入口配置：InteractionRoutingJournal.setPrimary 先修改内存再持久化，写入失败时未来问题会被路由到未确认的新聊天。隔离 ENOSPC 反例在基线失败；仅对这个尚无外部副作用的配置变更改为写入后发布。原生已接受事实、未知提交及已尝试通知不能照搬回滚，保留它们的防重放语义。
- C12 动作解析位置：非可执行 Markdown token 没推进扫描位置；实际顶层动作与较早四反引号示例内部字节相同时，会剪掉示例而把实际动作 JSON 留在正文。LF/CRLF 两个基线反例均失败；本地拆分扫描和可见文本游标，动作与复制呈现相关回归通过。它是错误剪裁/呈现，不能夸大成单独引用即可执行动作。
- C13 普通构建的版本清单：npm run build:bridge 不处理已存在 dist/build-info.json；源码更新重新编译后可能仍报告旧的封存版本。需隔离复现后明确普通构建与封存发布的身份契约，不在 live dist 试验。
- C14 发布脚本并发：release-local switch 的预检与后续 bootout/制品切换之间没有互斥所有者；需验证并发进程是否能错误覆盖/回滚。尚未复现，不直接修改发布流程。

## 第一批边界验证

- C01、C06、C08 已有基线失败反例；已本地修复，尚未提交/上线。非法配置原文件保留，跨主机 QA 在任何本机检查前拒绝，启用 Taskboard 与完整设置共用串行 apply/persist/compensate 边界。
- C02 的最初“应放开 HTTP IPv6”假设已撤销：独立 Taskboard 实际明确仅支持 IPv4。修复是统一托管配置/启动的拒绝规则，保留外部 IPv6 client 能力，不修改独立 Taskboard。真实受支持服务与复用验证通过，非法配置不能关闭原监听。URL 中被忽略的路径、凭据、query、fragment 也拒绝。
- 未修改基线副本：/private/tmp/gateway-intent-baseline-d742feb。新增 8 个边界用例在原始源码上 7 失败、1 成功；受支持 IPv4 的正向用例原本通过。当前源码与配置/HTTP/Taskboard 既有回归共 56 通过，类型检查通过。
- 证据：/private/tmp/gateway-intent-boundaries-baseline.log 与 /private/tmp/gateway-intent-boundaries-fixed.log。最初错误支持假设的日志保留但不计作缺陷证明。

## 第二批状态/生命周期验证

- C04 知识库旧保存成功会关闭新编辑窗口，失败会覆盖新窗口反馈。成功/失败两个受控异步反例在基线均失败；本地保存绑定 dialogSession，打开新窗口恢复自己的提交控件。
- C05 启动失败时 stopAll 再失败，HTTP、Taskboard 和锁均未清理，且丢失原始启动异常。根入口故障注入已复现，现使用所有资源尽力清理后再释放所有权，并保留原错误。停止由同一 Promise 合并，避免两个信号绕过未结束的清理。
- C05 补充：重启辅助进程尚未确认 spawn 就返回成功，可能导致原服务先退出。修复为确认 spawn 后才允许退出；模拟 OS 启动失败反例在基线失败。最初测试 fixture 缺少 URL 全局所致失败不计为产品缺陷证据，最终复现见 restart-baseline-final.log。
- C04（知识库）、C05、C10 的运行时回归已通过；IDE refresh 的请求代际部分仍待查。证据：/private/tmp/gateway-intent-ui-lifecycle-baseline.log、gateway-intent-restart-baseline-final.log、gateway-intent-restart-fixed-final.log。没有提交、push 或上线本轮变更。
- C11 修复后与既有路由/持久化测试共 15 通过。中途新增测试误用了 mock.restore，修正为 t.mock.restoreAll 后重新验证；该 fixture 错误不计为产品缺陷。C12 的证据分别为 gateway-intent-actions-baseline.log 与 gateway-intent-actions-fixed.log。

## 构建与发行边界验证

- C03 已确认并本地修复：Windows 不能直接以无 shell 的 spawn 执行 npm.cmd，参见 [Node 官方文档](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)。改为解析 npm-cli.js、通过 Node 启动且保留参数边界。真实脚本的 Windows 平台注入覆盖继承 CLI 和带空格 bundled 路径，基线均失败；未在 Windows 实机验收。最初 VM 的跨 realm Error fixture 错误不计入缺陷证明。
- C09 已确认并本地修复：源码部署更新检查直接返回真实源码更新能力，不访问同名 npm registry、不显示“已是最新”或不可执行安装。既有 npm 兼容路径与显式安装器继续保留，测试为其明确设置 npm 目录，而不是根据注入 fetch 伪造生产能力。
- C13 已确认并本地修复：普通构建在编译前使旧封存 manifest 失效；隔离编译部分写入再失败仍不能冒称旧版本。仅发布准备流程在检查后生成新的封存身份。
- C14 已确认并本地修复：两个不同发布目录能够同时通过同一服务的预检，在 await health 处交错。真实发布函数的隔离并发反例基线失败；现以同一 state/release.lock 独占覆盖准备、封存、切换、验证和回滚，结束后释放。无不安全的自动陈旧锁删除：进程崩溃遗留锁需核实记录中的 PID 已退出后由运维清理。测试没有执行 launchctl 写操作，也没有接触线上状态。
- C07 README 默认分页和排序说明与当前实现不一致，已校正；历史 updater ADR 已标记兼容范围。
- 构建/安装/updater 相关 21 项：20 通过、1 Windows 专用跳过；发布相关 17 项通过。日志 gateway-intent-build-baseline-complete.log、gateway-intent-build-fixed-complete.log、gateway-intent-release-baseline.log、gateway-intent-release-fixed.log 均位于 /private/tmp。
- C04 IDE 旧 GET 覆盖新 GET/保存的两个基线反例失败；增加请求代际后，与首屏/知识库/IDE 重配置共 35 项回归通过。

- C15 IDE 关闭异常边界：一个入口 close 失败会跳过统一项目进程 manager.close。原实现隔离故障注入失败；现等全部入口尝试后始终关闭项目进程并聚合错误，不让单个失败资源短路清理。尚未运行本轮完整回归。

- C16 摘要流分块空白丢失：每个 delta 后 trim 累积原文，独立空格/换行分块被删，单词和段落粘连。基线分块反例失败；现仅在展示时 trim，保留累计原文。
- C17 App 目录不可用时的存储目录后备忽略 persistence=archived/all，始终返回未归档会话。三个模式的实际目录实现隔离验证中 active 通过、archived/all 失败；现按指定范围查询、去重、排序和限数，默认仍未归档。
- C18 异常原生 fileChange.changes 中的 null 会使同步 notification 回调抛 TypeError，存在中断整个进程的风险。畸形事件隔离反例失败；现跳过无效可选条目，保留有效文件进度；不改执行状态。

- C19 Desktop 历史排序只使用 turnStartedAtMs，虽然同一适配器已支持旧 startedAt 秒字段。后翻旧页时会把旧轮次误放到末尾；基线旧时间字段反例失败，现排序/时间展示共用同一时间解析。
- C20 CLI 历史将带 error 的 task_complete 一律标成 completed。基线原生事件文件反例失败；现保留 failed 和脱敏 failureCode，不伪造实时 systemError 或保留上游私密错误正文。
- C16-C18 与 App Server 回归 45 项通过；C19/C20 继续验证 Desktop/CLI 适配范围。

- C21 观察器关闭：ThreadEventHub.stop 直接 await 正在扫描的任务；该任务因持久化等错误拒绝后，会跳过进度计时器 suspend。基线故障反例失败；修复等待全部观察工作结算、始终清理计时器，再聚合报告错误。相关回归通过。

## 继续核对的疑点（未算作已确认缺陷）

- 本地 Desktop 项目首根目录不存在时 readCodexDesktopProjects 直接丢弃项目，是否应保留原生身份并显示 unavailable；需核对使用方/既有迁移约束和测试，不直接改变绑定。
- ThreadEventHub 的全局 scan 在每个订阅 Promise.all 等待最慢 25 秒读取/卡片更新，可能拖慢其他健康远端订阅的下一次轮询；本地 FS 活动是独立路径。需隔离时序验证与原有 refresh/同步契约分析后决定调度方式。
- 资源边界：App Server turnEvents/CLI stdout 诊断保留，以及 session monitor 的新增区间读取没有统一容量限制。需区别最终答复/执行事实与可裁剪诊断，不能靠截断原生状态掩盖任务。
- Exec 新会话的原生 thread.started 直到退出后才解析，运行期间无法按该 ID 停止；需核对能力边界与回调语义后补真实假子进程反例。当前 /stop 不会因此误停其他会话，因为无 threadId 时明确返回 not-active。

补充验证：C19 的 Desktop/IPC 回归 52 项通过；C20 的 CLI/协议回归 22 项通过。此前误写了不存在的测试路径，Node 只运行其余匹配测试；52 项最终记录已使用确切存在的测试文件。IDE 清理最初在沙箱监听受限失败，重新获准临时监听后 25 项通过；该环境失败不计为产品 bug。

- C22 主目录离线导致原生项目被目录适配器丢弃，IDE 会回退到旧 rootPaths。已确认：基线反例失败；现保留完整原生身份/目录集并标为 unavailable，禁止缓存范围获得 IDE 入口，目录恢复后仍为同一身份。macOS /var 与 /private/var fixture 别名导致一次正向断言失败，已用真实临时根目录隔离并复验，非本候选的缺陷证明。相关回归通过。
- C23 管理首屏/API 配置保存回执直接等待可选 Codex 状态/运行配置/模型列表，无独立期限；上游挂起会卡住管理功能，设置已持久化也收不到成功回执。真实临时 HTTP 服务+挂起假检查器在基线复现；增加 2 秒只读观察边界与在途合并，超时返回明确“尚未核验”及已配置默认值，不影响任务期限，不重复原生操作。最多保留 16 个未结束观察键，异常/超时不触发新的并发探测。HTTP/持久化相关 25 项通过。
- C24 Web 设置保存已成功后仍 await Taskboard 刷新，可选刷新故障会使保存按钮长时间禁用，或显示成保存失败。基线隔离 UI 反例失败；现先更新核心页面并确认保存，Taskboard 由既有独立后台刷新负责。

- C24 补充：修正测试 VM 未注入 AbortSignal 导致后台调用未实际进入的 fixture；现在断言真实启动一次后台读取，并等待其错误处理结束。Web 相关 20 项通过，不能将先前 fixture 的 unhandledRejection 当作产品故障。
- C25 目标表单歧义：原生表单把 objective 直接拼为 /goal 正文，pause、clear 等文字会被当作控制操作。7 个目标（含多行）隔离反例在基线失败；现显式发送 /goal set 正文，同时保留目标正文换行。
- C26 原生卡片重复复制指令：飞书已能直接操作的 Taskboard 表单/按钮仍附整组文字命令。基线呈现反例失败；现原生卡片保留原生操作，纯文本 fallback 保留完整可发送命令。C25/C26 与卡片、Taskboard 适配回归共 33 项通过。
- C27 异步控制缺少绑定租约：模型查询返回时才选当前 session，切换后会修改新 session；已撤销个人准入仍可修改原设置；会话 inspect 返回后还会复活期间已解绑的绑定。3 个原始基线反例均失败；控制变更在查询前冻结绑定、项目、模式及发送者，并在实际修改前复核。扩展到项目选择、新建、QA 模式及推理设置的同类边界；当前相关 26 项回归通过，继续补交叉场景。

尚待验证：网页多个设置/新建/重命名对话框没有统一请求归属，旧保存/旧目录查询可能关闭或覆盖新打开的表单；新建 session 的保存没有在途单飞保护。飞书 claimMessage 在业务 try/catch 之前，存储异常可能被 SDK 吞掉而未到应用错误边界。均需运行时反例后再修改，不计作已确认修复。

## 后续确认与收束（当前仍未发布）

以下结论取代上方同编号的“待查”状态；日志均在隔离 `/private/tmp/gateway-intent-*`，未调用线上会话执行或真实 IM 发送。

- C27 补充：异步选择开始时尚未绑定，也必须冻结 detach/绑定代际；否则查询中发生 leave 或 bind→leave 会被迟到结果复活。新增两项原版失败反例。`/policy steer` 的能力读取同样补复核（C31）。
- C28 Web 对话框归属：账号设置/删除、渠道新建、项目及会话新建/重命名、通知和 Taskboard 操作的旧回执会关闭或覆盖新窗口，同一提交可重复启动。增加统一开窗租约、提交单飞与只反馈当前窗口的边界；不撤销已经提交的写入。`intent-review-web.test.ts` 使用实际 JS 运行时模拟旧成功、旧失败、重开、迟到目录及重复提交，原版失败，修复后通过。
- C29 飞书入站持久化 claim 异常在 SDK 业务错误边界之外，三个入口会丢失应用错误反馈。claim 统一报告后停止本次分派；不假称业务已接收。`intent-review-feishu-boundary.test.ts` 的消息/卡片/菜单三个反例原版失败。
- C30 飞书缺少 conversationKind：仅用原生 `chat_type` 的 p2p/group 事实映射 direct/group，未知保持未知，不猜 ID。两个原版失败反例和两个未知正向场景通过。C29/C30 最终基线 7 项中 5 失败、2 原本通过；中途缺少 SDK API shape 的 fixture 错误不计作缺陷。
- C31 策略读取后权限/换绑校验遗漏：`/policy steer` 等 inspect 返回后可能修改已撤权或新绑定的会话。两个原版失败反例，复用 C27 的控制租约；不增加另一个权限事实来源。
- C32 CLI 运行中身份：thread.started 原先到进程退出才解析，新会话运行中无法按其真实 ID 停止。现在增量读取第一条有效身份、立即更新活动执行记录并等待身份持久化回调；不伪造 turn 接收回执。真实假子进程原版失败，补测碎片记录、中文、重复身份、异步 journal 失败及停止其他线程无效。
- C33 IDE 本机路径别名：原生 canonical root 与 managed workspace 的 symlink/`/var` 别名会被计为两个根，误拒同一项目。只对本机根比较 realpath、保留会话实际入口；远端路径从不借本机 realpath 推断。symlink 原版反例失败，包含离线根目录的正向/拒绝场景通过。
- C34 内存资源边界：App Server raw 事件及 CLI stdout/stderr 无界累积；rollout monitor 一次分配整个新增区间。原版 API 反例失败。诊断尾部与完整答复分开，raw 256 KiB、CLI stderr 64 KiB；CLI 单条 JSONL 超 16 MiB 明确结果未确认，不把截断答复报成功、不自动再执行。monitor 按 1 MiB 读取并只在完整行推进游标，补跨 UTF-8/未结束尾行场景。单条完整 rollout 记录仍需组装，不能宣称全进程内存有总上限。
- C35 浏览器实际窄屏：375px 下聊天头部 right=520.625，IDE 按钮被裁。调整可收缩/换行后 right=347，三个按钮均在视口内，浏览器 console error 为空；这是浏览器布局验证，非真实手机网络验收。
- C36 IDE 活动轮询并发：3 秒 poll 可堆积，旧结果覆盖新显式刷新/保存后的活动和请求状态。增加在途合并、刷新代际、后台及 busy 检查；两个原版运行时反例失败，修复后通过。
- C37 App Server 无订阅完成通知遗留 payload：无人等待的完成 turn 永久留在 completed/raw/text 等缓存。原版 100 次未观察完成反例失败；现在只为准确会话的在途执行、未知 start、自己的原生队列或已绑定流保留接收竞态，其余释放 payload。不同线程的长操作/队列不能扩大此保留范围。相关后端/队列/恢复测试通过；接受事实和完整答案不按诊断预算截断。
- C38 动态选择身份：模型/推理强度按钮传序号，目录重排会选择另一值；项目旧卡片在刷新后也可能选择新编号对应的项目。三个隔离原版反例均失败。模型/effort 按钮传实际值，项目按钮带当前列表版本；旧无版本原生卡片要求刷新，手动文本编号兼容保留。当前选择/卡片/分页回归 18 项通过。

### 疑点的最终分类

- Desktop 首根不可用：已由 C22 确认为缺陷并修复，不再留作疑点。
- CLI 运行中身份、诊断/读取资源：已由 C32/C34/C37 确认并修复。
- Hub 全量后台 polling 按批次等待最慢读取，是现有有界批调度；健康结果在该批中立即发布，定向 synchronize 不等待其他读取。已加隔离 barrier 场景确认这两个边界。下一次后台批次仍可能被慢读取拖后，这是已记录的调度限制，本轮没有把它改成无所有者的后台 fire-and-forget，也不宣称已消除所有轮询延迟。
- C14 新增互斥锁本身也注入 fstat 失败：发现描述符未关闭，已在本轮新增实现上用失败测试修正；不是原始基线缺陷。现在始终关闭 fd，无法核实 inode 时保留锁，禁止擅自删除他人锁。相关发布测试通过。

### 回归说明

- 中间一次全量回归 2028 项：2027 通过、1 Windows 专用跳过；之后又补 C37/C38 及额外边界。后续 2036 项也通过（2035 + 1 跳过），但不替代最终固定提交的发布验证。
- 新 helper 自身属性测试只在当前实现验证；基线反例仅调用基线已有 API，不能用“旧版缺少新 helper 导入”充当缺陷证明。
- 上述条目是过程记录，最终阅读范围和结论见 REVIEW.md，不以回归数量替代文件阅读覆盖。

### 最终差异核对

- 基线纳入的 475 个文件均已有检查记录；其中自有代码/测试/说明按正文阅读，8 张图片按实际查看与引用核对，lockfile 和两个历史大型生成清单按全文件结构解析，后者不计为逐行源码阅读。新增 helper、测试和改动后的文件另记录最终散列与函数定位。
- C38 改动的自测发现模型 ID 是数字或 default 时会与命令语法冲突；两个用例在本轮中间实现失败，在原始基线原本通过，属于本轮改造的兼容退化，不充当原始缺陷证明。已增加显式 ID 参数，仅在有歧义时使用；手动 default 仍恢复继承。最终原始基线的选择测试为 5 项：3 失败、2 原本通过。
- 完整回归最终工作版：2040 项，2039 通过，0 失败/取消，1 Windows 平台专用跳过；显式启用隔离原生队列集成。类型检查通过。最终 diff 发现测试 fixture 重复指定 packageRoot，去掉被后续同名属性覆盖的无效项，updater 相关测试再次通过；该清理没有改变产品行为。
- 上线必须另以固定提交 prepare 的完整回归、制品散列、seal 及切换后 verify 为准；本文件不将源码检查等同于线上验收。
