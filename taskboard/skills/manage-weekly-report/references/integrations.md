# Weekly report integrations

## Local components

Verify paths and runtime state before acting; these are the current machine defaults:

- Weekly report workspace: `/Users/shicheng_lei/code/周报`
- Confirmed archive filename: `YYYY-MM-DD至YYYY-MM-DD周报.md`
- Weekly report renderer: `http://127.0.0.1:42732`
- codex-weixin Bridge admin: `http://127.0.0.1:8787`
- Bridge-owned Taskboard: `http://127.0.0.1:47823`
- Taskboard data: `~/.codex-weixin/taskboard/`

The weekly renderer imports archive files matching the filename pattern and groups them by year. Its UI owns the `草稿` / `已确认` / `已发布` display state and mail settings.

## Collect evidence from codex-weixin Taskboard

Use the existing `manage-taskboard` Skill and `taskctl` contract when Taskboard evidence is useful. Keep report collection read-only unless the user explicitly requests a Taskboard mutation.

1. Resolve the current project:

   ```bash
   taskctl context current --cwd /absolute/project/path --json
   ```

2. Copy the returned project ID and use it explicitly:

   ```bash
   taskctl issue list --project PROJECT_ID --json
   taskctl issue get ISSUE_ID --json
   taskctl comment list ISSUE_ID --json
   ```

3. Use issue descriptions, comments, status transitions, and timestamps only as evidence. A current status alone does not prove that work happened during the report period. Ask the user when timing, ownership, or business meaning remains ambiguous.

Do not use `context current` as the final mutation target when same-named projects may exist. Do not write Taskboard comments or move issues merely to record report collection.

The Bridge is a channel-to-Codex runtime and Taskboard context provider. Its webhook mirroring does not grant access to private WeCom chats, mailbox content, or historical messages.

## Check local services

Use read-only probes first:

```bash
curl -fsS http://127.0.0.1:42732/ >/dev/null
curl -fsS http://127.0.0.1:47823/health
curl -fsS http://127.0.0.1:8787/api/taskboard
```

The renderer LaunchAgent label is `com.shichenglei.weekly-report-renderer`; it starts the renderer only while Codex is running. Bridge owns both `8787` and `47823`. Do not start a standalone Taskboard beside the Bridge.

If a service is unavailable, continue collecting user-supplied facts and report the missing integration. Do not perform a broad service reset merely to draft text.

## Archive and render

After explicit confirmation, write the complete report to the weekly workspace using the required filename. Do not overwrite an existing confirmed archive without explicit user direction. Open the renderer to check the year group, report title, Markdown preview, and confirmed state.

## Create the WeCom email draft

Use the renderer's `生成邮件` action so its validation and WeCom compatibility handling remain in the path. Current defaults are configurable in the UI:

- To: `chen_wu@intsig.net`
- CC: `huihui_guo@intsig.net`
- Subject: `周报-雷诗城-Web`
- Body: the complete current report content

Opening the composer is an external desktop action. Do it only when the user asks to generate the draft. Leave the composer unsent and ask the user to review it. Mark the report `已发布` only after the user confirms actual delivery or publication.
