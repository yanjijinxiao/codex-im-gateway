# Runtime-aligned Updates Design

> 历史设计记录：不作为当前部署或执行约定。当前行为以 [IM 架构](../im-channel-architecture.md)、[后端契约](../codex-backends.md) 和 [运行指南](../local-run.md) 为准；不恢复自动换后端、自动绑定、旧去重窗口或 npm 源码更新流程。

## Goal

Ensure Web updates install and restart the same codex-weixin runtime on global and isolated npm installations, especially on Windows.

## Flow

1. Resolve the package root from the running update-manager module.
2. Accept only a package rooted at `<prefix>/node_modules/codex-weixin`.
3. If the service cwd is inside the active package, move it to `<prefix>` to release the Windows directory lock.
4. Run npm from `<prefix>` with `--prefix <prefix>`, an exact stable version, the selected allowlisted Registry, and no manifest or lockfile mutation.
5. Verify `<prefix>/node_modules/codex-weixin/package.json` and `dist/server/index.js` before reporting installation success.
6. Stop the old service and let the detached helper restart the same absolute entry path.
7. Reject unsupported source layouts with a clear manual-update message.

## Interface

Replace the update dialog arrow with a thin vertical divider. The labels and color already communicate current versus latest, so a directional icon adds unnecessary visual weight.

## Verification

- Test prefix resolution and command construction for macOS and Windows paths.
- Test Windows package-directory cwd migration and unsigned `EBUSY` exit-code normalization.
- Test that source checkouts reject Web installation.
- Install a local 0.2.9 package over an isolated 0.2.8 runtime and confirm the package version changes at the same entry path.
- Run all automated checks and verify the update dialog at desktop and mobile widths.
