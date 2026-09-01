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

- `CodexBackendAdapter` is the common backend contract: `run`, `stop`, `warmUp`, `listProjects`, and `close`, plus an explicit capability record. Both concrete backends must implement every method in this boundary.
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
