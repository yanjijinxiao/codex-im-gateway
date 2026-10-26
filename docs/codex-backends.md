# Codex backend architecture

Gateway treats Codex CLI and Codex app-server as two implementations of one backend boundary, including discovery and controls, not just turn execution. Channel, Web, account, project, and intent code depend on the stable `CodexBridgeBackend` facade rather than a concrete runner.

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

## Scoped approvals share one authority

`src/codex/approval.ts` normalizes native requests into explicit choices with exact native response payloads. Both the CLI **App Server backend** and the Desktop follower adapter use this model; channel cards, complete IM reply commands and Web UI → **待审批** project the same live controller. CLI `exec --json` has no interactive response transport and remains explicitly unsupported; it never borrows another backend or disables approval checks.

- Command and file requests can offer once/session decisions. `availableDecisions`, when present, restricts the choices. Command rules retain the complete native argument prefix; network rules retain the offered host and allow/deny action.
- Extra-permission responses retain the requested permission object and native `turn`/`session` scope. They do not acquire arbitrary persistent grants.
- Empty MCP confirmation forms are once-only unless their native metadata explicitly declares `codex_approval_kind: mcp_tool_call` and a `persist` array containing `session` or `always`. Only those declared scopes are then offered and returned as `_meta.persist`; unknown persistence declarations remain unsupported. Computer Use treats accept without `_meta.persist` as session scope, so these forms must not display a misleading approve-once alternative. The installed implementation advertises session/always capabilities per target app. The native tool owns permission storage and revocation; prompt text and server names cannot invent persistence.
- Nonempty forms, OAuth/verification challenges and unsupported interactions retain their existing typed or secure flow; they are never flattened into an always-allow button.

Approval identity includes the execution host, native connection and typed native request ID. For MCP, a subsequently filled-in `turnId` is correlation, not a new request. Repeated pending snapshots do not create a second card. Choices are snapshotted before display; Web decisions include the account, original conversation, approval ID and scope version. IM/Web races, stale versions and unsupported choices cannot consume a different request. Receipts return to the original route even if the primary binding changes.

Selecting a choice records **unconfirmed**, not success. Desktop requires a matching successful IPC receipt; App Server requires `serverRequest/resolved` after submission. Transport loss or turn completion without a receipt cannot claim persistence and never retries a possibly accepted decision. Per-account `runtime/<account>/approvals.json` is an atomic, private audit of choice/receipt/identity hashes only: it stores neither tool arguments nor a reusable permission rule, and restarting Gateway never replays approval history. Native Codex/MCP remains the sole grant authority. Existing Web IDE browser grants are separate and are not reset or extended by this feature.

Protocol reference: [App Server approvals](https://learn.chatgpt.com/docs/app-server#approvals), [Computer Use permissions](https://learn.chatgpt.com/docs/computer-use#permissions-and-approvals). The native response mapping was checked against installed CLI 0.164.0 and Desktop bundled CLI 0.164.0-alpha.11.1; Desktop/Computer Use persistence is an observed native capability rather than a universal promise for every MCP server.

## Native execution recovery is not delivery retry

Read-only startup reconciliation is independent of IM/card projection; a delayed card update cannot hold native recovery state open. Uncertain records are rechecked every 30 seconds, with one in-flight check per host/thread and a 25-second observation deadline matching the follow-reader budget. A slow or unavailable backend during startup leaves the record protected for the next check rather than abandoning reconciliation permanently. Stopping invalidates pending observations and clears the timer. These checks only close known accepted terminal turns; they never authorize continuation or replay. Closure and protected-state diagnostics record identity, reason, elapsed time and a bounded error category, without prompts or provider details.

Recovery chains have independent attempt budgets and cancellation state. A newly observed capacity failure cannot inherit an old chain's `cancelFuture` flag or remain permanently blocked by a proved-ended accepted turn. Reconciliation is read-only and coalesced by host/thread: the current loaded native snapshot must match the offered failed tail, while an uncertain old acceptance must have one exact native turn ID (or unique client-message correlation), a terminal status, and a position before that tail. Missing, contradictory, foreign or timed-out evidence preserves the uncertainty and submits nothing. Binding/backend changes, new user input and lifecycle changes invalidate pending reconciliation. Native queue/owner checks still run at the actual empty-input continuation boundary.

Startup may close a previously accepted, proved-ended recovery record read-only; it does not scan historical failures to create new work. New chains durably retain retired native turn IDs and the previous closure evidence, so late old failure events cannot cancel or restart a newer chain, including after restart. Unknown submissions without exact acceptance evidence remain protected.

When a result and native mentions are combined into a final card, the source progress card preserves the terminal outcome. Failure summaries include the failure reason and point to failure details; interruption, detachment and continuation use their corresponding wording. Only successful results use the ordinary complete-result summary, and an existing status strip is not repeated as another heading.

The backend normalizes native errors into a closed vocabulary (`CodexFailureCode`), including current camelCase and legacy PascalCase codes. Model capacity (`serverOverloaded` / "model is at capacity") is distinct from rate limits, exhausted usage, authentication and safety refusal. Provider `additionalDetails`, stack traces and arbitrary error bodies are never copied into IM notices.

App Server `error` notifications carry an exact thread/turn identity and `willRetry`. They are **nonterminal observations**: `willRetry=true` means Codex itself is retrying; `false` waits for the final turn receipt, rather than inventing one. `CodexRunnerInput.onRecovery` projects that state into the existing presentation handle. Progress or answer activity clears the notice; only native completion ends the card. Duplicate errors do not produce more notifications, foreign/late errors cannot reopen a completed turn, and errors arriving before the start receipt are drained only after binding the accepted identity.

Read-only follow uses the same normalized recovery metadata, scoped to the active native turn and its loaded runtime. An active Desktop snapshot with an error but no explicit retry signal is shown as waiting for further status, **not** as a promise of automatic retry. Its notice and original card handle survive Gateway restart. Neither the follow hub nor channel transports acquire execution authority or start another turn to recover a model error.

The protocol has no `turn/retry`, but the installed Desktop capacity-retry implementation uses `startEmptyTurn`: a new `turn/start` with `input: []` in the same thread. This is an explicit continuation, not a replay of the original user message or a resurrection of the failed turn. Gateway supports this capability through `resumeAfterCapacity`, separately from ordinary `run`, steering, and delivery retry. Only a confirmed capacity failure in a bound, followed session is eligible; auth, quota, safety errors and unknown submissions never trigger it. The native owner is retained, and native queue entries have priority. A fresh loaded idle state (or `systemError` with that exact capacity-failed tail) and no active turn or pending approval/input must be rechecked immediately before the external write; unsupported or changed owners fail closed, without fallback. This dedicated gate never relaxes ordinary message preflight or recovers arbitrary system errors.

`CapacityRecoveryCoordinator` is global to AccountManager and keyed by host/thread, not channel or binding. It persists a bounded 10/30/120/300-second plan, attempt identities and accepted native IDs before/after writes. Concurrent failure observations share one plan; user input, steering, queue changes, stop and lifecycle changes cancel pending plans. A crash in submitting/running state becomes uncertain and is only observed, never blindly resubmitted. Known accepted IDs and newly confirmed failures can authorize the next bounded attempt. Pending plans resume after restart; old terminal cards are not scanned to start new work.

The follow hub delegates capacity decisions to the coordinator; it never calls execution APIs itself. Early native start/activity/snapshot notifications are held until acceptance is mapped. Accepted continuations transfer the original card checkpoint, participant audience and interaction destination to the new native ID; they do not segment or finalize the card. Terminal completion is emitted once when successful, nonretryable, cancelled, or exhausted. No model or permission override is added. Continuing with existing context avoids replaying the original prompt, but it cannot guarantee that a model will never repeat a tool action; unknown execution outcomes are not retried. This compatibility adapter is verified against the installed Desktop/CLI protocol and mock transports, not a guarantee of public API stability.

Protocol references: [official App Server lifecycle](https://learn.chatgpt.com/docs/app-server) and installed `codex-cli 0.154.0` generated `ErrorNotification` / `TurnError` / `CodexErrorInfo` types. OpenAI API retry guidance is not treated as a capability to replay a partially executed Codex turn.

## Contracts

- `CodexBackendAdapter` includes execution plus `CodexBackendControls`: project/session catalogs, inspection, history/paging/snapshots, runtime information, models, rate limits, goals, and lifecycle controls. Both implementations implement every method; unsupported operations return `CodexBackendCapabilityError`.
- `CodexExecRunner` uses `codex exec` / `codex exec resume` for turns and `CliSessionStore` for local read-only inspection and public history. It never starts app-server or reads Desktop's project registry to satisfy these operations.
- `CodexAppServerBackend` implements execution and lifecycle through JSON-RPC. Its user-facing session catalog reads Desktop's own catalog; that is a separate operation from listing app-server storage. Explicit host + thread membership wins. Legacy records use Desktop's workspace-root grouping only when no explicit assignment or independent-task marker exists.
- `CodexBridgeBackend` routes **all** calls to the selected backend, including control-plane calls. `backendInfo` exposes that backend's capability record so commands can reject unsupported actions before changing settings or claiming success.
- `DesktopCodexRunner` implements `CodexThreadContinuation`, not `CodexBackendAdapter`. It exists only to continue an app-server thread whose active writer is Codex Desktop.

Live observations and continuation must agree on the owner. A task active on the selected App Server connection is authoritative; a stored `idle`/`notLoaded` record is not proof that Desktop is idle. The router checks the local Desktop owner snapshot in that case and remembers the owner for subsequent reads and writes. The CLI and remote paths do not query local Desktop IPC. A failed Desktop snapshot after successful discovery is surfaced, not converted to idle. Discovery absence/timeouts permit the private App Server path only; its writer lock must succeed before a turn can start, otherwise the Desktop relay performs another guarded preflight.

Desktop snapshots use the loaded writer's `threadRuntimeStatus` and chronologically ordered `turnHistory` (older pages can be appended out of order). A null-ID `inProgress` history item is an unacknowledged UI message, not a real active turn. If the runtime is idle with such an item, normal messages are rejected visibly rather than creating another optimistic tail. Relay starts also wait for actual idle state and reject acknowledgements that return a previously observed turn ID; an uncertain write is never retried. These safeguards prevent new polluted records; they do not edit or clear existing Desktop UI history.

Local observation first reads private metadata with a 5-second budget, then reads the live Desktop owner before hydrating foreign history. Known archived/missing metadata and a task active on the selected app-server remain authoritative. Concurrent inspections/followers share only in-flight reads by backend/host/thread/operation; completed snapshots are not cached as permission to write. Desktop's read-only handshake has a single 10-second total budget, shares concurrent inspection/snapshot reads, ignores remote broadcasts, and closes its observation sockets on shutdown. Read failures cannot submit/replay messages or erase bindings. Async widget discovery and answer confirmation use the same accepted native reply receipt; an answered widget is not redispatched as a pending request. **App panel auto-dismiss is not implemented by Gateway**: the native UI submit callback clears its selected question after local submission, but the follower answer RPC does not call that UI callback. The current IPC contract has no panel-dismiss operation. Recognizing an accepted answer is not evidence that the panel disappeared. Do not resubmit the answer, synthesize a skip, falsify owner state, or modify the installed App to conceal this limitation.

Both Desktop IPC consumers use `IpcFrameDecoder`: validate the uint32 LE frame length before allocating, then copy each incoming byte once. Fragmented large snapshots must not concatenate the complete buffered prefix on every chunk; that quadratic copying can starve otherwise healthy RPC receipts in the multi-subscription service. The existing 64 MiB frame cap remains enforced. Pending interaction state patches atomically path-copy only changed containers, preserving untouched history and previously presented request identities. Invalid patches suspend stale handlers and request a fresh read-only snapshot; they do not manufacture answers. Regression covers fragmented/oversized frames, linear byte-copy accounting, atomic patch rollback, prototype safety and immutable question snapshots.

For new **project-scoped** app-server threads, Bridge resolves the protocol-native project ID from `project/list` by workspace root before `thread/start`. Codex Desktop's UI project ID is retained as routing metadata but is not passed through as an app-server project ID because the two ID spaces are different. If the app-server registry does not yet contain the workspace, Bridge creates it idempotently.

For an explicitly independent new session, `CodexRunnerInput.projectBinding: "none"` is separate from the required `cwd` and cannot be combined with project hints. App-server sends `thread/start.projectId: null`, does not query/create a project, and clears any unexpected returned assignment with `thread/metadata/update.projectId: ""` before the first turn (verified against the installed 0.150.1 experimental schema). CLI spawns `codex exec` in the independent workspace without a project API or invented flags. Existing thread membership is never rewritten by this independent-new-session path. The general lifecycle is described in the [App Server documentation](https://learn.chatgpt.com/docs/app-server); Desktop sidebar rendering still depends on its own synchronization.

Bridge-only policy and private knowledge are sent through `developerInstructions`; the channel user's text remains the actual turn input. Bridge sets a clean user-facing name with `thread/name/set` before the first turn and persists the new thread ID as soon as `thread/start` returns, so Desktop can display and group long-running tasks immediately.

The shared types and interfaces live in `src/codex/backend.ts`. Concrete implementations do not import their public input types from one another.

### Native queue and receipt recovery

`CodexNativeQueue` is an optional backend port for experimental native queue add/list/delete/consume operations. The router resolves the selected host/backend and actual execution owner; exec never borrows app-server, and the current Desktop continuation relay cannot safely steer or consume a native queue. Unsupported operations fail explicitly.

`NativeQueueCoordinator` is a shared application service, not an IM adapter or a second execution backlog. Codex owns input content, order and pending-item persistence. Gateway stores only account/conversation/actor/message identity and submission/turn/delivery receipts in `runtime/native-submissions.json`, durably before submission. Recovery pages through native queue and history using exact client and turn IDs, never text similarity. Ambiguous writes are not retried; known consumed turns are observed, never started again. Delivery uncertainty stops automatic re-delivery and points to `/history`.

Queue operations use short per-host/backend/thread control locks. Execution observation is separately guarded per thread; different threads recover independently, and controls/approvals do not wait behind a running task. A native item may auto-start on add or resume: retain the subscribed execution connection and route approval/user-input events to its original account and actor. Only an idle, verified native head may be explicitly consumed. Queued turns use the same progress, approvals and final-delivery pipeline as ordinary turns; binding changes do not retarget accepted work.

Private stdio shutdown interrupts active execution. Native pending items and receipts persist, but active work is not transparently migrated to another executor. Shared daemon lifecycle is independent of Gateway clients. These distinctions are tested with an isolated real Codex binary and local mock model, including busy submission, restart and exactly one observed execution per native input.

### Session discovery is a first-class backend operation

`listSessionCatalog` returns `CodexSessionCatalog` with `backend`, `source`, `threads`, `hostIds`, `complete`, and `warnings`. `/sessions` consumes this contract; it does not combine raw CLI and App storage. `listThreads` remains a lower-level storage/lifecycle operation.

- CLI: `cli-rollouts`, local discovery including ordinary persistent `exec` sessions. Desktop files are never consulted.
- App: `desktop-catalog`, a read-only snapshot of `local_thread_catalog` in `$CODEX_HOME/sqlite/codex.db` or `codex-dev.db`. This is the App's catalog, **not** `sidebar-project-thread-orders` (an incomplete ordering index). Query all rows for each host, exclude `missing_candidate`, and retain exact host + thread identities. Known catalog hosts are discovered even when no project is registered for them. Local persistence is rechecked against the local state database to exclude stale archived/deleted entries; selecting a row rechecks its backend lifecycle on every host.
- Catalog structural exclusions follow the installed Desktop implementation: ephemeral/child tasks, ambient suggestions, PR-fix automation, and `exec` sources are not Desktop catalog conversations. This is an App visibility rule, not a claim that every CLI `exec` session is a probe. Do not filter on titles such as `READY`.
- ChatGPT catalog entries are counted separately as unsupported, never represented as bindable Codex threads. Gateway does not implement a ChatGPT backend.
- A persisted catalog has no authoritative live runtime status. These rows display `unknown`; they must not inherit a private reader process's `notLoaded` status. No thread is resumed or writer lock acquired for discovery.
- Missing catalog (older App / standalone app-server): use paginated app-server storage with App structural rules and a visible compatibility warning. Incomplete sync is explicitly labeled partial. An incompatible or ambiguous catalog fails visibly, never switches to CLI or presents guessed data as the App list.

This is a version-dependent **local compatibility adapter**, verified against the installed Desktop catalog schema. It does not expose an officially supported Desktop remote-list API. Catalog snapshots reflect App synchronization and cannot promise to include unsaved renderer-only state. All reads are read-only; no migrations or repairs are performed on App databases.

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
| `auto` | App-server first; pin the chosen backend for this router's lifetime | Initial project discovery or a compatible fresh turn can choose CLI; existing-thread operations and already-selected App operations never switch after failure | Supported unless CLI was selected |

An active-writer error is not a backend fallback. It remains inside the app-server path and may use the Desktop continuation relay for that thread.

## Follow synchronization boundary

`SessionFollowPort` (`src/bridge/session-follow.ts`) is the application boundary between channel commands and persistent delivery. `BridgeService` handles `/follow`, `/follow on|off|sync` and status presentation; `AccountManager` resolves the account + session binding and verifies it is still active. `ThreadEventHub` owns subscriptions, synchronization health, read cursors and card checkpoints. IM adapters only implement presentation and acknowledge transport delivery. No DingTalk-only synchronization implementation or second binding flow is introduced.

Both background recovery and explicit synchronization use the selected backend's existing read-only `readThreadSnapshot(threadId, hostId)` contract. CLI's `liveFollow: false` is honored before synchronization. An explicit sync never calls start, resume, steer or stop, does not enable disabled following, and respects `/stream off`. Repeating `/follow on` performs a new synchronization even when the setting is already on.

Targeted reads have a 25-second deadline and do not wait for unrelated subscriptions. Concurrent manual requests for a binding are coalesced; a newer read supersedes late background results, and binding changes invalidate delivery. Persisted health distinguishes successful sync, unconfirmed runtime, backend timeout/failure, and card delivery failure. Runtime `notLoaded`/`unknown` and orphan Desktop UI turns never count as successful synchronization. Safe structured diagnostics include host/thread identity and an error category, never provider payloads or credentials.

Activity cards restore from their saved handles even when all progress entries are already deduplicated. Explicit recovery probes update that same handle; failed updates do not create replacement cards or switch to text. Text-only channels retain native batching without replaying past turns. Completed turns remain terminal and final delivery remains deduplicated across restarts.

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
3. Implement every common control method with either its own implementation or an explicit capability error; never route an unsupported operation to a different backend.
4. Add backend contract tests covering strict selection, failure behavior, stop/close semantics, and capability declarations.
5. Do not add channel-specific behavior to a backend; progress rendering, cards, and attachment delivery belong above the facade.

## Session intervention and restart recovery

`ThreadEventHub` owns persistent delivery state above the backend facade. Its keys include the account/binding, host, thread, and active turn. `readThreadSnapshot` is the backend's read-only observation API; it uses native thread reads and paginated turns, without resuming or taking writer ownership. Local rollout notifications supply immediate activity; five-second reconciliation repairs missed notifications, supports remote hosts, and closes a card when its turn completed while the gateway was stopped. Only public commentary, progress summaries and answers are forwarded.

`runtime/thread-subscriptions.json` stores the active turn, last observed lifecycle state, delivered-event hashes, completed turn IDs, and streaming card checkpoint. DingTalk declares support for updating a persisted card ID after restart. Other transports fall back to new messages when they cannot resume a card. A failed terminal card update remains pending for retry; the fallback answer is not repeatedly sent.

Historical baselines are separate from confirmed completions. Private App Server reads of `notLoaded` Desktop threads can reconstruct an active turn as completed/interrupted, so these snapshots never finalize a card. Local lifecycle records supply terminal evidence and recover persisted pending turns after restart. The bounded log-tail reader can recover a long turn's identity from explicit context/usage records even when its start marker is outside the tail. Remote recovery needs an authoritative shared runtime; an unloaded, foreign remote writer's terminal state cannot be safely inferred. Card recovery applies to checkpoints created by this implementation, not cards created by older releases that never saved their handles.

Rollout identity and visibility are parsed centrally: `id` identifies the current thread; legacy `session_id` is only a fallback, since it may identify a reviewer's parent. Guardian reviews and subagent sources are excluded before any history-catalog, progress, completion, project-notification or startup-recovery callbacks. Filtering is based on event provenance, not words inside the answer. Progress and completion hints cannot switch an active card to another turn; only a real start event or an authoritative loaded snapshot can advance it. Retired turns stay rejected after restart. Versioned checkpoints discard text saved before this boundary existed while retaining recoverable card handles.

For local replay of an internal rollout, run `TMPDIR=/private/tmp node --import tsx scripts/verify-rollout-isolation.mjs --run /absolute/internal-rollout.jsonl`. It uses a temporary copy and mock delivery, verifies that internal events cause zero sends while the main task still completes, and removes its temporary files. It does not call Codex or IM APIs.

`SessionControlJournal` serializes controls by host/thread and writes receipts before submitting either guarded input or an ordinary thread-scoped message. Both reuse the same receipt format and write-ahead store, not a second queue. Accepted duplicate requests return the recorded result. A request with an unknown transport outcome is never automatically replayed; the user is asked to inspect history. Pending choice cards persist their actor, chat, binding and expected turn, so an old click cannot affect a newly selected session. This does not claim transactional exactly-once delivery across IM APIs: a crash between a remote acknowledgement and the local checkpoint can still leave an uncertain outcome. The gateway does not automatically replay an unconfirmed user action.

The current Desktop follower `thread-follower-steer-turn` v1 does **not** accept `expectedTurnId`: Desktop chooses the turn itself and may retry on a different one. Therefore explicit `/steer` and turn-targeted choice cards cannot use it. Strict steering remains available through the shared App Server's official `turn/steer`, which enforces `expectedTurnId`. Desktop interrupt v4 supports an expected turn guard; the router obtains that ID from the actual owner and never interrupts an orphan UI tail. The private Desktop protocol is version-dependent and is not equivalent to the official App Server API.

Ordinary IM text during an active turn defaults to `steer`. The application distinguishes **conversation-targeted ordinary input** from **execution-targeted `/steer`**. For a local Desktop owner, the facade's `submitThreadMessage` uses the native conversation input RPC once; Desktop selects the actual receiving turn, whose ID is returned as the receipt. It does not claim caller-selected turn atomicity. Binding identity is rechecked immediately before writing; idle/orphan/unknown owner state rejects input without starting a task, queuing, stopping, or replaying it. A lost or invalid receipt remains uncertain after restart. Non-Desktop owners use official guarded `turn/steer`; failures never switch writers. This is not an implicit queue/start fallback. The existing follow subscription continues to update the same active card and deliver the eventual result; the input receipt does not replace its card checkpoint or completion cursor.

Explicit per-session overrides remain intact: `ask` offers only supported guarded actions, and `queue` submits to the native next-turn queue. Exec rejects unsupported active input; Desktop still rejects native queue consumption. No implicit policy or backend fallback occurs. The same policy boundary applies to DingTalk, WeChat and Feishu. Binding changes invalidate subscriptions centrally. Switching or leaving does not interrupt Codex; queued work stays attached to its original session, but later progress/results are not delivered into the recipient's new binding. `/leave` remains detached across restart until an explicit selection or `/new`. `/stream off` suppresses followed progress without losing the final result.

### Chat commands

| Command | Behavior |
| --- | --- |
| `/help`, `/help session` | Show all commands, or just the session intervention guide |
| `/sessions` or `/sessions all` | All bindable unarchived ordinary sessions grouped by project (current first, others by name, standalone last), newest within each group; 30 per page by default; no project prerequisite |
| `/sessions size 50` | Set 5-50 rows per page, persisted per account/conversation/actor; re-page a valid snapshot without rediscovery or changing R identities |
| `/sessions detail R1` or `/session detail R1` | Read details from the current actor's catalog snapshot without binding; available to viewers |
| `/sessions more`, `/sessions prev`, `/sessions page 3` | Page within the same snapshot; R codes remain stable for 15 minutes, until refreshed |
| `/sessions search words` | Filter titles, previews, IDs and directories, then paginate matches |
| `/sessions unbound` | Sessions without native/Desktop project membership; CLI has no native membership, so its sessions qualify |
| `/sessions project` | Optional current-project filter; App uses actual membership, CLI uses derived workspaces |
| `/session R1` | Bind, replay history, and start following if the backend supports it |
| `/session THREAD_ID [--host HOST_ID]` | Directly inspect and bind without a project; default host is local |
| `/project`, `/project C1`, `/project P1` | Optional project-first workflow; selecting registers and switches; `/project add` is a compatibility alias |
| `/new` | Prepare a new session in the current project; prompt if none is selected, never pick the first saved project implicitly |
| `/new P2`, `/new C1`, `/new --project NAME` | Prepare and switch to a new session in the selected project, using the same selector as `/project` |
| `/new --standalone` | Prepare a local independent session with a unique durable workspace; no inherited project or remote host |
| `/session new ...`, `/s new ...` | Aliases normalized before mode and role checks |
| `/history 10`, `/history more` | Read recent messages, then older pages |
| `/follow on`, `/follow off` | Toggle live delivery for the selected session |
| `/leave` | Persistently detach and stop following, without stopping the task or implicitly resuming on the next message |
| `/policy ask`, `/policy steer`, `/policy queue` | Handle ordinary messages received during an active turn; global default is steer, explicit session overrides are preserved |
| `/steer text` | Submit guarded input to the active turn |
| `/queue text`, `/queue list`, `/queue cancel id` | Submit to native queue, inspect this chat's receipts, or cancel an owned pending native item |
| `/intervene ID steer\|queue\|cancel` | Resolve the originating user's pending choice |
| `/role`, `/role USER viewer\|participant\|controller` | Inspect or configure chat permissions |

Global catalog loading follows every App-server page or scans the full CLI store; UI page size is not a discovery cap. Internal review/subagent, archived, missing, ephemeral and system-error sessions are excluded. Unavailable remote hosts produce partial-results warnings, not backend fallback. Native card choices carry exact host + thread IDs, so an old card never reinterprets its R code against a newer snapshot. R snapshots are scoped to conversation + actor. Selection rechecks lifecycle and permissions rather than trusting cached rows.

#### Probe records versus user conversations

Health-check conversations are not necessarily archived: `source=exec` and a `READY` title do not prove that a task is a probe. The Gateway therefore uses an optional, deployment-local `session-purposes.json` in its state root (shared by all IM accounts). Administrators may record **confirmed** probe identities:

```json
{"version":1,"entries":[{"hostId":"local","threadId":"confirmed-probe-thread-id","purpose":"probe","reason":"Verified against the health-check script and run record"}]}
```

This is Gateway catalog policy, not a backend lifecycle state. Both CLI and App-server catalogs pass through the same filter before counting, grouping, numbering and pagination; all IM renderers receive the same filtered rows. `/sessions`, `all`, `unbound`, `project` and search exclude marked probes and report the hidden count. Unmarked conversations are not removed by this filter because of their titles or `exec` source; Desktop's own catalog visibility rules still apply in App mode. Host + thread ID matches are exact. A missing file means no classifications; malformed or unreadable files produce an explicit warning and do not silently hide tasks. Keep real host IDs and thread IDs in deployment state, not in source control.

Discovery does not write the registry or modify, archive or delete Codex tasks. Direct `/session <ID> [--host HOST]` access remains available after lifecycle checks. Remove an entry (or set its purpose to `conversation`) and refresh `/sessions` to restore its visibility. Registry changes take effect on refresh; existing page snapshots keep stable R identities until refreshed or expired.

Prevent new probe pollution at the source: use `codex exec --ephemeral` for disposable CLI health checks, or `ephemeral: true` for App-server test threads. Normal Gateway conversations remain persistent. See [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

Bindings are identified by host + thread ID within a channel recipient. A project is optional: `ManagedSession.projectBinding: "none"` prevents normalization from creating a fake project from an independent task's cwd, including pending sessions without a thread ID. Existing persisted project bindings are preserved. New-session commands prepare the Gateway record; the next message starts the actual Codex thread. Independent workspaces are allocated under the account state directory at `workspaces/standalone/session-*`, persist across restarts, and are not deleted on switching or completion. Project selection remains useful for project-scoped `/new`, Taskboard and knowledge-base modes, but is no longer required to continue existing tasks or create independent sessions. CLI's project catalog is still a derived list of working directories, not a native project registry.

### Backend capability coverage

| Operation | CLI (`exec`) | App (`app-server`) |
| --- | --- | --- |
| Project discovery | Derived local workspaces from rollouts | Native catalog + Desktop routing metadata |
| Global sessions | Local rollout/index implementation; no Desktop dependency | Read-only Desktop catalog, with explicit older-App storage fallback |
| Inspection, public history/paging | Local rollout/index implementation | Native paginated thread/turn APIs |
| Continue existing task | `codex exec resume ID` | Native continuation; Desktop-owned writer relay where applicable |
| Runtime state | Unknown for foreign processes; own active process is confirmed | Catalog runtime unknown; native inspection describes the queried server, not a different Desktop writer |
| Remote host | Explicitly unsupported | Registered remote transport |
| Live following / guarded steering | Explicitly unsupported; history and new turns remain available | Supported subject to writer/protocol constraints below |
| Native queue add/list/delete/consume | Explicitly unsupported | Experimental native APIs; actual Desktop relay consumption unsupported |
| Stop | Gateway's own CLI subprocess only | Native interrupt / guarded Desktop relay |
| Models, rate limits, goals, lifecycle mutations, native plan mode | Explicitly unsupported; explicit model/effort execution flags remain usable | Native APIs |

The CLI history reader only emits public user/assistant messages; developer/tool/private reasoning and internal child sessions are excluded. Disk history does not prove that another CLI process is running. CLI bindings do not start live-follow subscriptions, and cannot promise to queue behind an unrelated process. The gateway never kills another application's process to acquire a session.

Protocol reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server). Desktop membership is separate from native project IDs: explicit assignments and independent-task markers override legacy workspace grouping; no unregistered projects are invented from directories.

The existing allowlist still gates access. Explicitly allowed individual users default to controller. Users admitted only by a group allowlist default to participant. An explicit per-user role overrides that default; `/role * viewer` sets the group default without removing individually configured controllers. Viewers can inspect sessions and history; participants can converse and steer; controllers can additionally stop turns, handle approvals, and manage roles. Natural-language intents and native card callbacks pass through the same role checks as slash commands.

Validation includes a completed-offline turn updating its original card, host isolation, duplicate and ambiguous control receipts across restart, concurrent actors, stale choice rejection, role restrictions, and history cursors. Full live validation additionally requires a running shared App Server and actual IM delivery; mocked tests alone do not establish Desktop compatibility or client-side rendering.

The opt-in `scripts/verify-live-intervention.mjs` creates a separate ephemeral, read-only task and checks that guarded steering changes that same turn's final response. Run with `TMPDIR=/private/tmp node --import tsx scripts/verify-live-intervention.mjs --run /absolute/path/to/codex` on macOS. It never sends to an existing thread or IM account. This test passed with Codex 0.153.4; it verifies the official protocol, not the Desktop private relay or DingTalk rendering. Protocol reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server).
