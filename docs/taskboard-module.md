# 内置 Taskboard 模块：安装、迁移与回滚

Taskboard 已作为独立 workspace 模块放在 `taskboard/`，由 `codex-im-gateway` 进程统一启动和关闭。管理后台仍使用 `http://127.0.0.1:8787`，完整看板与 CLI API 使用 `http://127.0.0.1:47823`；两个端口由同一个进程提供。

任务面板页面先读取 `/api/taskboard`。停用或服务不可用时不加载 iframe，而显示当前状态与操作入口。在停用状态点击「启用任务面板」会通过本机受保护的 `POST /api/taskboard/start` 启动同一内置服务并保存开关，不重启 IM 账号或 Codex 任务。设置页修改开关/地址也会同步应用到看板生命周期，无需重启 Gateway。

## 一键安装或核验

在 `codex-im-gateway` 仓库根目录执行：

```bash
npm run install:local
npm run install:check
```

安装命令会复用当前 npm 缓存，构建 Bridge 和完整看板，并把以下入口链接到内置模块：

- `~/.local/bin/taskctl`
- `~/.codex/skills/manage-taskboard`

它不会覆盖同名普通文件。已有软链接会迁移到当前仓库。首次安装由现有终端或系统服务管理器启动；正在服务的 macOS LaunchAgent 应使用[隔离发布流程](release-local.md)，先准备和验证制品再切换。

## 数据位置

内置模式使用：

```text
~/.codex-im-gateway/taskboard/
  taskboard.sqlite
  attachments/
  cloud-companion.json
```

Taskboard Issue 不会复制到 Bridge 的 JSON 状态中。数据库仍是唯一事实源，只是生命周期和目录由 Gateway 统一管理。已有安装会复用其实际状态根目录，不能仅根据新安装默认值判断迁移目标。

## 从独立仓库迁移

1. 停止独立 Taskboard 和 Bridge，确认 47823、8787 没有监听进程。
2. 在确认迁移与备份前保留旧目录和 `.data/`。
3. 核对服务实际使用的状态根目录（包括环境变量覆盖和旧目录复用），用 SQLite 在线备份语义复制旧库。以下是需替换路径的模板，目标必须与服务的实际 STATE_DIR 一致：

```bash
mkdir -p /absolute/STATE_DIR/taskboard
sqlite3 /absolute/path/to/dashi-taskboard/.data/taskboard.sqlite \
  '.backup /absolute/STATE_DIR/taskboard/taskboard.sqlite'
sqlite3 /absolute/STATE_DIR/taskboard/taskboard.sqlite 'PRAGMA integrity_check;'
```

4. 执行 `npm run install:local`，再启动 `node dist/server/index.js` 或恢复原系统服务。
5. 检查 `/api/taskboard` 返回 `managed: true`，并用 `taskctl project list --json` 核对项目和 Issue。

如果旧 `.data/attachments/` 存在，还需在停机窗口把它完整复制到实际 STATE_DIR 下的 `taskboard/attachments/`。

## 回滚

代码发布失败仅回滚制品，不恢复旧数据库或授权。需要主动回滚 Taskboard 数据时，先停止 Gateway，备份当前库，使用事先核对的 SQLite 备份替换，并执行 `PRAGMA integrity_check` 后恢复服务；附件备份也需对应。旧仓库是否存在、是否移入废纸篓属于具体机器状态，不能作为通用恢复依据。

## 验证清单

```bash
npm run typecheck
npm test
npm run build
curl -fsS http://127.0.0.1:47823/health
curl -fsS http://127.0.0.1:8787/api/taskboard
taskctl project list --json
```
