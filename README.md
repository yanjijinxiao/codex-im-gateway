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

### 3. Codex CLI 原生命令

消息渠道支持 `/help`、`/status`、`/balance`、`/memory`、`/project`、`/task`、`/sessions`、`/session`、`/new`、`/resume`、`/model`、`/effort`、`/stream`、`/prompt start`、`/prompt done`、`/approve`、`/reject` 和 `/stop`，可以管理项目、Taskboard Issue、会话、个人知识库、模型、推理强度、过程进度与 Codex 运行审批，并查看当前 Codex 账号剩余用量。

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

## 添加消息渠道

管理页点击“添加渠道”后，可以选择：

- **个人微信**：无需外部后台配置，直接扫码登录；未知联系人仍需在管理页明确授权。
- **企业微信**：在企业微信客户端创建智能机器人并启用 API 模式，将 Bot ID 和 Secret 填入管理页。
- **飞书**：在飞书开放平台创建企业自建应用，启用机器人和长连接事件订阅，将 App ID 和 App Secret 填入管理页。

企业微信和飞书都使用官方长连接 SDK，本机无需公网域名或回调地址。完整步骤、后台入口和接收 ID 获取方法见 [消息渠道与任务通知配置](./docs/channel-setup.md)。渠道凭据只保存在 `~/.codex-weixin/`，不会通过管理 API 返回浏览器。

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
- 微信中的 `/sessions` 会列出当前项目最近活跃的 10 个桥接或 Codex Desktop 会话、最近内容摘要和时间，并为每项生成 `R1`、`R2` 这类独立编号；发送 `/session R1` 会把真实 Codex thread 绑定到当前项目并继续对话，旧 `/resume` 命令仍兼容。
- 微信中的 `/new` 会立即在当前项目创建并绑定新的受管会话。
- 同一个 Codex thread 在微信、企业微信、飞书、Web 或 Codex Desktop 中已有任务运行时，后续消息会按顺序排队并显示等待进度；前一条成功、失败、中断或超时后都会释放队列和“处理中”状态，不会并发覆盖同一会话。

## 项目、运行任务与通知

- 项目只能从本机 Codex 历史中添加，按工作目录归属；切换项目后，会话列表只显示该项目最近活跃的 10 个会话。
- 后台会展示每个项目绑定的会话和当前运行任务，并监听 Codex Desktop、Web 与聊天端会话的开始、完成、失败和中断状态。
- 已绑定的会话从 Codex Desktop 继续运行时仍计入项目运行任务；只有当前确实由桥接服务执行的同一 Turn 才会去重，绑定关系本身不会隐藏任务或结束通知。
- 每个项目可以独立开启任务结束通知，选择通知渠道和接收会话（或用户）ID；成功、失败和中断都会发送结果摘要。
- 通知按钮为绿色并显示“通知已开启”时表示配置生效；任务数量表示当前正在运行的任务数，不是历史会话总数。

## Taskboard 联动

Taskboard 已内置为 `packages/taskboard/` workspace 模块。Bridge 启动时会一并启动 `http://127.0.0.1:47823`，并按绝对工作目录把 Codex 项目映射到 Taskboard 项目；退出或重启时也会统一关闭。Taskboard 始终是 Issue 状态的唯一事实源，数据保存在 `~/.codex-weixin/taskboard/`，不会复制进 Bridge 的 JSON 状态文件。为了保持本地安全边界，配置只接受 HTTP 回环地址。

管理后台的“任务面板”会汇总所有已映射项目的状态数量，并提供项目、状态和关键词筛选。选中 Issue 后可查看说明、优先级、Codex threadId 和进展评论，也可添加评论及执行开始处理、阻塞、恢复、提交验收、退回和验收完成。没有真实 Codex threadId 的 Issue 只能查看；阻塞和提交验收必须填写证据；“验收完成”只在待验收状态出现，并要求在独立确认窗口中显式验收。完整的关系、附件和规划仍在 Taskboard 原生页面处理。

执行 `npm run install:local` 后，内置模块的 `manage-taskboard` Skill 和 `taskctl` 会链接到用户目录，聊天端可以通过 `/task` 查询和推进工作流。领取、阻塞、提交验收和验收会交给 Codex 使用该 Skill 执行，继续遵守版本冲突检查和验收门禁；评论与聊天附件会带真实 Codex threadId 写回 Issue。Taskboard 进入“阻塞 / 待验收 / 已完成”时，会复用项目通知目标推送状态与最新证据，并和普通 Codex 完成通知去重。

## 消息渠道内命令

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
/project rename P1|名称 /p rn P1|名称  重命名项目
/project delete P1      /p d P1        移除没有运行任务的项目
/task            /tb          查看当前项目未完成的 Taskboard Issue
/task ISSUE编号              绑定并继续 Issue 对应的 Codex thread
/task new 标题               创建、领取并开始处理新 Issue
/task start ISSUE编号        领取并开始处理已有 Issue
/task comment ISSUE编号 内容  添加带当前 threadId 的评论；可同时发送附件
/task attach ISSUE编号       把当前消息附件上传到 Issue
/task block ISSUE编号 原因   记录阻塞原因并标记阻塞
/task review ISSUE编号       验证、记录证据并提交验收
/task accept ISSUE编号       按验收门禁处理；只有用户确认后才可完成
/sessions        /ss          查看当前项目最近活跃的 10 个会话
/session R1      /s R1        绑定并继续当前项目的指定会话
/new             /n           在当前项目新建并绑定 Codex 会话
/resume R1       /r R1        兼容旧版会话查看与切换命令
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
