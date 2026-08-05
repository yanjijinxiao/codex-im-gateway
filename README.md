<h1 align="center">Codex Channel Bridge</h1>

<p align="center">
  <img src="src/web/favicon.svg" alt="Codex Channel Bridge logo" width="128" height="128" />
</p>

<p align="center">
  <strong>中文</strong> | <a href="./README.en.md">English</a>
</p>

<p align="center">
  <strong>通过个人微信、企业微信和飞书连接本机 OpenAI Codex。</strong>
</p>

`codex-channel-bridge` 是一个跨平台、本机运行的 Codex 消息桥接服务。启动后会打开 Web 管理页；用户可以添加个人微信、企业微信或飞书渠道，从聊天窗口控制本机 Codex、管理项目、绑定会话并接收任务结束通知。

```text
个人微信 / 企业微信 / 飞书 <-> Codex Channel Bridge <-> 本机 Codex <-> 已绑定项目
```

服务与凭据都保存在本机，管理页面不会开放到局域网或公网。

## 核心功能

### 1. 微信多媒体输入与文件回传

微信端可以发送文本、图片、音频、视频和文档给 Codex，单个附件最大 100 MiB。Codex 也可以把本机图片、视频和文件作为微信原生消息发回。

<p align="center">
  <img src="docs/images/screenshots/wechat-media-input-output.png" alt="通过微信向 Codex 发送文件并接收回传" width="420" />
</p>

### 2. 微信原生语音指令

支持微信语音转写，可以直接用语音向 Codex 下达任务；没有转写文本的语音会作为本机附件交给 Codex 处理。

<p align="center">
  <img src="docs/images/screenshots/wechat-voice-command.png" alt="通过微信语音向 Codex 下达指令" width="420" />
</p>

### 3. 自然语言工作台与底层命令

消息渠道默认使用自然语言工作台，可以直接发送“查看任务”“切换到 codex-weixin”“新任务：补充飞书卡片”“记录：测试通过”“提交验收”“通过”或“退回：缺少运行态验证”。普通消息会先由 AI 做语义识别，而不是匹配固定关键词；只有高置信度且通过结构化校验、动作白名单和参数校验的工作台意图，才会映射为 `/project`、`/task` 等稳定命令。低置信度、识别失败或普通项目讨论会继续交给 Codex 自然对话。斜杠命令保留为可审计、可脚本化、绕过语义识别的底层能力。完整命令还可以管理会话、个人知识库、模型、推理强度、过程进度与 Codex 运行审批，并查看当前 Codex 账号剩余用量。

<p align="center">
  <img src="docs/images/screenshots/wechat-cli-commands.png" alt="在微信中使用 Codex CLI 原生命令" width="420" />
</p>

### 4. 过程进度反馈

过程进度默认开启。Codex 处理长任务时会持续向微信发送中间进度，Web 端则折叠显示处理过程和用时，最终答案保持完整。

<p align="center">
  <img src="docs/images/screenshots/wechat-process-progress.png" alt="Codex 长任务的微信过程进度反馈" width="420" />
</p>

### 5. 多消息渠道接入与管理

一个服务可以并行运行多个个人微信、企业微信和飞书渠道。每个账号拥有独立的联系人授权、附件、会话、个人知识库和运行状态；移除个人微信账号时还可以选择保留历史，重新扫码后继续使用。

管理页的“添加渠道”同时支持个人微信扫码、企业微信智能机器人和飞书企业自建应用。企业微信与飞书使用官方长连接 SDK，不需要为本机服务配置公网回调地址。每个 Codex 项目都可以开启“任务结束通知”，选择任一已添加渠道和接收会话（或用户）ID；该项目下从聊天端或 Web 发起的任务，无论成功还是失败，结束后都会发送项目、任务和结果摘要。

聊天端任务需要运行命令、修改文件或申请额外权限时，审批请求会发回发起任务的同一账号和联系人。回复 `/approve A1`（短写 `/ok A1`）批准一次，或 `/reject A1`（短写 `/no A1`）拒绝；10 分钟未回复会自动拒绝。审批编号按账号和联系人隔离，其他渠道或联系人不能代为处理。

<p align="center">
  <img src="docs/images/screenshots/web-multi-account.png" alt="Codex Channel Bridge 多账号管理" width="100%" />
</p>

### 6. Web 会话管理

Web 端可以按微信账号查看 Markdown 历史、继续同一个 Codex thread，并支持新建、重命名、切换、重置和删除会话。页面也支持直接发送文本和附件，每次最多 10 个文件、合计 100 MiB。

<p align="center">
  <img src="docs/images/screenshots/web-session-management.png" alt="Codex Channel Bridge Web 会话管理" width="100%" />
</p>

### 7. Web 全局设置

Web 端可以配置工作目录、Codex 后端、模型、推理强度和过程进度。项目只从 GitHub 获取源码并在本机运行，不通过 npm 发布或安装。

<p align="center">
  <img src="docs/images/screenshots/web-global-settings.png" alt="Codex Channel Bridge Web 全局设置" width="100%" />
</p>

## 环境要求

- Node.js `>=22`
- Git
- 已安装并登录 Codex CLI

```bash
npm install -g @openai/codex
codex --version
codex
```

## 本地运行

项目只支持从 GitHub 获取源码后在本机运行，不提供 npm 包，也不要执行 `npm install -g codex-channel-bridge` 或 `npm publish`。

```bash
git clone https://github.com/lsiten/codex-channel-bridge.git
cd codex-channel-bridge
npm ci
npm run build
node dist/server/index.js
```

这里的 npm 只用于按锁文件安装依赖和执行构建，不发布本服务。也可以执行 `npm run install:local` 一次完成 Bridge、内置 Taskboard、`taskctl` 和 `manage-taskboard` Skill 的本机准备。服务由 Node.js 直接启动并打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。完整的更新、启动和停止方法见 [本地运行指南](./docs/local-run.md)，Taskboard 的安装、数据迁移和回滚见 [内置 Taskboard 模块指南](./docs/taskboard-module.md)。

## 一键集成到 Codex

完成上面的本机构建并启动 Bridge 后，在仓库根目录运行：

```bash
npm run taskboard:codex
```

这个命令会用所需的本机调试参数启动 Codex，并一次性在原生侧边栏“插件”下增加两个同级入口：

- **渠道配置（消息渠道）**：打开 Codex Channel Bridge 管理页，可添加个人微信、企业微信和飞书。
- **任务面板**：打开内置 Taskboard，继续使用当前项目和 Codex 会话上下文。

两个入口共用 Codex 主工作区，不会额外打开浏览器侧栏。注入器负责保持入口有效，因此使用期间请保持该命令所在的终端运行；以后启动集成版 Codex 仍运行同一条命令即可。

如果 Codex 已经从 Dock 或 Finder 启动且侧边栏只显示旧的“任务面板”，请先完全退出 Codex，并停止旧的注入器终端，再从**当前仓库根目录**重新运行上述命令。直接启动的既有 Codex 进程无法在运行中补加调试端口，这也是只出现一个旧入口时最常见的原因。

首次安装可以按以下顺序完成构建、服务启动和 Codex 集成：

```bash
npm run install:local
node dist/server/index.js
# 另开一个终端，在同一仓库目录运行
npm run taskboard:codex
```

成功后，侧边栏应同时看到“渠道配置”和“任务面板”。Bridge 管理页为 [http://127.0.0.1:8787](http://127.0.0.1:8787)，Taskboard 为 [http://127.0.0.1:47823](http://127.0.0.1:47823)。

## 添加消息渠道

管理页点击“添加渠道”后，可以选择：

- **个人微信**：无需外部后台配置，直接扫码登录；未知联系人仍需在管理页明确授权。
- **企业微信**：在企业微信客户端创建智能机器人并启用 API 模式，将 Bot ID 和 Secret 填入管理页。
- **飞书**：在飞书开放平台创建企业自建应用，启用机器人和长连接事件订阅，将 App ID 和 App Secret 填入管理页。

企业微信和飞书都使用官方长连接 SDK，本机无需公网域名或回调地址。完整步骤、后台入口和接收 ID 获取方法见 [消息渠道与任务通知配置](./docs/channel-setup.md)。渠道凭据只保存在 `~/.codex-weixin/`，不会通过管理 API 返回浏览器。

每个渠道都可以在铅笔按钮打开的“渠道设置”中单独配置可选 Webhook，并选择通用 JSON、企业微信、飞书/Lark、钉钉、Slack 或 Discord。配置后，该渠道每条成功收取或发出的消息都会按所选平台格式额外 POST 一次；未配置时不会发起请求。管理 API 只返回是否已配置和平台类型，不会把可能包含签名密钥的 Webhook 地址返回浏览器。详细格式见 [Webhook 镜像](./docs/channel-setup.md#webhook-镜像)。

## 第一次接入个人微信

1. 打开管理页，在“设置”中确认 Codex 默认工作目录和允许的工作目录。
2. 点击“添加微信”，使用微信扫描页面二维码并确认登录。
3. 在微信中给新接入的账号发送任意消息。
4. 回到“微信账号”，允许页面中出现的待授权联系人。
5. 再次从微信发送消息，Codex 会在默认工作目录中开始处理。

继续添加账号时重复扫码即可。每个账号都有独立的轮询任务、联系人授权、入站文件和会话状态；单个账号发生错误不会停止其他账号。同一个微信账号因登录过期等原因重新扫码时，会刷新原账号凭据并保留本机备注、授权和会话，不会创建新的空账号。移除账号时可以保留会话历史；登录凭据会立即删除，同一微信用户以后重新扫码时会恢复原备注、授权和受管会话。

## 会话管理

“会话”页面只管理由本服务创建和使用的 Codex 会话，不扫描或接管其他终端产生的全部 Codex 历史记录。

选择一个会话后，右侧会从 Codex 自身保存的 thread 中读取历史用户消息和最终回复。聊天标题下方可以为当前会话选择模型、推理强度和过程进度，或继续继承全局设置；这与微信 `/model`、`/effort`、`/stream` 共用同一份会话配置。过程进度默认开启，在 Web 中折叠展示并记录处理用时，最终答案仍作为一个完整回复显示。可以直接在页面底部继续聊天，并通过回形针按钮将文本提示词和多个文件作为同一个 turn 发送；Web 和微信共用同一个 thread，上下文会保持连续。上传文件按微信账号和会话隔离保存在 `~/.codex-weixin/inbound/`，每次最多 10 个、合计不超过 100 MiB。

页面默认使用账号备注，不把内部 ID 当作账号名称。展开账号卡片中的“账号 ID”可以查看 iLink Bot ID 和 User ID；Codex thread id 仍不在普通页面显示。可以在“微信账号”页面给账号设置只保存在本机的备注；备注会同步用于会话标签。未设置备注时才使用“微信账号 1”这类默认名称。当前扫码和消息接口没有提供微信昵称、头像或个人资料查询能力，因此页面使用默认图标。

- 每个已授权微信账号有一个当前活动会话，也可以拥有多个命名会话。
- “切换”决定该联系人下一条微信消息继续哪个 Codex thread。
- “重置”清空本服务记录的 thread，下一条消息创建新上下文。
- “删除”只删除本服务中的会话记录，不删除 Codex 自身保存的历史文件。
- 微信中的 `/sessions` 会列出当前项目最近活跃的 10 个桥接或 Codex Desktop 会话、最近内容摘要和时间，并为每项生成 `R1`、`R2` 这类独立编号；发送 `/session R1` 会把真实 Codex thread 绑定到当前项目并继续对话。
- 微信中的 `/new` 会立即在当前项目创建并绑定新的受管会话。
- 同一个 Codex thread 在微信、企业微信、飞书、Web 或 Codex Desktop 中已有任务运行时，后续消息会按顺序排队并显示等待进度；前一条成功、失败、中断或超时后都会释放队列和“处理中”状态，不会并发覆盖同一会话。

## 项目、运行任务与通知

- 项目只能从本机 Codex 历史中添加，按工作目录归属；切换项目后，会话列表只显示该项目最近活跃的 10 个会话。
- 后台会展示每个项目绑定的会话和当前运行任务，并监听 Codex Desktop、Web 与聊天端会话的开始、完成、失败和中断状态。
- 已绑定的会话从 Codex Desktop 继续运行时仍计入项目运行任务；只有当前确实由桥接服务执行的同一 Turn 才会去重，绑定关系本身不会隐藏任务或结束通知。
- 每个项目可以独立开启任务结束通知，选择通知渠道和接收会话（或用户）ID；成功、失败和中断都会发送结果摘要。
- 通知按钮为绿色并显示“通知已开启”时表示配置生效；任务数量表示当前正在运行的任务数，不是历史会话总数。

渠道端只需选择一次项目，随后可以用原生按钮进入会话、任务或问答模式。任务模式按该项目的绝对目录打开同一个 Taskboard 项目，不要求先创建 Codex 会话；计划模式和目标则绑定当前项目的当前 thread，不会跨项目复用。完整状态模型、渠道卡片流程和验收规则见 [渠道项目工作台方案](./docs/channel-project-modes.md)。

## Taskboard 联动

Taskboard 已完整内置在当前仓库的 `taskboard/` 工作区，包含本机服务、React 管理页面、`taskctl` CLI、Codex Skill、Cloud/注入脚本和测试。Bridge 启动时会一并启动 `http://127.0.0.1:47823`，退出或重启时统一关闭；数据保存在 `~/.codex-weixin/taskboard/`。根目录执行 `npm install` 和 `npm run build` 会同时安装并构建桥接服务与 Taskboard，不依赖外部仓库或 Git 子模块。

“设置”页和管理后台的“任务面板”按绝对工作目录映射 Codex 与 Taskboard 项目。Taskboard 始终是 Issue 状态的唯一事实源，桥接服务不会复制看板任务到自己的状态文件。任务面板支持筛选、详情、评论和受控状态流转；没有真实 Codex threadId 的 Issue 只能查看，阻塞和提交验收必须填写证据，完成必须显式验收。为了保持本地安全边界，配置只接受 HTTP 回环地址。

管理页顶部提供“任务面板”入口，点击后会在当前主区域切换并展示已配置的本机 Taskboard，不会另开窗口；切回“消息渠道”“会话”或“设置”会恢复对应 Bridge 页面。

执行 `npm run install:local` 后，当前仓库的 `taskboard/skills/manage-taskboard` 和 `taskboard/cli/taskctl.mjs` 会链接到用户目录。聊天端可以通过自然语言、原生交互卡片或 `/task` 查询和推进同一套工作流；卡片表单直接执行受版本保护的 Taskboard 操作，需要 Codex 实际开始工作的领取动作仍使用该 Skill。阻塞、提交验收和退回会把证据与状态流转作为一个原子操作提交，完成继续要求显式验收；评论与聊天附件会带真实 Codex threadId 写回 Issue。Taskboard 进入“阻塞 / 待验收 / 已完成”时，会复用项目通知目标推送状态与最新证据，并和普通 Codex 完成通知去重。

常用命令：`npm run taskboard:start` 启动本机服务，`npm run taskboard:taskctl -- project list --json` 调用 CLI，`npm run taskboard:check` 执行 Taskboard 校验。

以 `taskboard/scripts/codex-injector.mjs --launch --watch` 启动正常 Codex 后，原生侧边栏会在“插件”下增加“任务面板”和“渠道配置”两个入口。两者是同级导航：点击后在同一个 Codex 主工作区内分别切换本机 Taskboard 和 `http://127.0.0.1:8787/` 的 Codex Channel Bridge 管理页，不会另开浏览器侧栏。当前 Codex 使用的 Chromium 会检查本机网络 iframe，因此必须由该启动器添加 `--disable-features=LocalNetworkAccessChecks`；直接从 Dock 启动且没有调试端口的既有进程无法在运行中补注入。常驻后台时可增加 `--adopt-normal-launch`；若安装时 Codex 已打开，再增加 `--defer-existing`，注入器会保留当前窗口，并在它退出后的下一次正常启动时短暂重启 Codex、补齐所需参数并完成注入。

## 消息渠道内命令

自然语言是默认入口：AI 以当前项目、可用项目和当前 Issue 上下文做语义识别，再把通过结构化白名单校验的意图映射到同一工作流；不依赖固定关键词，也不会直接执行模型自由生成的命令。低置信度或无法确定的消息按普通 Codex 对话处理。斜杠命令是确定性、可脚本化且不经过 AI 识别的底层能力。Taskboard 是状态唯一事实源：聊天只维护当前项目和当前 Issue 上下文；“记录”以及阻塞、验收等里程碑会写回 Issue，普通讨论仍留在 Codex thread。飞书会把 Taskboard Issue 显示为交互卡片，并按状态提供“开始处理”“查看详情”“提交验收”“通过”“退回”等按钮；按钮回调也执行下列同一组命令。

```text
/help            /h           查看命令
/status          /st          查看当前会话、工作目录、thread、backend、实际模型和推理强度
/balance         /bal         查看当前 Codex 登录账号的套餐、剩余额度和重置时间
/memory          /mem         查看此微信账号自动沉淀的个人知识库
/memory <on|off>              开启或关闭自动沉淀和知识注入
/memory forget K1 /mem f K1   删除一条个人知识
/memory clear     /mem c      清空个人知识库（需要再次确认）
/project list    /p l         查看此微信账号已绑定的 Codex 项目
/project add     /p a         查看可从 Codex 历史添加的项目
/project add C1  /p a C1      按 C 编号添加 Codex 历史项目
/project P1      /p P1        切换已绑定项目
/project switch 完整项目名    按名称切换已绑定项目
/project rename P1|名称 /p rn P1|名称  重命名项目
/project delete P1      /p d P1        移除没有运行任务的项目
/mode [session|task|qa] /v    查看或切换当前项目工作模式
/qa                /q        进入绑定 llm-wiki 的问答模式
/plan [on|off]               切换当前会话的 Codex 原生计划模式
/goal [目标|pause|resume|complete|clear] 管理当前 thread 的 Codex 目标
/task            /tb          查看当前项目未完成的 Taskboard Issue
/task ISSUE编号              绑定并继续 Issue 对应的 Codex thread
/task new 标题               创建、领取并开始处理新 Issue
/task todo 标题              创建待办，但不开始处理
/task start ISSUE编号        领取并开始处理已有 Issue
/task detail ISSUE编号       查看 Issue 状态、说明、最新记录和可用操作
/task comment ISSUE编号 内容  添加带当前 threadId 的评论；可同时发送附件
/task attach ISSUE编号       把当前消息附件上传到 Issue
/task block ISSUE编号 原因   记录阻塞原因并标记阻塞
/task review ISSUE编号       验证、记录证据并提交验收
/task accept ISSUE编号       按验收门禁处理；只有用户确认后才可完成
/task return ISSUE编号 原因  从待验收退回处理中并记录原因
/sessions        /ss          查看当前项目最近活跃的 10 个会话
/session R1      /s R1        绑定并继续当前项目的指定会话
/new             /n           在当前项目新建并绑定 Codex 会话
/model           /m           查看当前模型和可用模型
/model <序号|模型 ID|default>  切换当前会话模型，或恢复继承设置
/effort          /e           查看当前模型支持的推理强度
/effort <序号|强度|default>    切换当前会话推理强度，或恢复继承设置
/stream          /str         查看当前会话的过程进度设置
/stream <on|off|default>       开启、关闭过程进度，或恢复继承全局设置
/prompt start    /pp s        开始缓冲多条微信消息
/prompt done     /pp d        将缓冲内容作为一次 Codex turn 提交
/approve A1      /ok A1       批准一次当前渠道收到的 Codex 审批
/reject A1       /no A1       拒绝当前渠道收到的 Codex 审批
/stop            /x           中断当前 Codex 任务
```

普通消息直接进入当前活动会话。图片、文件、视频和无转写语音会先保存到账号独立的入站目录，再以本地路径加入 prompt；有微信转写文本的语音优先使用转写文本。

每轮对话结束时，Codex 会从明确表达的偏好、可复用工作技巧、稳定知识点和重复流程中最多提炼 3 条个人知识。账号级知识可跨该账号的项目使用，项目级知识只在对应项目中使用；重复标题会更新而不是重复追加，最多保留 200 条。密码、Token、API Key、私钥和临时任务状态不会主动沉淀。微信和 Web 继续该账号任务时都会按相关度注入知识，但不同微信账号之间不会共享。

## 文件回传

Codex 可以在最终回复中声明需要发送的本机文件：

````text
```codex-channel-bridge-actions
{
  "send": [
    { "type": "image", "path": "/absolute/path/chart.png" },
    { "type": "video", "path": "/absolute/path/demo.mp4" },
    { "type": "file", "path": "/absolute/path/report.pdf" }
  ]
}
```
````

只接受本机绝对路径。原生出站类型为 `image`、`video` 和 `file`；音频按普通文件发送。远程 URL 不会被当作本机文件上传。

## Codex 后端

默认的 `codexBackend` 是 `auto`。第一次收到 Codex 消息时，服务会启动一个持久的 `codex app-server --stdio` 进程，并使用新版 `initialize`、`thread/*` 和 `turn/*` 协议。新会话和已有会话都优先通过 app-server 运行；如果 app-server 无法启动、握手或处理请求，会自动回退到 `codex exec` 或 `codex exec resume`。

聊天端发起的 app-server turn 使用 `approvalPolicy: "on-request"`。Codex 请求运行命令、修改文件或增加权限时，桥接服务会把请求路由到原账号、原联系人并等待 `/approve` 或 `/reject`；超时、发送失败或找不到对应任务时安全拒绝。带渠道审批的任务不会回退到无法交互审批的 `codex exec`。管理页保存的 `codexExecSandbox` 是兼容旧版本保留的字段名，现在会同时应用到 app-server 主路径和 exec 回退路径；选择“完整访问”时，新建及已绑定会话的后续回合都会以 `danger-full-access` 运行。管理页仍可把后端固定为 `app-server` 或 `exec`，用于排查问题。

## 模型和推理强度

“设置”页面会从 Codex app-server 读取可用模型和各模型支持的推理强度。选择“沿用 Codex 设置”时使用 Codex 自身配置；选择具体模型或推理强度并保存后，后续 Web 和微信消息都会使用该配置。

微信中发送 `/model` 或 `/effort` 可以查看带序号的选项，再用序号或英文 ID 切换。微信端设置只覆盖当前受管会话，不影响其他微信账号、联系人或会话；发送 `/model default`、`/effort default` 可恢复继承 Web/Codex 设置。Web 继续该会话时也会沿用这份会话设置。

IkunCoding 提供方会额外显示 `gpt-5.6-sol`、`gpt-5.6-terra` 和 `gpt-5.6-luna`。切换到其他模型后，这三项仍会保留在下拉列表和微信 `/model` 列表中。微信发送 `/status` 可以查看当前生效的模型和推理强度。

## 本地数据

服务状态和默认 Codex 工作目录统一放在：

```text
~/.codex-weixin/
  accounts/                 微信账号凭据，每个账号一个文件
  retained-accounts.json    已移除账号的恢复索引，不包含 token
  runtime/<account-id>/     联系人授权、受管会话和个人知识库状态
  inbound/<account-id>/     微信入站附件
  config.json               Codex 和工作区配置
  logs/
  taskboard/                内置 Taskboard 的 SQLite、附件与本地云伴侣配置
```

不要提交或分享该目录。管理 API 不会把微信 token 返回给浏览器。

## 启动设置

服务始终只绑定 `127.0.0.1`。可以通过环境变量改变端口、状态目录或关闭自动打开浏览器：

```text
CODEX_CHANNEL_BRIDGE_PORT=8787
CODEX_CHANNEL_BRIDGE_STATE_DIR=/absolute/private/path
CODEX_CHANNEL_BRIDGE_OPEN=0
```

Windows PowerShell 示例：

```powershell
$env:CODEX_CHANNEL_BRIDGE_OPEN="0"
node dist/server/index.js
```

## 安全边界

- Web 服务只监听本机，拒绝非本机 Host 和 Origin。
- 所有修改 API 都需要页面运行时临时令牌。
- 微信凭据永远不返回管理页面。
- 未知联系人默认拒绝，必须在管理页明确允许。
- 项目只能从 Codex 本地会话历史中选择；手工路径绑定已停用。
- `danger-full-access` 会绕过 Codex 文件系统 sandbox；只有接受整机访问风险时才启用。
- 多账号可以并行触发 Codex，会共同占用本机 CPU、内存和 Codex 配额。

## 开发与验证

```bash
npm install
npm test
npm run typecheck
npm run build
node dist/server/index.js
```

开发入口同样只启动本机 Web 服务。浏览器页面、JSON API、多账号运行时、扫码状态机和受管会话都有自动化测试。

项目不会发布 npm 包，也不会从 Web 安装更新。更新时请在源码目录执行 `git pull --ff-only`、`npm ci` 和 `npm run build`，然后使用 `node dist/server/index.js` 重新启动。

## 参考与许可

项目最初来自 [XavierJiezou/codex-weixin](https://github.com/XavierJiezou/codex-weixin)，当前以独立名称维护于 [lsiten/codex-channel-bridge](https://github.com/lsiten/codex-channel-bridge)。`~/.codex-weixin`、`CODEX_WEIXIN_*` 和旧 action block 仅作为现有安装的兼容接口保留。微信 iLink 接入形态参考 `Tencent/openclaw-weixin`，并参考了公开的 Codex/微信桥接项目在 Codex app-server、媒体传输和安全边界方面的实践。项目未复制 AGPL 项目源码，使用 MIT License。

版本变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 社区

感谢 [LINUX DO](https://linux.do/t/topic/2599273) 社区佬友的支持与反馈。
