# 渠道命令审计

内置命令现在有 29 个顶级入口，统一登记在 `CHANNEL_COMMAND_REGISTRY`。解析别名、保留关键字和 `/help` 后端限制使用同一登记表；渠道扩展不能覆盖这些入口。微信、钉钉、飞书共享业务命令，仅呈现方式不同。

| 处理结论 | 命令 | 本次处理 |
| --- | --- | --- |
| 保留，修复会话生命周期 | `/session`、`/sessions`、`/new`、`/history`、`/follow`、`/leave` | 切换时刷新跟随；退出后不自动重连；任务与绑定分离 |
| 保留，修复状态及策略 | `/status`、`/policy`、`/steer`、`/queue`、`/intervene`、`/stop` | 普通消息默认安全 steer；显式 queue 使用 Codex 原生队列；list/cancel 核对和取消本聊天回执；按实际持有者校验能力，不支持时明确拒绝；重启不重发未确认消息 |
| 保留，补齐帮助和保留字 | `/help`、`/answer` | 帮助显示后端限制；补充 `/answer`，避免与扩展冲突 |
| 保留，受后端或部署能力限制 | `/approve`、`/reject`、`/plan`、`/goal`、`/balance`、`/task` | CLI 不支持的操作在帮助标注；Taskboard 未启用时标注前置条件 |
| 保留 | `/project`、`/mode`、`/qa`、`/role`、`/model`、`/effort`、`/stream`、`/prompt`、`/memory` | `/stream` 控制跟随进度；其余保留原用途和权限约束 |

冗余入口 `/project add` 和 `/session new` 只保留为兼容写法，不作为独立工作流维护。`/project rename`、`/project delete` 只管理 Gateway 登记，不修改 Codex App 项目或删除目录，帮助和响应现在明确说明这一点。

已有的 `/bind`、`/resume` 等废弃入口不恢复；不要为了兼容重新引入第二套绑定流程。`/project` 保留为可选入口，因为指定项目新建、Taskboard 和知识库模式仍依赖项目上下文。

Desktop relay 不等同于共享 App Server：当前私有协议不能安全指定介入轮次，也不能可靠消费原生队列；实际 Desktop 持有的会话不能通过 Gateway 介入或排队。`codex exec` 不支持介入、原生队列和外部实时跟随；CLI App Server 按自身原生协议实现这些操作。默认策略为 steer，现有会话级策略保持不变；缺少能力时明确拒绝，不暗中借用其他后端。

验证覆盖：三种 IM × 两种后端的普通消息策略、Desktop 忙碌/悬空/旧轮次确认、退出与重启、新建与切换刷新、延迟快照不串线、关闭进度保留最终结果、Taskboard 不重写旧绑定，以及全部命令/别名的登记一致性。

`/follow sync` 是现有 `/follow` 的子操作，不增加顶级命令。它只读同步当前绑定，不开启已关闭的跟随、不创建新轮次；`/follow on` 即使已经开启也执行同步。`/follow` 和 `/status` 增加独立同步健康、成功时间及安全失败原因。共享协调器负责后台恢复与显式同步，三种 IM 共用；CLI 的能力限制保持不变。验证另覆盖重启去重卡片恢复、并发请求合并、单绑定超时、迟到读结果、绑定切换和失败呈现不误报成功。
