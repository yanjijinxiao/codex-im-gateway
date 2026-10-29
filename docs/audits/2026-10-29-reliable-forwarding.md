# Reliable Gateway forwarding and restart boundary

## Confirmed failures

- An ordinary message could be rejected after a read-only thread-state timeout. The input receipt stored only identity/phase, so it was insufficient to restore the normalized body without provider redelivery.
- `runningSessions` covered preparation, native execution and result delivery. Its idle-state branch mislabeled all of these as an unfinished submission, replied with a rejection and then marked the source handled.
- The release path also used durable capacity-backoff/restoration records as live work. Waiting independently executing native tasks and passive recovery obligations are separate from Gateway handoff.
- Source acceptance on steer/queue paths was weaker than the underlying control/queue journal, allowing a later channel error to leave the source uncertain even after a confirmed native receipt.

## Ownership and delivery contract

Gateway owns reliable transport, routing and presentation. Codex owns native execution and its explicit execution queue. The new inbox stores normalized incoming text, attachment descriptors, resolved local files, references and the exact original binding before positive admission. It is an account-scoped transport ledger, not another task executor or a second native task queue.

- Native acceptance retires the pending body. Accepted inputs and ambiguous native submissions are never automatically resubmitted. A proven preflight-only failure may retry the same stable source identity.
- Ordinary inputs retain arrival order until acceptance, then follow the existing steer policy. Explicit native queue policy remains native queue policy. Gateway controls bypass ordinary transport order.
- Normalized content is retained across process death. Files are flushed before their paths are committed. Raw provider callbacks/webhooks are excluded; files use mode 0600. No time-based eviction silently drops pending messages.
- Destination identity includes session, host, thread, workspace/project roots, interaction mode and execution generation. A changed binding holds the message rather than redirecting it. New-thread advancement requires an exact native source acceptance. Structural comparison is independent of serialized property order.
- `/status` exposes counts; `/inbox` provides scoped, bounded record views. Only known-not-submitted inputs may be explicitly forwarded to the displayed current binding or cancelled. The destination version is checked again at action time; other actors require controller authority. Ambiguous submission cannot be overridden by a retry button.
- Gateway commands saved before dispatch can execute once after restart. Commands which may already have partially executed are retained for inspection, without automatic replay.
- The release gate protects active preparation/submission receipt handoff, synchronous interaction exchange and result delivery. A durable pending inbox, a backoff timer or independently accepted native execution does not by itself block restart. Legacy private execution remains a lifecycle migration limitation; removing its guard would kill native tasks and does not repair that coupling.

## Bounded native inspection

Execution preflight reads thread metadata and the latest turn with `itemsView: notLoaded`, preserving the concrete turn/failure guard without hydrating every historical item. Metadata-only observation does not fetch a turn page. This matches the installed protocol schema and [official App Server documentation](https://learn.chatgpt.com/docs/app-server#list-thread-turns).

## Verification

Targeted tests cover exact body/file/reference retention, write/fsync failure, atomic in-memory receipt rollback, lost native acknowledgement, accepted-input deduplication, actor/conversation isolation, changed and ABA bindings, command recovery, actionable formatting, bounded protocol reads, and real process death at received/submitting/accepted boundaries.

Real AccountManager/Bridge integration tests cover the reported timeout, a burst during native acceptance, a slow result delivery, account shutdown/startup, and receiving another message while release admission is frozen. These assertions distinguish steer from a new turn/native queue and require one native write per source.

The final release manifest/log records the complete regression and artifact identity. Passing tests or preparing an artifact is not deployment confirmation. Phone rendering and actual production cutover require separate verification.
