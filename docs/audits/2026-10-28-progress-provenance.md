# 2026-10-28: progress provenance and cumulative progress repair

## Confirmed failures

- A new child rollout begins with its own `session_meta`, then may contain a copied parent header. The live monitor previously reassigned the file owner on each header. Child terminal events were therefore emitted as parent results. The reported OpenClaw card contained the review child's final text while the Desktop parent was still running.
- Native progress snapshots can contain cumulative machine records. Rendering an entire block as one update repeated compaction notices, retained obsolete current activity and produced large gaps. The execution callback also deduplicated compaction start/completion strings for the entire turn, dropping subsequent genuine cycles.

## Boundaries and implementation

- The first rollout header permanently determines that file's owner and internal/public classification. Inherited headers cannot change either. A truncated file gets a fresh cursor without replaying its old history.
- Cumulative machine-only progress is normalized to individual records before reduction. Ordinary Markdown remains one update. Bounded persisted fingerprints suppress cumulative replays; latest-occurrence ordering preserves genuine new phases. Compaction's two explicit transitions reopen only the opposite phase in the callback cache.
- Existing polluted presentation ledgers require both a complete native source index and a fresh, exact-thread Desktop snapshot. The reader is read-only, rejects internal/foreign/torn sources, bounds file size, turn count and scan time, yields during streaming, and detects replacement/truncation. Remote daemon paths are never opened locally.
- Source scans run outside the subscription command queue. `/status` and ingress do not wait for a large transcript scan. Binding changes, stopped followers, wrong identities, terminal or incomplete source proof cannot authorize a presentation repair.
- Repair removes foreign presentation markers and preserves actual native history. A healthy current card stays in place. A polluted current slot receives a correction and a fresh projection of the same native active turn with its original elapsed time. No native interrupt, resume, archive, new turn, model request, input replay or binding mutation is used.

## Evidence and limits

- Related regression suite: 183 passed, covering source ownership, cumulative progress, repeated compaction through BridgeService, presentation restoration, incomplete/terminal/foreign proof, binding changes, healthy-current cleanup, and a clean-ledger no-op.
- The read-only adapter indexed the actual large OpenClaw rollout in approximately 1.6 seconds. Desktop independently confirmed its current native turn. The prior reported turn had since completed and a new user-authorized turn was active; recovery must not reopen the completed turn.
- The two webhook tests require temporary loopback listeners; an initial sandbox-only rerun reported `EPERM`. The complete related suite passed with loopback test permissions. This was an environment restriction, not a waived test.
- Release preparation separately runs the full test suite, typecheck and isolated build. The release receipt and online verification determine deployment success. Tests do not establish absence of all hidden defects or validate phone-side reachability.
