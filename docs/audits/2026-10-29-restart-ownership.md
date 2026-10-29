# Gateway restart admission follows actual ownership

The release gate protects Gateway-side work, rather than the duration of an independently executing Codex turn. Previously it used responding-session counters and all backend operation leases. This blocked releases for the entire native execution lifetime even after acceptance. Earlier private stdio execution could instead be interrupted when its Gateway parent exited; simply removing the gate would reintroduce that failure.

## Changes and invariants

- Native Codex uses an independent daemon, including an explicitly configured native CLI installation. The local and SSH transports share the Unix-socket WebSocket relay. The CLI raw-byte proxy cannot be fed JSONL directly; the original path failed initialization. Daemon initialization failure does not fall back to a private execution process.
- Every business invocation and runner invocation starts critical. Only an exact host/thread/turn acceptance, after durable source/audience callbacks, exempts its observation. Another message, stale callback, or result-settling operation cannot borrow that exemption. Private stdio/exec, ephemeral tasks and Gateway dynamic tools remain critical.
- Release synchronously checks critical work and freezes ingress; it pauses presentation and detaches independent observers without a native interrupt. Cancellation restores follow synchronization. The independent native owner keeps running.
- Result actions use the same application journal in the original handler and offline-result recovery. Only exact Gateway source receipts authorize actions. Each action is claimed durably before external I/O, completed actions are skipped, and ambiguous effects are surfaced without automatic resend. Raw action text is not stored in this journal. Web-only attachments remain in Web/native history instead of producing unsolicited IM sends.
- Configuration changes retain the conservative full-work guard. The narrower predicate is specific to restart/release.
- The prior stop-copy fix remains included: the running card footer uses a standalone complete `/stop` text block with native copy controls.

## Verification evidence

- Focused business/transport/presentation/release regression: 128 passed.
- New ownership/result tests: 19 passed. Coverage includes acknowledgement durability, independent vs private executors, stale/concurrent callbacks, real Web submission admission, observer-only detachment, action replay/ambiguous delivery, changed binding, disk failure, source receipt ownership, Web-vs-IM output, paused-result recovery, and active result delivery blocking restart.
- The first full run had four failures: the progress burst itself exceeded its 10ms window, plus fixture startup/IPC/bootstrap deadlines were missed while many TypeScript workers saturated the host. The progress test now explicitly advances a mock clock, preserving the same rate-limit/final-answer assertions. The standard and release test runners cap file concurrency at four; existing IPC/startup assertion budgets are unchanged. The failed full run is retained; the final release repeats the entire suite.
- The next full run exposed another fixture-only timing assumption: IDE cancellation expected startup to reach installation in 5s. The fixture now leaves installation pending for 60s and waits up to 30s for the explicit installing phase before cancelling; the assertions still require cancellation, no late IDE launch, and no running instance. Production readiness/RPC deadlines remain unchanged.
- Native experiment: one isolated read-only turn was active before disconnecting its writer client; a fresh client read the same turn to completion. One native turn, one user input, expected nonce verified, test thread archived. No user session was resumed or messaged. Proof saved outside production state at `/private/tmp/gateway-independent-native-proof.json`.
- The full release preparation repeats all tests and type checking at the final committed source and builds away from live `dist`. Final switch and continuity evidence are recorded separately by release tooling; test success alone is not a claim of deployment.

## Separate interruption investigation

At 2026-10-29 12:11:29 Shanghai time, Codex Desktop logged `update_resume_state_saved`, then stopped its local stdio app-server (`cause=stop_process`). The Gateway repair turn logged `turn_aborted: interrupted` at 12:11:30. A new Desktop process started seconds later and logged update-resume writer conflicts. Gateway PID 39952 had remained alive since 2026-10-28 23:45:58. This sequence identifies a Desktop update/restart interruption, rather than Gateway release admission stopping the task. The log does not establish who initiated the App update.

The independent-lifetime guarantee is relative to Gateway only. Restarting or updating the native executor itself is outside this release gate's scope. Windows daemon lifecycle and phone rendering/network are not validated by the local native experiment.
