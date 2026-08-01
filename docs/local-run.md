# 本地运行指南 / Local Run Guide

Codex Channel Bridge 只通过 GitHub 分发源码，不发布 npm 包。`package.json` 设置了 `private: true`，仓库不包含 npm 发布工作流。

## 首次运行

```bash
git clone https://github.com/lsiten/codex-channel-bridge.git
cd codex-channel-bridge
npm ci
npm run build
node dist/server/index.js
```

npm 仅用于安装锁定依赖和构建 TypeScript/Web 资源。服务启动不使用 `npm start`、全局 npm 安装或 npx。

管理页默认位于 `http://127.0.0.1:8787`。服务只监听本机地址。

## 更新

先停止当前 Node.js 进程，再执行：

```bash
git pull --ff-only
npm ci
npm run build
node dist/server/index.js
```

运行数据默认继续保存在兼容目录 `~/.codex-weixin/`，更新源码或重新构建不会删除账号、授权、项目、会话和知识库。不要提交或分享该目录。

## 后台运行

macOS 或 Linux 可以使用系统自带的服务管理器运行 `node /absolute/path/to/dist/server/index.js`。服务管理器的工作目录应设置为仓库根目录，并按需设置：

```text
CODEX_CHANNEL_BRIDGE_PORT=8787
CODEX_CHANNEL_BRIDGE_STATE_DIR=/absolute/private/path
CODEX_CHANNEL_BRIDGE_OPEN=0
```

旧 `CODEX_WEIXIN_*` 环境变量仍可读取，用于兼容已有部署。

## English

Codex Channel Bridge is distributed only as GitHub source and is protected with `private: true`. npm installs locked dependencies and builds assets, but does not install, publish, or start the service. Run it directly with `node dist/server/index.js`. Stop the current Node.js process before pulling, rebuilding, and restarting. Existing data remains in the compatibility directory `~/.codex-weixin/` unless `CODEX_CHANNEL_BRIDGE_STATE_DIR` selects another private path.
