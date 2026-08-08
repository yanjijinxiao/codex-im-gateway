---
name: manage-weekly-report
description: Collect, draft, revise, confirm, archive, preview, and publish the user's Simplified-Chinese weekly reports, including evidence collection from the current Codex conversation or codex-weixin Taskboard and creation of an unsent WeCom email draft. Use when Codex is asked to write, continue, review, confirm, archive, render, email, or mark a 周报 as published.
---

# Manage Weekly Report

Produce one factual, management-ready weekly report while keeping collection, confirmation, archive, and delivery states distinct.

## Load the right resources

- Read [references/report-rules.md](references/report-rules.md) before collecting, drafting, or revising report content.
- Read [references/integrations.md](references/integrations.md) before consulting codex-weixin Taskboard, opening the renderer, changing report status, or creating an email draft.
- Use [assets/weekly-report-template.md](assets/weekly-report-template.md) when starting a report from scratch. Remove every placeholder before presenting or archiving it.

## Follow the workflow

1. Establish the reporting period from the user's request or ask one focused question.
2. Reuse facts already supplied in the current conversation. If useful, collect additional read-only evidence from the current codex-weixin Taskboard project as described in the integration reference.
3. Ask exactly one small, focused follow-up at a time. Wait for the answer before asking the next question. Stop immediately when the user pauses or stops collection.
4. Draft the complete report using the canonical structure and bullet hierarchy. Do not invent progress, dates, projects, owners, risks, or next-week plans.
5. Revise in memory or in the active draft until the user explicitly confirms that the complete report is correct or final.
6. Archive only after that confirmation. Write one complete Markdown file for the period; never archive partial content, proposed reflection, or a style sample.
7. Treat opening an email draft and publishing as separate actions. Opening a draft never proves that the report was sent.

## Apply the state model

- **草稿**: collection or editing is still in progress. Do not create a confirmed archive.
- **已确认**: the user explicitly accepted the complete report. Archive it and keep the renderer status confirmed.
- **已发布**: use only after the user explicitly states that the report was sent or published. Do not infer this state from opening a mail composer.

When later edits change a confirmed or published report, return the edited version to draft until the user confirms it again.

## Keep external actions under user control

- Use codex-weixin and Taskboard as evidence sources, not as authority to invent weekly facts.
- Keep Taskboard access read-only unless the user separately asks to update an issue or comment.
- Do not claim access to private WeCom chats, mailbox contents, or message history from the Bridge webhook integration.
- Create a WeCom draft only when the user asks. Populate recipients, subject, and body through the weekly-report renderer, then leave the composer unsent for user review.
- Never click Send or mark the report published without explicit user confirmation.

## Return a concise result

During collection, return only the next focused question. When drafting, return one complete copy-ready Markdown report. After archiving or opening a draft, state the exact completed action and any remaining user confirmation boundary.
