# Task-card execution status

DingTalk AI progress cards keep a fixed first-screen status heading, separate from model-authored commentary and tool output. An icon and a label communicate the same fact, so color or animation is never the only indication. This is a presentation projection, not another execution state machine.

## Sources of truth

- Accepted progress/answer events: blue **正在执行**; a successful individual tool step does not complete a task.
- Native `waitingOnUserInput` / `waitingOnApproval` flags, or a scoped blocking request: yellow **等你回答** / **等待审批**. Asynchronous questions alone do not assert that execution is blocked.
- Native recovery observation: orange **正在恢复执行**.
- Unknown/unavailable owner or communication receipt: neutral **执行状态待确认**. Silence alone does not imply failure or completion.
- Native terminal result: **已完成**, **执行失败**, or **已中断**. Preserve the exact outcome through follow snapshots, restart recovery, pagination and completion-mention consolidation.
- A presentation-segment closure says **已转入后续卡片**; detach says **已停止同步（任务未停止）**. Neither asserts native task success or stops execution.

The heading is capability-gated (`turnStatusHeader`) and initially enabled for DingTalk AI templates only. Other channels retain their presentation. The existing checkpoint owns the status, raw final body, outcome and page plan. Pre-upgrade partial result plans retain their original page boundaries; an upgrade must not skip or duplicate answer content.

## Native animation is not the execution state

The [AI-card component](https://open.dingtalk.com/document/orgapp/ai-card-template) provides built-in processing presentation and a gradient-border animation while streaming. The input-state Markdown component must enable streaming and bind the configured content key, per the [official tutorial](https://open.dingtalk.com/document/orgapp/typewriter-effect-streaming-ai-card).

The Gateway retains the existing REST streaming lifecycle (`isFull: true`, `isFinalize: false` during updates, then `isFinalize: true` on closure), including full-snapshot compatibility updates. It does not emulate a spinner by making frame-by-frame API requests, inject unsupported CSS/GIF, or substitute a new template. The heading is the authoritative task status; native animation describes the card's open stream, including when that stream is waiting for input. A closed stream can be a stage boundary rather than a completed task.

Failed/interrupted tasks keep the readable body and semantic heading. They do not use the template's native failed-stream fallback that hides the supplied detailed error. Delivery failure itself never authorizes replaying an execution or duplicating a card.

## Verification boundary

Transport tests verify actual REST fields and trusted headings, not mobile rendering. An Android/desktop Markdown preview cannot establish native DingTalk behavior. The running deployment must still be checked on the user's DingTalk mobile client; do not claim that a specific independent circular spinner has been implemented or that mobile animation has been accepted without that check.
