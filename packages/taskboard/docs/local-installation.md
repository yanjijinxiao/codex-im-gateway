# Codex Taskboard 本地一键安装

这份文档是本地安装、升级、验证和卸载的独立入口。目标是让 Codex 在拿到仓库路径后只执行一个命令，即可完成可复用的本地安装。

## 安装结果

一键安装会完成以下工作：

1. 检查 Node.js 是否满足 `22.5+`；
2. 仅在 `node_modules` 缺失或比 `package-lock.json` 旧时运行 `npm ci --ignore-scripts`；
3. 仅在生产页面缺失或源码更新后运行生产构建；
4. 注册 `~/.local/bin/taskctl`；
5. 注册 `~/.codex/skills/manage-taskboard`；
6. 使用临时 SQLite 数据库启动一次回环测试服务，并验证 `/health`；
7. 不启动常驻进程，不修改 Codex 应用文件，不覆盖其他安装留下的文件或链接。

Taskboard 的正式数据仍保存在仓库的 `.data/` 中。安装验证使用系统临时目录，不接触正式数据库。

## 前置条件

- macOS 或 Linux；
- Node.js `22.5` 或更新版本；
- npm；
- 如需嵌入 Codex，需安装 Codex/ChatGPT 桌面应用。

安装器当前不会自动安装或升级 Node.js。Codex 应先执行 `node --version`，只有版本不满足时才按用户现有的 Node 管理方式处理。

## 一键安装

在仓库根目录执行：

```bash
npm run install:local
```

也可以完全绕过 npm script 名称，直接执行：

```bash
node scripts/install-local.mjs
```

重复执行是安全的：依赖、构建产物和正确的软链接会被复用。若目标位置已有普通文件、目录或指向其他项目的链接，安装器会停止并报告冲突，不会自动覆盖。

## 给 Codex 的一条指令

可以直接在 Codex 中发送：

```text
请进入 /absolute/path/to/dashi-taskboard，先读取 docs/local-installation.md，执行 npm run install:local，并用 npm run install:check 验证。不要重复安装已经满足的 Node.js 或依赖，不要覆盖已有的不同目标文件。
```

如果仓库就在本机当前标准位置，则完整命令是：

```bash
cd /Users/leishicheng/Documents/workspace/code/dashi-taskboard
npm run install:local
```

## 验证安装

只读检查，不修改文件：

```bash
npm run install:check
```

成功结果的 JSON 中应包含：

```json
{
  "ok": true,
  "dependencies": "current",
  "build": "current"
}
```

同时可以检查命令和 Skill：

```bash
command -v taskctl
readlink ~/.codex/skills/manage-taskboard
```

安装或更新 Skill 后，新建一个 Codex 任务再使用 `$manage-taskboard`，避免旧任务继续使用启动时缓存的 Skill 列表。

## 启动方式

### 只启动本地任务面板

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm start
```

打开 <http://127.0.0.1:47823>。明确设置 `127.0.0.1` 可以避免把没有账号认证的本地看板暴露到局域网。

### 启动 Codex 嵌入模式

该方式会启动带调试端口的独立 Codex 窗口并保持注入器运行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

命令需要持续运行，使用结束后按 `Ctrl-C`。它不会修改 `ChatGPT.app` 或 `app.asar`。

如果希望保留当前 Codex 窗口并单独启动一个可注入窗口，请使用 README 中的“Recommended”流程，并确保 Codex 调试端口和注入器端口一致。

## 安装选项

```text
--check               只检查，不修改
--skip-dependencies   即使依赖缺失或过期也不运行 npm ci
--skip-build          即使构建产物缺失或过期也不构建
--help                查看帮助
```

`--skip-dependencies` 和 `--skip-build` 主要用于离线排查；如果跳过后安装条件不完整，命令会返回非零状态。

## 升级

先保留现有 `.data/`，更新源码后重新运行同一个安装命令：

```bash
git pull --ff-only
npm run install:local
npm run install:check
```

安装器不会删除或迁移 `.data/taskboard.sqlite` 和 `.data/attachments/`。涉及数据库结构升级时，仍应先备份 `.data/`，再按版本说明执行。

## 卸载

停止本地服务或注入器后，只删除属于本仓库的两个软链接：

```bash
readlink ~/.local/bin/taskctl
readlink ~/.codex/skills/manage-taskboard
```

确认它们都指向当前仓库后，再手动删除对应链接。不要在没有核对目标的情况下删除同名文件或目录。

源码目录和 `.data/` 不会被自动删除。是否保留任务数据库应由用户明确决定。

## 常见问题

### `Node.js 22.5 or newer is required`

先检查本机已有 Node 管理器和公共工具清单，确认确实缺失或版本不兼容后再升级，不要为了保险重复安装。

### `Refusing to overwrite existing path`

目标位置存在另一份 `taskctl` 或 Skill。先用 `ls -l`、`readlink` 确认归属，再由用户决定保留、迁移还是移除；安装器不会替用户做覆盖决定。

### 端口 `47823` 已占用

先检查是否已有 Taskboard 服务：

```bash
curl http://127.0.0.1:47823/health
```

已有健康服务时直接复用。确需更换端口时，同时设置 `CODEX_TASKBOARD_PORT` 和 `CODEX_TASKBOARD_URL`。

### Codex 中没有出现新 Skill

先执行 `npm run install:check`，确认 Skill 链接正确，然后新建一个 Codex 任务。现有任务不会重新加载启动后的 Skill 清单。

## 安全边界

- 本地模式固定使用 `127.0.0.1`；
- 不把 `.data/`、凭据或 Cloudflare 密钥提交到仓库；
- CDP 调试端口只应在运行可信本地代码时开启；
- 当前仓库未声明明确的开源许可证，分发或商业集成前需先确认授权。
