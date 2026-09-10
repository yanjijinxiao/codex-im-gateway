<h1 align="center">Codex IM Gateway</h1>

<p align="center">
  <img src="src/web/favicon.svg" alt="Codex IM Gateway logo" width="128" height="128" />
</p>

<p align="center">
  <a href="./README.md">中文</a> | <strong>English</strong>
</p>

<p align="center">
  <strong>Use local or remote OpenAI Codex from WeChat, Enterprise WeChat, Feishu, and DingTalk.</strong>
</p>

`codex-im-gateway` is a cross-platform, local instant-messaging gateway. It connects multiple messaging channels to one project, session, and task lifecycle while supporting both Codex CLI and Codex Desktop/app-server backends.

```text
WeChat / Enterprise WeChat / Feishu / DingTalk
                       │
                       ▼
               Codex IM Gateway
               ├─ Project and session routing
               ├─ Long-task progress and approvals
               ├─ Attachments, notifications, knowledge
               └─ Local Web management
                       │
                       ▼
            Codex CLI / Codex Desktop
            Local projects / remote SSH projects
```

The service binds only to `127.0.0.1`. Channel credentials, attachments, session bindings, and personal knowledge remain local.

## Core capabilities

- **One gateway for multiple channels**: Personal WeChat, Enterprise WeChat, Feishu, and DingTalk run in parallel with account-isolated projects, sessions, approvals, and notifications.
- **Two Codex backends**: One interface covers `codex exec` and `app-server`, including Codex Desktop-owned threads and remote projects discovered from Desktop host metadata.
- **Project and session management**: Discover local and remote projects from Codex Desktop and Codex session data; bind, switch, create, resume, queue, and validate archived or missing sessions.
- **Long-running agent tasks**: Accepted tasks have no fixed overall timeout. Channels receive readable progress, tool state, and elapsed time while the final answer remains intact.
- **Media, approvals, and notifications**: Handle images, voice, video, and files according to channel capabilities. Command, file-change, and permission approvals return to the originating account and conversation.
- **Local management and extensions**: Manage channels, projects, sessions, models, and notifications from a Web console. An embedded Taskboard and declarative Skill capabilities can extend the channel workbench.

## Supported channels

All four channels share the same project and session lifecycle. Native interaction follows each platform's capabilities.

| Channel | Connection | Input and interaction | Channel-specific experience |
| --- | --- | --- | --- |
| Personal WeChat | QR login / iLink | Text, images, voice, video, files | Voice transcription, native media transfer, typing state |
| Enterprise WeChat | Official smart-bot long connection | Text and bot messages | No public callback, approvals, task notifications |
| Feishu | Enterprise app long connection | Text, menus, cards, buttons, forms | Native project/task workbench and in-place card updates |
| DingTalk | Internal app in Stream mode | Text, images, rich text, AI Cards | Thinking state, streaming card progress, text fallback |

Platform capabilities and setup requirements may change with official APIs. See [channel setup](./docs/channel-setup.md).

## Web management

<p align="center">
  <img src="docs/images/screenshots/web-session-management.png" alt="Codex IM Gateway Web session management" width="100%" />
</p>

The console adds and controls channels, authorizes senders, binds projects, displays sessions and running tasks, resumes conversations, and configures models, reasoning effort, progress, and completion notifications.

## Quick start

### Requirements

- Node.js `>=22`
- Git
- An installed and authenticated Codex CLI

```bash
npm install -g @openai/codex
codex --version
```

### Install and run

The project is distributed as GitHub source and is not published as an npm package.

```bash
git clone https://github.com/yanjijinxiao/codex-im-gateway.git
cd codex-im-gateway
npm ci
npm run build
node dist/server/index.js
```

The service opens [http://127.0.0.1:8787](http://127.0.0.1:8787) by default. npm only installs locked dependencies and builds the project; it does not globally install or publish the service.

To prepare the embedded Taskboard, `taskctl`, and bundled Skills as well:

```bash
npm run install:local
node dist/server/index.js
```

See the [local run guide](./docs/local-run.md) for background services, updates, and shutdown instructions.

## Add a channel and start chatting

1. Open the management page and select **Add Channel**.
2. Choose Personal WeChat, Enterprise WeChat, Feishu, or DingTalk, then scan or enter the required application credentials.
3. Send one message to the bot. If the channel requires authorization, allow the sender or conversation in the console.
4. Send `/sessions` to browse all bindable unarchived sessions, then `/session R1` (or click a card) to bind directly. No project selection is required.
5. Send a regular message to continue. Use `/new` for the current project, `/new P2` or `/new C1` for a selected project, or `/new --standalone` for a local independent session. The next message starts Codex. `/project add` remains a compatibility alias.

Common commands:

```text
/help                       Show all commands
/status                     Show project, session, backend, model, and task status
/sessions                   Unarchived sessions grouped by project, newest within each group; 30 per page
/sessions size 50           Set page size (5-50, saved per conversation and user)
/sessions detail R1         Read title, host, workspace and ID without switching
/sessions more              Next page (prev for previous, page 3 to jump)
/sessions search words      Search titles, content, directories or IDs
/sessions unbound           Only sessions without a project
/sessions project           Only current-project sessions
/session R1                 Bind and resume a session
/session THREAD_ID          Bind directly (append --host HOST_ID for remote)
/project                    Optional project view; selection binds and switches
/project C1                 Select a discovered project (old add C1 still works)
/project P1                 Switch to a bound project
/new                        Create a session in the current project
/new P2                     Create and switch in a selected project (also C codes or full names)
/new --standalone           Create a local independent session with a durable workspace
/session new ...            Alias for /new ...
/model                      Inspect or switch model
/effort                     Inspect or switch reasoning effort
/stream                     Configure process progress
/stop                       Interrupt the current task
```

Remote projects reuse the `hostId` stored by Codex Desktop and the local SSH configuration. The gateway never stores SSH passwords or private-key contents. See the [channel project workbench](./docs/channel-project-modes.md) for projects, modes, and Taskboard interaction.

Session lists also hide explicitly classified probe records and report the hidden count. Normal conversations are never filtered merely for a `READY` title or CLI source, and no records are deleted or archived. See [session-purpose filtering and restoration](./docs/codex-backends.md#probe-records-versus-user-conversations).

## Codex backends

Channels use one project, session, execution, history, approval, and status interface backed by two implementations:

| Backend | Best for | Main capabilities |
| --- | --- | --- |
| `app-server` | Codex Desktop, new sessions, interactive tasks, remote projects | Project registry, thread lifecycle, streamed events, approvals, dynamic tools, Desktop relay |
| `codex exec` | Local non-interactive CLI tasks and compatible fallback | Local session catalog, history paging, `codex exec` / `codex exec resume` |

`codexBackend: "auto"` prefers app-server and may select CLI during initial discovery or a compatible new turn. The selected backend is then pinned; existing-thread failures never switch backends. Both backends implement catalog and history APIs separately. CLI never reads Desktop's registry; unsupported live following, steering and goals fail explicitly. See [Codex backend architecture](./docs/codex-backends.md).

Lists sort by recent activity. Page numbers remain stable until refresh/search or a 15-minute expiry. App includes sessions from known remote hosts, with explicit partial-results warnings for unavailable hosts. Archived, internal child and unavailable sessions are excluded.

## Long tasks, progress, and session lifecycle

- Once accepted, an agent task runs until completion, explicit `/stop`, or transport failure. Its total lifetime is not extended only when activity occurs.
- The gateway shows readable Codex reasoning summaries, commentary, tool/command/file state, and recent results. Hidden raw reasoning is never forwarded.
- Messages targeting a thread already running in another channel, the Web console, or Codex Desktop wait in order instead of writing concurrently.
- Active, running, archived, missing, and system-error session states pass through the backend lifecycle contract. Archived sessions are omitted from the resumable list and return a clear error when addressed.
- Native cards update in place when available. Card failures fall back to text without blocking the final reply.

## Codex Desktop integration

After building and starting the gateway, run this command from the repository root:

```bash
npm run taskboard:codex
```

It launches Codex with local debugging flags and adds **Channel Configuration** and **Taskboard** entries to the native sidebar. It does not modify Codex application files. Keep the launcher terminal running while using the integration. See the [embedded Taskboard guide](./docs/taskboard-module.md) for installation, data, and rollback details.

## Local data and migration

New installations default to:

```text
~/.codex-im-gateway/
  accounts/                 Channel credentials
  runtime/<account-id>/     Authorization, projects, sessions, personal knowledge
  inbound/<account-id>/     Inbound attachments
  config.json               Codex, backend, and workspace configuration
  logs/                     Local service logs
  taskboard/                Embedded Taskboard data
```

If the canonical directory does not exist, the gateway reuses an existing `~/.codex-channel-bridge/` or `~/.codex-weixin/` installation automatically. Legacy `CODEX_CHANNEL_BRIDGE_*`, `CODEX_WEIXIN_*`, request headers, and action blocks remain accepted compatibility interfaces.

Never commit or share the state directory. The management API redacts channel secrets, tokens, and webhook URLs.

Startup overrides:

```text
CODEX_IM_GATEWAY_PORT=8787
CODEX_IM_GATEWAY_STATE_DIR=/absolute/private/path
CODEX_IM_GATEWAY_OPEN=0
```

## Security boundaries

- The Web service binds only to loopback and validates Host, Origin, and an in-memory request token.
- Channel credentials never reach the management page. Unknown senders and conversations are denied by default.
- Projects come from backend discovery and cannot be injected as arbitrary paths from chat.
- Approval IDs are isolated by channel account and conversation. Timeout, delivery failure, or turn completion safely rejects an unresolved approval.
- `danger-full-access` bypasses the Codex filesystem sandbox and should be enabled only after accepting full-machine access risk.
- Concurrent accounts share local compute resources and Codex quotas.

## Documentation

- [Channel and task-notification setup](./docs/channel-setup.md)
- [Codex backend architecture](./docs/codex-backends.md)
- [Unified IM channel interface and capability matrix](./docs/im-channel-architecture.md)
- [Channel projects, modes, and Taskboard workbench](./docs/channel-project-modes.md)
- [Embedded Taskboard installation, migration, and rollback](./docs/taskboard-module.md)
- [Local operation and updates](./docs/local-run.md)
- [Changelog](./CHANGELOG.md)

## Development and verification

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Origin and license

Project lineage:

```text
XavierJiezou/codex-weixin
  → lsiten/codex-channel-bridge
  → yanjijinxiao/codex-im-gateway
```

Existing copyright notices and the [MIT License](./LICENSE) are preserved. See [NOTICE](./NOTICE) for attribution. The WeChat iLink integration shape references the MIT-licensed `Tencent/openclaw-weixin`; no AGPL source code was copied.

This is an unofficial community project and is not affiliated with or endorsed by OpenAI, Tencent, WeCom, ByteDance, Feishu, Alibaba, DingTalk, or the upstream maintainers.
