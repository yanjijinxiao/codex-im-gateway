# Codex backend architecture

Bridge treats Codex CLI and Codex app-server as two implementations of one turn-execution boundary. Channel, Web, account, project, and intent code depend on the stable `CodexBridgeBackend` facade rather than a concrete runner.

```text
Channel / Web / AccountManager
              |
       CodexBridgeBackend
              |
       CodexBackendRouter
       /                 \
CodexExecRunner      AppServerCodexRunner
 codex exec          JSON-RPC thread/turn API
                           |
                 daemon proxy or stdio child
                           |
          Desktop relay only for an owned writer
```

## Contracts

- `CodexBackendAdapter` is the common backend contract: `run`, `steer`, `stop`, `warmUp`, `listProjects`, and `close`, plus an explicit capability record. Unsupported CLI controls fail explicitly.
- `CodexExecRunner` implements the final-answer CLI backend. It does not pretend to implement app-server history, approvals, dynamic tools, user input, model discovery, rate limits, or goals.
- `CodexAppServerBackend` extends the turn contract with the protocol control plane: history, runtime information, models, account rate limits, and native thread goals.
- `CodexBridgeBackend` is the facade consumed above the Codex integration layer. Control-plane calls intentionally use app-server even when `exec` is selected for turns, because the CLI has no equivalent API.
- `DesktopCodexRunner` implements `CodexThreadContinuation`, not `CodexBackendAdapter`. It exists only to continue an app-server thread whose active writer is Codex Desktop.

For new app-server threads, Bridge resolves the protocol-native project ID from `project/list` by workspace root before `thread/start`. Codex Desktop's UI project ID is retained as routing metadata but is not passed through as an app-server project ID because the two ID spaces are different. If the app-server registry does not yet contain the workspace, Bridge creates it idempotently.

Bridge-only policy and private knowledge are sent through `developerInstructions`; the channel user's text remains the actual turn input. Bridge sets a clean user-facing name with `thread/name/set` before the first turn and persists the new thread ID as soon as `thread/start` returns, so Desktop can display and group long-running tasks immediately.

The shared types and interfaces live in `src/codex/backend.ts`. Concrete implementations do not import their public input types from one another.

Project discovery is deliberately backend-owned:

- `CodexExecRunner.listProjects()` derives local workspaces from the CLI session store. It never reads or merges the Codex Desktop project registry.
- `AppServerCodexRunner.listProjects()` calls the daemon's native `project/list` API. The Bridge presentation layer enriches that selected app-server catalog with Desktop-only routing metadata such as remote host IDs.
- `CodexBackendRouter` selects one implementation and returns a `CodexProjectCatalog` carrying its backend ID. Consumers branch on that ID, so an `auto` fallback cannot be mistaken for a Desktop catalog.

`projectCatalog` and `projects` are separate capabilities. The CLI supports catalog discovery but cannot natively bind a thread to an app-server project ID; app-server supports both.

## Routing rules

| Setting | Local turn | App-server failure | Remote Desktop project |
| --- | --- | --- | --- |
| `exec` | Always `codex exec` | Not applicable | Rejected with an explicit error |
| `app-server` | Always app-server | Returned to the caller | Supported |
| `auto` | App-server first | CLI fallback only when no protocol-only capability is required | Supported through the remote daemon transport |

An active-writer error is not a backend fallback. It remains inside the app-server path and may use the Desktop continuation relay for that thread.

## App-server transports

The app-server protocol implementation is independent of its transport:

- `auto`: use the managed daemon when `~/.codex/packages/standalone/current/codex` exists; otherwise use a persistent private stdio child.
- `daemon`: idempotently start the managed daemon, then run `app-server proxy` as the JSONL transport. A missing managed standalone install fails before a turn starts with an actionable error.
- `stdio`: run `codex app-server --stdio` directly.
- remote projects: use the registered Codex Desktop host and an SSH relay to its app-server control socket.

This separation keeps daemon lifecycle and remote transport concerns out of JSON-RPC request handling.

## Adding another backend

1. Implement `CodexBackendAdapter` and declare truthful capabilities.
2. Add an explicit user-facing backend ID and routing rule; never infer a backend from callbacks.
3. Keep protocol-only operations out of the common turn interface unless the new backend genuinely supports them.
4. Add backend contract tests covering strict selection, failure behavior, stop/close semantics, and capability declarations.
5. Do not add channel-specific behavior to a backend; progress rendering, cards, and attachment delivery belong above the facade.

## Session intervention and restart recovery

`ThreadEventHub` owns persistent delivery state above the backend facade. Its keys include the account/binding, host, thread, and active turn. `readThreadSnapshot` is the backend's read-only observation API; it uses native thread reads and paginated turns, without resuming or taking writer ownership. Local rollout notifications supply immediate activity; five-second reconciliation repairs missed notifications, supports remote hosts, and closes a card when its turn completed while the gateway was stopped. Only public commentary, progress summaries and answers are forwarded.

`runtime/thread-subscriptions.json` stores the active turn, last observed lifecycle state, delivered-event hashes, completed turn IDs, and streaming card checkpoint. DingTalk declares support for updating a persisted card ID after restart. Other transports fall back to new messages when they cannot resume a card. A failed terminal card update remains pending for retry; the fallback answer is not repeatedly sent.

Historical baselines are separate from confirmed completions. Private App Server reads of `notLoaded` Desktop threads can reconstruct an active turn as completed/interrupted, so these snapshots never finalize a card. Local lifecycle records supply terminal evidence and recover persisted pending turns after restart. The bounded log-tail reader can recover a long turn's identity from explicit context/usage records even when its start marker is outside the tail. Remote recovery needs an authoritative shared runtime; an unloaded, foreign remote writer's terminal state cannot be safely inferred. Card recovery applies to checkpoints created by this implementation, not cards created by older releases that never saved their handles.

Rollout identity and visibility are parsed centrally: `id` identifies the current thread; legacy `session_id` is only a fallback, since it may identify a reviewer's parent. Guardian reviews and subagent sources are excluded before any history-catalog, progress, completion, project-notification or startup-recovery callbacks. Filtering is based on event provenance, not words inside the answer. Progress and completion hints cannot switch an active card to another turn; only a real start event or an authoritative loaded snapshot can advance it. Retired turns stay rejected after restart. Versioned checkpoints discard text saved before this boundary existed while retaining recoverable card handles.

For local replay of an internal rollout, run `TMPDIR=/private/tmp node --import tsx scripts/verify-rollout-isolation.mjs --run /absolute/internal-rollout.jsonl`. It uses a temporary copy and mock delivery, verifies that internal events cause zero sends while the main task still completes, and removes its temporary files. It does not call Codex or IM APIs.

`SessionControlJournal` serializes controls by host/thread and writes receipts before submitting a steer. Accepted duplicate requests return the recorded result. A request with an unknown transport outcome is never automatically replayed; the user is asked to inspect history. Pending choice cards persist their actor, chat, binding and expected turn, so an old click cannot affect a newly selected session. This does not claim transactional exactly-once delivery across IM APIs: a crash between a remote acknowledgement and the local checkpoint can still leave an uncertain outcome. The gateway does not automatically replay an unconfirmed user action.

The current Desktop follower `thread-follower-steer-turn` v1 does **not** accept `expectedTurnId`: Desktop chooses the turn itself and may retry on a different one. Bridge therefore rejects this unsafe relay path. Strict steering remains available through the shared App Server's official `turn/steer`, which enforces `expectedTurnId`. Desktop interrupt v4 supports an expected turn guard; its older compatibility form is used only for a turn already owned by the relay. The private Desktop protocol is version-dependent and is not equivalent to the official App Server API.

### Chat commands

| Command | Behavior |
| --- | --- |
| `/help`, `/help session` | Show all commands, or just the session intervention guide |
| `/session R1` | Bind, replay recent history, and start following |
| `/history 10`, `/history more` | Read recent messages, then older pages |
| `/follow on`, `/follow off` | Toggle live delivery for the selected session |
| `/leave` | Detach and stop following, without stopping the task |
| `/policy ask`, `/policy steer`, `/policy queue` | Handle ordinary messages received during an active turn; default is ask |
| `/steer text` | Submit guarded input to the active turn |
| `/queue text` | Submit the next turn after current work finishes |
| `/intervene ID steer\|queue\|cancel` | Resolve the originating user's pending choice |
| `/role`, `/role USER viewer\|participant\|controller` | Inspect or configure chat permissions |

The existing allowlist still gates access. Explicitly allowed individual users default to controller. Users admitted only by a group allowlist default to participant. An explicit per-user role overrides that default; `/role * viewer` sets the group default without removing individually configured controllers. Viewers can inspect sessions and history; participants can converse and steer; controllers can additionally stop turns, handle approvals, and manage roles. Natural-language intents and native card callbacks pass through the same role checks as slash commands.

Validation includes a completed-offline turn updating its original card, host isolation, duplicate and ambiguous control receipts across restart, concurrent actors, stale choice rejection, role restrictions, and history cursors. Full live validation additionally requires a running shared App Server and actual IM delivery; mocked tests alone do not establish Desktop compatibility or client-side rendering.

The opt-in `scripts/verify-live-intervention.mjs` creates a separate ephemeral, read-only task and checks that guarded steering changes that same turn's final response. Run with `TMPDIR=/private/tmp node --import tsx scripts/verify-live-intervention.mjs --run /absolute/path/to/codex` on macOS. It never sends to an existing thread or IM account. This test passed with Codex 0.153.4; it verifies the official protocol, not the Desktop private relay or DingTalk rendering. Protocol reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server).
