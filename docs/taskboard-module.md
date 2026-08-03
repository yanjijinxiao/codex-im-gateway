# 内置 Taskboard 模块：安装、迁移与回滚

Taskboard 已作为独立 workspace 模块放在 `packages/taskboard/`，由 `codex-channel-bridge` 进程统一启动和关闭。管理后台仍使用 `http://127.0.0.1:8787`，完整看板与 CLI API 使用 `http://127.0.0.1:47823`；两个端口由同一个进程提供。

## 一键安装或核验

在 `codex-wx` 仓库根目录执行：

```bash
npm run install:local
npm run install:check
```

安装命令会复用当前 npm 缓存，构建 Bridge 和完整看板，并把以下入口链接到内置模块：

- `~/.local/bin/taskctl`
- `~/.codex/skills/manage-taskboard`

它不会覆盖同名普通文件。已有软链接会迁移到当前仓库。服务仍由现有终端或系统服务管理器启动；macOS LaunchAgent 用户在构建后重新加载原服务即可。

## 数据位置

内置模式使用：

```text
~/.codex-weixin/taskboard/
  taskboard.sqlite
  attachments/
  cloud-companion.json
```

Taskboard Issue 不会复制到 Bridge 的 JSON 状态中。数据库仍是唯一事实源，只是生命周期和目录由 `codex-wx` 统一管理。

## 从独立仓库迁移

1. 停止独立 Taskboard 和 Bridge，确认 47823、8787 没有监听进程。
2. 保留旧目录，不删除 `.data/`。
3. 用 SQLite 在线备份语义复制旧库：

```bash
mkdir -p ~/.codex-weixin/taskboard
sqlite3 /absolute/path/to/dashi-taskboard/.data/taskboard.sqlite \
  '.backup /absolute/home/.codex-weixin/taskboard/taskboard.sqlite'
sqlite3 ~/.codex-weixin/taskboard/taskboard.sqlite 'PRAGMA integrity_check;'
```

4. 执行 `npm run install:local`，再启动 `node dist/server/index.js` 或恢复原系统服务。
5. 检查 `/api/taskboard` 返回 `managed: true`，并用 `taskctl project list --json` 核对项目和 Issue。

如果旧 `.data/attachments/` 存在，还需在停机窗口把它完整复制到 `~/.codex-weixin/taskboard/attachments/`。

## 回滚

停止 Bridge 后，将 Taskboard 数据目录切回旧 `.data/`，再从旧仓库启动独立服务即可。迁移过程不要求删除旧仓库或旧数据库；确认新模式稳定前应保留它们。

## 验证清单

```bash
npm run typecheck
npm test
npm run build
curl -fsS http://127.0.0.1:47823/health
curl -fsS http://127.0.0.1:8787/api/taskboard
taskctl project list --json
```
