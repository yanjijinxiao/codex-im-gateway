<h1 align="center">Codex Channel Bridge</h1>

<p align="center">
  <img src="src/web/favicon.svg" alt="Codex Channel Bridge logo" width="128" height="128" />
</p>

<p align="center">
  <a href="./README.md">中文</a> | <strong>English</strong>
</p>

<p align="center">
  <strong>Connect WeChat, Enterprise WeChat, and Feishu to a local OpenAI Codex installation.</strong>
</p>

`codex-channel-bridge` is a cross-platform, local-only messaging bridge for Codex. Its Web console adds personal WeChat, Enterprise WeChat, and Feishu channels, manages projects and bound sessions, and configures task-completion notifications.

```text
WeChat / Enterprise WeChat / Feishu <-> Codex Channel Bridge <-> local Codex <-> bound projects
```

Service data and credentials remain local. The management page is never exposed to the LAN or public Internet.

## Feature status

Screenshots live under `docs/images/screenshots/`. The Web management screenshot is included; rows that require a phone view reserve stable filenames for later WeChat captures.

| Status | Feature | Details | Screenshot |
| --- | --- | --- | --- |
| ✅ | Local Web management | A `127.0.0.1`-only page manages WeChat accounts, sessions, workspaces, and Codex settings. | [Web sessions](docs/images/screenshots/web-session-management.png) |
| ✅ | Multiple WeChat accounts | One service runs multiple accounts with local remarks and isolated authorization, attachments, sessions, and personal knowledge; account removal can retain history. | [Web sessions](docs/images/screenshots/web-session-management.png) |
| ✅ | Enterprise channels | Enterprise WeChat smart bots and Feishu custom apps connect through official long-connection SDKs without a public callback URL. | Pending: `docs/images/screenshots/web-channels.png` |
| ✅ | Projects and live tasks | Projects show bound sessions and currently running tasks while monitoring Codex Desktop, Web, and chat session state. | [Web sessions](docs/images/screenshots/web-session-management.png) |
| ✅ | Completion notifications | Each project can notify a selected channel recipient when a task succeeds, fails, or is interrupted. | Pending: `docs/images/screenshots/web-notifications.png` |
| ✅ | Browser QR connection | Shows waiting, scanned, connected, and expired QR states. | Pending: `docs/images/screenshots/wechat-qr-login.png` |
| ✅ | Session management | Grouped account tabs, Markdown history, continued Codex threads, and create, rename, activate, reset, and delete actions. | [Web sessions](docs/images/screenshots/web-session-management.png) |
| ✅ | Web text and attachments | Send text with up to 10 files (100 MiB total), with media playback, preview, and download in history. | Pending: `docs/images/screenshots/web-attachments.png` |
| ✅ | Channel chat control | Supports regular messages plus project, session, knowledge, model, progress, approval, and interruption commands across personal WeChat, Enterprise WeChat, and Feishu. | Pending: `docs/images/screenshots/wechat-chat.png` |
| ✅ | Channel approvals | Command, file-change, and additional-permission approvals return to the originating account and sender with isolated approve/reject commands and a safe timeout. | Pending: `docs/images/screenshots/wechat-approval.png` |
| ✅ | Per-account personal knowledge | Each WeChat account automatically learns reusable preferences, skills, knowledge, and workflows, then injects relevant entries into later WeChat and Web turns without sharing across accounts. | Pending: `docs/images/screenshots/wechat-memory.png` |
| ✅ | WeChat media input | Accepts transcribed voice, images, audio, video, and files up to 100 MiB each, with a direct notice when the limit is exceeded. | Pending: `docs/images/screenshots/wechat-media-input.png` |
| ✅ | File delivery to WeChat | Codex can return local images, videos, and files as native WeChat messages. | Pending: `docs/images/screenshots/wechat-media-output.png` |
| ✅ | Models and reasoning effort | Model-aware dropdowns loaded from app-server, including GPT-5.6 Sol, Terra, and Luna for IkunCoding. | Pending: `docs/images/screenshots/web-model-settings.png` |
| ✅ | Process progress | Enabled by default; Codex progress reaches WeChat immediately and appears in a collapsible Web timeline with elapsed time, while final answers stay intact. | Pending: `docs/images/screenshots/web-process-progress.png` |
| ✅ | Typing state and deduplication | Web typing state plus persistent sync cursors and message IDs prevent duplicate replies. | Pending: `docs/images/screenshots/wechat-typing.png` |
| ✅ | App-server first | New and resumed sessions prefer Codex app-server V2 and fall back to `codex exec` when unavailable. | Pending: `docs/images/screenshots/wechat-status.png` |
| ✅ | Local source operation | Installs locked dependencies, builds locally, and runs directly with Node.js; the project is not published as an npm package. | [Local run guide](docs/local-run.md) |

## Web management preview

<p align="center">
  <img src="docs/images/screenshots/web-session-management.png" alt="Codex Channel Bridge Web session management" width="100%" />
</p>

## Requirements

- Node.js `>=22`
- Git
- An installed and authenticated Codex CLI

```bash
npm install -g @openai/codex
codex --version
codex
```

## Run locally

This project is available only as GitHub source. It is not published as an npm package; do not run `npm install -g codex-channel-bridge` or `npm publish`.

```bash
git clone https://github.com/lsiten/codex-channel-bridge.git
cd codex-channel-bridge
npm ci
npm run build
node dist/server/index.js
```

Here npm only installs locked dependencies and runs the build; it does not install or start this service. Node.js starts the service directly and opens [http://127.0.0.1:8787](http://127.0.0.1:8787). See the [local run guide](./docs/local-run.md) for update, start, and stop instructions.

## One-command Codex integration

After building locally and starting the Bridge as described above, run this command from the repository root:

```bash
npm run taskboard:codex
```

It launches Codex with the required local debugging flags and adds two peer entries below Plugins in the native sidebar:

- **Channel Configuration (Message Channels)** opens the Codex Channel Bridge console for Personal WeChat, Enterprise WeChat, and Feishu.
- **Taskboard** opens the embedded board while retaining the current Codex project and conversation context.

Both entries use the Codex main workspace instead of opening a separate browser side panel. Keep the command's terminal running while using the integration, because the injector keeps the entries attached. Use the same command whenever you want to launch the integrated Codex window again.

If Codex was launched from the Dock or Finder and the sidebar shows only an older Taskboard entry, quit Codex completely, stop the old injector terminal, and rerun the command from the **current repository root**. An already-running Codex process cannot gain a debugging port after launch, which is the usual cause of a stale single-entry sidebar.

For a first-time setup, use this sequence to build, start the Bridge, and integrate Codex:

```bash
npm run install:local
node dist/server/index.js
# In another terminal, from the same repository:
npm run taskboard:codex
```

After a successful launch, both Channel Configuration and Taskboard should be visible. The Bridge console is at [http://127.0.0.1:8787](http://127.0.0.1:8787), and Taskboard is at [http://127.0.0.1:47823](http://127.0.0.1:47823).

## Add a message channel

Select **Add Channel** in the Web console:

- **Personal WeChat**: scan the QR code; unknown senders still require explicit authorization in the console.
- **Enterprise WeChat**: create a smart bot in API mode and enter its Bot ID and Secret.
- **Feishu**: create a custom app, enable its bot and long-connection event subscription, then enter its App ID and App Secret.

Enterprise WeChat and Feishu use official long-connection SDKs, so the local service needs no public domain or callback URL. See [Message channel and task notification setup](./docs/channel-setup.md) for complete steps and official console links. Credentials stay under `~/.codex-weixin/` and are never returned by the management API.

Each channel also has an optional Webhook under the pencil **Channel Settings** action. When configured, every successfully received or sent channel message is mirrored once as a JSON POST; no request is made when it is left unconfigured. The management API exposes only the configured status and never returns the potentially secret-bearing URL. See [Webhook mirroring](./docs/channel-setup.md#webhook-mirroring) for the event format.

When a chat-started task needs permission to run a command, change files, or gain additional access, the request returns to the same channel account and sender. Reply with `/approve A1` (`/ok A1`) to approve once or `/reject A1` (`/no A1`) to decline. Unanswered requests are declined after ten minutes, and another sender or account cannot act on the request.

## First personal WeChat connection

1. Open Settings and confirm the default and allowed Codex workspaces.
2. Select Add WeChat, scan the QR code, and confirm in WeChat.
3. Send any message to the connected account.
4. Return to WeChat Accounts and allow the pending sender.
5. Send the message again to start a Codex turn.

Repeat the QR flow to add more accounts. Every account has its own monitor, sender authorization, inbound directory, and managed-session state. A failed account does not stop the others. Scanning the same WeChat account again after an expired login refreshes the existing credentials while preserving its local remark, authorization, and sessions instead of creating an empty duplicate. Account removal can retain history: credentials are deleted immediately, while a later scan by the same WeChat user restores the previous remark, authorization, and managed sessions.

## Session management

The Sessions page manages conversations created and used by this server. It does not scan or take ownership of every Codex conversation created in other terminals.

Selecting a session reads its user messages and final replies from Codex's own persisted thread. The controls below the chat title select a model, reasoning effort, and process-progress behavior for the current session or keep inheriting global settings; they share the same session configuration used by the WeChat `/model`, `/effort`, and `/stream` commands. Process progress is enabled by default, appears in a collapsible Web timeline with elapsed time, and leaves the final answer as one stable response. The Web composer can submit text and multiple files as one turn and continues that same thread, so context remains shared with later WeChat messages. Uploads are isolated by account and session under `~/.codex-weixin/inbound/`, with at most 10 files and 100 MiB total per turn.

The UI uses local remarks instead of treating internal IDs as account names. Expand “Account IDs” on an account card to inspect its iLink Bot ID and User ID; Codex thread IDs remain hidden from the regular UI. Each account can have a local remark edited from the WeChat Accounts page; the remark is reused by session tabs, with `WeChat Account 1` used only as a fallback. The current QR and messaging APIs do not expose WeChat nicknames, avatars, or a profile lookup endpoint, so the page uses a default icon.

- Each authorized WeChat account has one active session and may own multiple named sessions.
- Activate chooses which Codex thread receives the sender's next message.
- Reset clears the recorded thread so the next message starts fresh context.
- Delete removes only the bridge record, not Codex's own history files.
- `/sessions` lists up to ten recently active bridge or Codex Desktop sessions from the current project; `/session R1` binds the real Codex thread and continues it. `/resume` remains a compatibility alias.
- `/new` creates and binds a new managed session inside the current project.

## Projects, running tasks, and notifications

- Projects are selected from local Codex history and grouped by working directory. Switching projects limits the session list to that project's ten most recently active sessions.
- The console shows bound sessions and currently running tasks while monitoring Codex Desktop, Web, and chat session lifecycle changes.
- Each project can send completion summaries to a selected channel recipient after success, failure, or interruption.
- A green bell and “Notifications enabled” badge confirm the setting. The task count represents live tasks, not historical sessions.

Channel users select a project once, then use native controls to enter the session, task, or Q&A modes enabled for that channel account; project selection enters the configured default mode. Task mode resolves the Taskboard project by the selected project's absolute workspace and does not require an existing Codex session. Q&A prefers the project's bound knowledge base and otherwise uses the channel account's managed knowledge base or validated llm-wiki directory while keeping the selected project as the working directory. Plan mode and goals belong to the current project's active thread and never fall through to a thread from another project. See the [channel project workbench specification](./docs/channel-project-modes.md) for the state and acceptance contract.

## Taskboard integration

Taskboard is fully embedded in this repository under the `taskboard/` workspace, including the local service, React management UI, `taskctl` CLI, Codex Skill, Cloud/injection scripts, and tests. The bridge starts `http://127.0.0.1:47823` with the main service and closes it during shutdown or restart; data is stored under `~/.codex-weixin/taskboard/`. Running `npm install` and `npm run build` at the repository root installs and builds both the bridge and Taskboard without an external repository or Git submodule.

The management header includes a Taskboard tab that switches the current main area to the configured loopback Taskboard without opening another window. Switching back to Channels, Sessions, or Settings restores the corresponding Bridge view.

The Settings page connects to `http://127.0.0.1:47823` by default and maps Codex projects to Taskboard projects by absolute workspace path. Taskboard remains the single source of truth for issue state; the bridge does not copy board issues into its own state files. Issues without a real Codex thread are read-only, blocking and review require evidence, and completion requires explicit acceptance. Only HTTP loopback origins are accepted. The configured `manage-taskboard` Skill and `taskctl` command point directly to this repository's `taskboard/` workspace.

Running `npm run install:local` links `taskboard/skills/manage-taskboard` and `taskboard/cli/taskctl.mjs` into the user environment. Useful commands: `npm run taskboard:start` starts a standalone local service, `npm run taskboard:taskctl -- project list --json` invokes the CLI, and `npm run taskboard:check` runs Taskboard verification.

Launching the normal Codex app through `taskboard/scripts/codex-injector.mjs --launch --watch` adds two native-looking peer navigation entries below Plugins. **Taskboard** and **Channel Configuration** switch the same Codex main workspace between the local board and the Codex Channel Bridge management page at `http://127.0.0.1:8787/`; neither opens a separate browser side panel. Current Codex Chromium builds enforce Local Network Access checks for loopback iframes, so the launcher supplies `--disable-features=LocalNetworkAccessChecks`; an already-running Dock-launched process without a debugging port cannot be injected in place. A resident background injector can add `--adopt-normal-launch`; when installed while Codex is already open, add `--defer-existing` so it preserves the current window and briefly relaunches the next normal opening with the required flags before injecting it.

## Message-channel commands

```text
/help            /h           Show commands
/status          /st          Show session, workspace, thread, backend, effective model, and reasoning effort
/balance         /bal         Show the current Codex login plan, remaining limits, and reset times
/memory          /mem         Show this WeChat account's personal knowledge
/memory <on|off>              Enable or disable automatic learning and injection
/memory forget K1 /mem f K1   Delete one knowledge entry
/memory clear     /mem c      Clear personal knowledge after confirmation
/project list    /p l         List projects bound to this WeChat account
/project add     /p a         List projects available from Codex history
/project add C1  /p a C1      Add a Codex-history project by C code
/project P1      /p P1        Switch to a bound project
/project rename P1|name /p rn P1|name  Rename a project
/project delete P1      /p d P1        Remove a project with no running tasks
/mode [session|task|qa] /v    Show or switch the selected project's work mode
/qa                /q        Enter Q&A mode with the project-bound or channel-default llm-wiki knowledge base
/plan [on|off]               Switch the current session's native Codex plan mode
/goal [objective|pause|resume|complete|clear] Manage the current thread's Codex goal
/task            /tb          List unfinished Taskboard issues in the current project
/task ISSUE                   Bind and continue the issue's Codex thread
/task new title               Create, claim, and start a new issue
/task start ISSUE             Claim and start an existing issue
/task comment ISSUE text      Add a thread-attributed comment and optional attachments
/task attach ISSUE            Upload the current message attachments
/task block ISSUE reason      Record the blocker and mark the issue blocked
/task review ISSUE            Verify, record evidence, and submit for review
/task accept ISSUE            Complete only after explicit user acceptance
/sessions        /ss          List the current project's ten most recent sessions
/session R1      /s R1        Bind and continue a session from the current project
/new             /n           Create and bind a session in the current project
/resume R1       /r R1        Compatibility alias for session listing and switching
/model           /m           Show the current and available models
/model <number|model|default>  Switch this session's model or restore inheritance
/effort          /e           Show reasoning efforts supported by the current model
/effort <number|level|default> Switch this session's effort or restore inheritance
/stream          /str         Show this session's process-progress setting
/stream <on|off|default>       Enable, disable, or restore global process progress
/prompt start    /pp s        Buffer multiple WeChat messages
/prompt done     /pp d        Submit the buffer as one Codex turn
/approve A1      /ok A1       Approve one Codex request received in this channel
/reject A1       /no A1       Decline a Codex request received in this channel
/stop            /x           Interrupt the current Codex task
```

Regular messages enter the active session. Images, files, videos, and voice/audio without transcription are saved under the account's inbound directory and added to the prompt by local path. WeChat voice transcription is preferred when available.

After each turn, Codex may extract up to three durable entries from explicit preferences, reusable work techniques, stable domain knowledge, or repeatable workflows. Account-scoped entries work across that account's projects, while project-scoped entries stay in their project. Duplicate titles are updated instead of appended, with a maximum of 200 entries. Passwords, tokens, API keys, private keys, and transient task status are excluded. Relevant knowledge is available to both WeChat and Web turns for the same account and is never shared with another WeChat account.

## Sending local files

Codex can request local-file delivery in its final response:

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

Only absolute local paths are accepted. Native outbound types are `image`, `video`, and `file`; audio is sent as a regular file. Remote URLs are not uploaded as local files.

## Codex backend

The default `codexBackend` is `auto`. On the first Codex message, the service starts one persistent `codex app-server --stdio` process and uses the current `initialize`, `thread/*`, and `turn/*` protocol. New and resumed conversations prefer app-server; startup, handshake, or request failures automatically fall back to `codex exec` or `codex exec resume`.

Chat-started app-server turns use `approvalPolicy: "on-request"`. Command, file-change, and additional-permission requests are routed back to the originating account and sender and wait for `/approve` or `/reject`; timeout, delivery failure, or a missing owning turn safely declines the request. Turns with channel approval enabled do not fall back to non-interactive `codex exec`. The management page can still pin the backend to `app-server` or `exec` for diagnostics.

## Models and reasoning effort

The Settings page loads available models and model-specific reasoning efforts from Codex app-server. Leaving a field on "Use Codex settings" preserves the Codex configuration; choosing and saving an explicit value applies it to later Web and WeChat turns.

Send `/model` or `/effort` in WeChat to get a numbered list, then switch by number or exact ID. A WeChat-side selection applies only to the active managed session, without affecting other accounts, senders, or sessions. `/model default` and `/effort default` restore inheritance from Web/Codex settings. Continuing that session from the Web page uses the same session overrides.

The IkunCoding provider also exposes `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. These options remain available after switching to another model in both the Web dropdown and WeChat `/model` list. Send `/status` in WeChat to inspect the effective model and reasoning effort.

## Local data

Service state and the default Codex workspace share this directory:

```text
~/.codex-weixin/
  accounts/                 One credential file per WeChat account
  retained-accounts.json    Recovery index for removed accounts; never stores tokens
  runtime/<account-id>/     Sender authorization, managed sessions, and personal knowledge
  inbound/<account-id>/     Inbound WeChat attachments
  config.json               Codex and workspace configuration
  logs/
```

Do not commit or share this directory. The management API never returns WeChat tokens to the browser.

## Startup settings

The server always binds to `127.0.0.1`. Environment variables can change its port and state directory or disable automatic browser opening:

```text
CODEX_CHANNEL_BRIDGE_PORT=8787
CODEX_CHANNEL_BRIDGE_STATE_DIR=/absolute/private/path
CODEX_CHANNEL_BRIDGE_OPEN=0
```

## Security model

- Non-local Host and Origin values are rejected.
- Every mutating API call requires an in-memory page token.
- WeChat credentials never reach the management page.
- Unknown senders are denied until explicitly allowed.
- Projects can only be selected from local Codex session history; manual path binding is disabled.
- `danger-full-access` bypasses the Codex filesystem sandbox and must be enabled only when full-machine access is acceptable.
- Concurrent accounts share local compute resources and Codex quotas.

## Development and verification

```bash
npm install
npm test
npm run typecheck
npm run build
node dist/server/index.js
```

The project originated from [XavierJiezou/codex-weixin](https://github.com/XavierJiezou/codex-weixin) and is now independently maintained as [lsiten/codex-channel-bridge](https://github.com/lsiten/codex-channel-bridge). The legacy `~/.codex-weixin` directory, `CODEX_WEIXIN_*` variables, and old action blocks remain compatibility interfaces for existing installations. It is distributed under the MIT License. Its iLink integration shape references `Tencent/openclaw-weixin`, along with public Codex/WeChat projects for app-server, media-transfer, and security-boundary practices. No AGPL source code was copied.

The project is never published to npm and the Web page does not install updates. Update the Git checkout, run `npm ci` and `npm run build`, then restart it with `node dist/server/index.js`.

See [CHANGELOG.md](./CHANGELOG.md) for release history.
