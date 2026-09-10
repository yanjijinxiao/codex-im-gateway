<h1 align="center">Codex IM Gateway</h1>

<p align="center">
  <img src="src/web/favicon.svg" alt="Codex IM Gateway logo" width="128" height="128" />
</p>

<p align="center">
  <strong>中文</strong> | <a href="./README.en.md">English</a>
</p>

<p align="center">
  <strong>通过个人微信、企业微信、飞书和钉钉使用本机或远程 OpenAI Codex。</strong>
</p>

`codex-im-gateway` 是一个跨平台、本机运行的即时通信网关。它把多个消息渠道连接到统一的 Codex 项目、会话和任务生命周期，并同时支持 Codex CLI 与 Codex Desktop/app-server 后端。

```text
个人微信 / 企业微信 / 飞书 / 钉钉
                  │
                  ▼
          Codex IM Gateway
          ├─ 项目与会话路由
          ├─ 长任务进度与审批
          ├─ 附件、通知和知识
          └─ 本机 Web 管理页
                  │
                  ▼
       Codex CLI / Codex Desktop
       本机项目 / SSH 远程项目
```

服务只监听 `127.0.0.1`，渠道凭据、附件、会话绑定和个人知识均保存在本机。

## 核心能力

- **多渠道统一接入**：个人微信、企业微信、飞书和钉钉可以同时连接，同一套项目、会话、审批和通知能力按账号隔离运行。
- **两个 Codex 后端**：以统一接口支持 `codex exec` 与 `app-server`；可继续 Codex Desktop 已持有的 thread，也可通过 Desktop 主机信息访问远程项目。
- **项目与 Session 管理**：从 Codex Desktop 项目注册表和 Codex 会话数据发现本机或远程项目，支持绑定、切换、新建、继续、归档状态检查和任务排队。
- **长任务持续运行**：已接受的 Agent 任务没有固定总时长上限；渠道端会持续显示可读进度、工具状态和累计用时，最终答案保持完整。
- **媒体、审批与通知**：按渠道能力处理图片、语音、视频和文件；Codex 的命令、文件修改及额外权限审批会回到原账号和原会话。
- **本机管理与扩展**：Web 页面集中管理渠道、项目、Session、模型和通知；内置 Taskboard，并允许已安装 Skill 通过声明式能力接入渠道工作台。

## 渠道支持

四种渠道共享相同的项目和 Session 生命周期；原生交互根据各平台能力实现。

| 渠道 | 接入方式 | 输入与交互 | 渠道特性 |
| --- | --- | --- | --- |
| 个人微信 | 扫码登录 / iLink | 文本、图片、语音、视频、文件 | 语音转写、原生媒体收发、输入状态 |
| 企业微信 | 官方智能机器人长连接 | 文本和机器人消息 | 无需公网回调、审批与任务通知 |
| 飞书 | 企业自建应用长连接 | 文本、菜单、消息卡片、按钮和表单 | 原生项目/任务工作台、卡片原位更新 |
| 钉钉 | 企业内部应用 Stream 模式 | 文本、图片、富文本和 AI Card | 思考状态、流式卡片进度、文本回退 |

平台能力和配置步骤可能随官方接口变化，详见[消息渠道配置](./docs/channel-setup.md)。

## Web 管理页

<p align="center">
  <img src="docs/images/screenshots/web-session-management.png" alt="Codex IM Gateway Web 会话管理" width="100%" />
</p>

管理页可以添加和启停渠道、授权联系人、绑定项目、查看 Session 与运行任务、继续对话，并配置模型、推理强度、过程进度和任务结束通知。

## 快速开始

### 环境要求

- Node.js `>=22`
- Git
- 已安装并登录 Codex CLI

```bash
npm install -g @openai/codex
codex --version
```

### 安装与启动

项目只通过 GitHub 分发源码，不发布 npm 包。

```bash
git clone https://github.com/yanjijinxiao/codex-im-gateway.git
cd codex-im-gateway
npm ci
npm run build
node dist/server/index.js
```

服务默认打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。`npm` 只负责安装锁定依赖和构建，不会全局安装或发布本服务。

需要同时准备内置 Taskboard、`taskctl` 和内置 Skill 时，可以运行：

```bash
npm run install:local
node dist/server/index.js
```

完整的后台运行、更新和停止方法见[本地运行指南](./docs/local-run.md)。

## 添加渠道并开始对话

1. 打开管理页，点击“添加渠道”。
2. 选择个人微信、企业微信、飞书或钉钉，并按页面说明完成扫码或填写应用凭据。
3. 从对应聊天端给机器人发送一条消息；如渠道需要授权，在管理页允许该联系人或会话。
4. 发送 `/sessions` 分页查看全部可绑定的未归档会话，再发送 `/session R1`（或点击卡片）直接绑定，无需先选项目。
5. 发送普通消息继续对话。新建会话可用 `/new`（当前项目）、`/new P2` 或 `/new C1`（指定项目），也可用 `/new --standalone`（本机独立会话）。下一条消息才会启动 Codex；旧 `/project add` 保留为兼容别名。

常用命令：

```text
/help                       查看全部命令
/status                     查看当前项目、Session、后端、模型和任务状态
/sessions                   未归档 Session 按项目分组，组内最近更新优先；默认每页 30 个
/sessions size 50           每页条数设为 50（支持 5-50，按聊天和用户保存）
/sessions detail R1         查看标题、主机、目录和 ID，不切换会话
/sessions more              下一页（prev 上一页，page 3 跳页）
/sessions search 关键词      按标题、内容、目录或 ID 搜索
/sessions unbound           只看无项目 Session
/sessions project           只看当前项目 Session
/session R1                 绑定并继续指定 Session
/session 会话ID              不经过列表直接绑定（远程附加 --host 主机ID）
/project                    可选：查看项目，选择时自动绑定并切换
/project C1                 选择未绑定项目（也兼容 /project add C1）
/project P1                 切换已绑定项目
/new                        在当前项目新建 Session
/new P2                     在指定项目新建并切换；也支持 C编号或完整项目名
/new --standalone           新建本机无项目 Session，使用独立持久目录
/session new ...            /new ... 的别名
/model                      查看或切换模型
/effort                     查看或切换推理强度
/stream                     设置过程进度
/stop                       中断当前任务
```

远程项目复用 Codex Desktop 保存的 `hostId` 和本机 SSH 配置；网关不保存 SSH 密码或私钥内容。项目、模式和 Taskboard 的完整交互见[渠道项目工作台](./docs/channel-project-modes.md)。

会话列表也会隐藏本地用途配置中已确认的探活记录，并显示隐藏数量；不会仅凭 `READY` 标题或 CLI 来源过滤正常对话，也不会删除或归档记录。配置及恢复方式见[会话用途筛选](./docs/codex-backends.md#probe-records-versus-user-conversations)。

## Codex 后端

网关对上层渠道暴露统一的项目、Session、执行、历史、审批和状态接口，并提供两个后端实现：

| 后端 | 适用场景 | 主要能力 |
| --- | --- | --- |
| `app-server` | Codex Desktop、新 Session、交互任务、远程项目 | 项目注册表、thread 生命周期、流式事件、审批、动态工具、Desktop relay |
| `codex exec` | 本机非交互式 CLI 任务及兼容回退 | 本机会话目录、历史分页、`codex exec` / `codex exec resume` |

`codexBackend: "auto"` 默认优先使用 app-server，初始目录发现或兼容的新任务可以选择 CLI；选定后端后固定路由，既有会话不会因故障临时切换后端。两种后端都有独立的目录和历史接口实现；CLI 没有原生项目归属，不读取 Desktop 注册表，实时跟随、介入和目标等不支持的操作会明确报错。详细接口和路由规则见[Codex 后端架构](./docs/codex-backends.md)。

列表按最近更新时间排序，翻页期间编号不变；15 分钟后或重新搜索/刷新时需重新选择。App 后端同时列出已知远程主机的可用会话，部分主机离线会给出提示。已归档、内部子任务及不可用会话不混入普通列表。

## 长任务、进度与 Session 生命周期

- Agent 任务在接受后持续运行到完成、显式 `/stop` 或底层连接中断，不以“有活动才续期”的方式限制总时长。
- 网关只展示 Codex 提供的可读 reasoning summary、commentary、工具/命令/文件状态和最近结果，不发送隐藏的原始推理。
- 同一个 thread 已在任一渠道、Web 或 Codex Desktop 中运行时，后续消息按顺序等待，避免并发写入覆盖。
- Session 的活跃、运行中、已归档、不存在和系统错误状态都会经过后端生命周期接口处理；已归档 Session 不出现在可恢复列表中，继续发送时会返回明确提示。
- 渠道原生卡片可用时会原位更新；不可用或更新失败时退回普通文本，不阻断最终回复。

## Codex Desktop 集成

构建并启动网关后，可从仓库根目录运行：

```bash
npm run taskboard:codex
```

该命令会以本机调试参数启动 Codex，并在原生侧边栏增加“渠道配置”和“任务面板”入口。它不会修改 Codex 应用文件；使用期间需要保持启动器终端运行。Taskboard 的安装、数据和回滚说明见[内置 Taskboard 模块](./docs/taskboard-module.md)。

## 本地数据与旧版本迁移

新安装默认使用：

```text
~/.codex-im-gateway/
  accounts/                 渠道账号凭据
  runtime/<account-id>/     授权、项目、Session 与个人知识
  inbound/<account-id>/     入站附件
  config.json               Codex、后端和工作区配置
  logs/                     本机运行日志
  taskboard/                内置 Taskboard 数据
```

如果新目录尚不存在，网关会依次复用已有的 `~/.codex-channel-bridge/` 或 `~/.codex-weixin/`，无需重新配置渠道。旧的 `CODEX_CHANNEL_BRIDGE_*`、`CODEX_WEIXIN_*`、请求头和 action block 也继续作为兼容接口读取。

不要提交或分享状态目录。管理 API 会隐藏渠道 Secret、Token 和 Webhook 地址。

可使用以下环境变量覆盖启动设置：

```text
CODEX_IM_GATEWAY_PORT=8787
CODEX_IM_GATEWAY_STATE_DIR=/absolute/private/path
CODEX_IM_GATEWAY_OPEN=0
```

## 安全边界

- Web 服务只监听本机回环地址，并校验 Host、Origin 和运行时请求令牌。
- 渠道凭据不会返回管理页面；未知联系人或会话默认拒绝。
- 项目来自 Codex 后端发现结果，不接受聊天端任意路径注入。
- 审批编号按渠道账号和会话隔离，超时、发送失败或任务结束时安全拒绝。
- `danger-full-access` 会绕过 Codex 文件系统沙箱，只应在理解整机访问风险后启用。
- 多账号任务共享本机计算资源和 Codex 配额。

## 文档

- [消息渠道与任务通知配置](./docs/channel-setup.md)
- [Codex 后端架构](./docs/codex-backends.md)
- [统一 IM 渠道接口与能力矩阵](./docs/im-channel-architecture.md)
- [渠道项目、模式与 Taskboard 工作台](./docs/channel-project-modes.md)
- [内置 Taskboard 安装、迁移与回滚](./docs/taskboard-module.md)
- [本地运行与更新](./docs/local-run.md)
- [版本变更](./CHANGELOG.md)

## 开发与验证

```bash
npm install
npm run typecheck
npm test
npm run build
```

## 来源与许可

项目沿革：

```text
XavierJiezou/codex-weixin
  → lsiten/codex-channel-bridge
  → yanjijinxiao/codex-im-gateway
```

原作者版权声明与 [MIT License](./LICENSE) 均完整保留，更多说明见 [NOTICE](./NOTICE)。微信 iLink 接入形态参考 MIT 许可的 `Tencent/openclaw-weixin`；项目未复制 AGPL 项目源码。

本项目是非官方社区项目，与 OpenAI、腾讯、企业微信、字节跳动、飞书、阿里巴巴、钉钉及上述上游维护者不存在隶属或背书关系。
