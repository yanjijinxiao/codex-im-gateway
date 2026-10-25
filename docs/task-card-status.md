# Compact task-card execution status

DingTalk AI progress cards keep a compact, normal-font status strip above model-authored commentary and tool output. No large Markdown heading, colored ball, or prominent completed banner is used. A short text label remains readable even when native motion is unavailable. This is a presentation projection, not another execution state machine.

The strip combines status and elapsed time, with compact tool totals only when present. The body leads with the latest public progress, followed by an optional public summary, at most two recent milestones and two errors, and a bounded answer preview. Stop remains one complete copyable command with an explicit interruption warning. A final ordinary paragraph after the command/preview gives the native streaming cursor a visible anchor outside code fences. Incomplete preview fences are closed for display only; the persisted answer is not rewritten.

## Sources of truth

- Accepted progress/answer events: **进行中**; a successful individual tool step does not complete a task.
- Native `waitingOnUserInput` / `waitingOnApproval` flags, or a scoped blocking request: **等你回答** / **等待审批**. Asynchronous questions alone do not assert that execution is blocked.
- Native recovery observation: **正在恢复执行**.
- Unknown/unavailable owner or communication receipt: neutral **执行状态待确认**. Silence alone does not imply failure or completion.
- Native terminal result: **已完成**, **执行失败**, or **已中断**. Preserve the exact outcome through follow snapshots, restart recovery, pagination and completion-mention consolidation.
- A presentation-segment closure says **已转入后续卡片**; detach says **已停止同步（任务未停止）**. Neither asserts native task success or stops execution.

The strip is capability-gated by the existing `turnStatusHeader` capability and enabled for DingTalk AI templates only. Other channels retain their presentation. The existing checkpoint owns the status, raw final body, outcome and page plan. The old maximum heading-byte reserve is retained even though the strip is smaller: pre-upgrade partial result plans keep their original page boundaries, so an upgrade cannot skip or duplicate answer content.

## Native animation is not the execution state

The [AI-card component](https://open.dingtalk.com/document/development/ai-card-template) provides built-in processing/input presentation. The input-state Markdown component must enable streaming and bind the configured content key, per the [official tutorial](https://open.dingtalk.com/document/development/typewriter-effect-streaming-ai-card). The client chooses the cursor's appearance; a circular mobile indicator and desktop dots do not require separate implementations.

The shared stream passes trusted `activity` metadata alongside the rendered text. It comes from the existing checkpoint, never from a body's wording, elapsed silence, or a tool result. HTTPS and SDK adapters project it using the same rules:

- Running/recovering: write the populated full snapshot first, then a full native stream frame (`isFull: true`, `isFinalize: false`) last. This retains the snapshot compatibility path without immediately following the native cursor with a static write. Existing throttling and 30-second heartbeat remain; there is no frame-by-frame animation timer.
- Waiting for input/approval, or unconfirmed state: select the normal static body (`flowStatus: 3`), without sending a final stream frame or setting the logical task's terminal checkpoint. A later running observation reselects input mode on the same card. Static template mode is not an execution-completion receipt.
- True terminal/segment closure: send the final native frame (`isFinalize: true`), then seal the visible static body. Only the trusted outcome determines the label. A segment closure can say “已转入后续卡片” rather than claiming task completion.

No unsupported CSS/GIF, new template, or separate loading card is introduced. Legacy non-task stream callers that omit activity retain native streaming behavior. The compact status strip remains authoritative when the client does not display animation.

Failed/interrupted tasks keep the readable body and semantic heading. They do not use the template's native failed-stream fallback that hides the supplied detailed error. Delivery failure itself never authorizes replaying an execution or duplicating a card.

## Verification boundary

Transport tests verify actual REST fields, ordering, static/resume transitions and trusted status, not mobile rendering. Two isolated tests with the configured template confirmed desktop dots during idle and their disappearance at finalization; the user's Android screenshot showed a native ring and the user accepted that appearance. This validates the native primitive, not the redesigned production layout or waiting/resume behavior. Those still require real-client checks after deployment; an HTML/Markdown preview is not mobile acceptance.
