# Codex Channel Bridge Design System

## 0. Research Log

- Existing product: extracted the current local management UI from `src/web/styles.css` and `src/web/index.html`.
- User reference: used the supplied compact folder/task sidebar only for hierarchy and density, not for brand cloning.
- Direction: a quiet local operations console. Codex projects read as folders, tasks sit directly beneath them, and WeChat account ownership stays visible without adding decorative chrome.

## 1. Atmosphere

Light, compact, trustworthy, and filesystem-oriented. The memorable interaction is expanding a Codex project folder to reveal its tasks in place.

## 2. Color

All product colors use the existing CSS tokens: `--canvas`, `--surface`, `--surface-muted`, `--ink`, `--ink-soft`, `--line`, `--green`, `--green-dark`, `--green-soft`, `--amber`, `--red`, and `--focus`.

## 3. Typography

Primary stack is the existing Avenir/system/PingFang stack. Project names use 13px/700, tasks use 12px/650, metadata uses 9–10px. Body content never drops below the existing 13px scale; smaller sizes are labels or metadata only.

## 4. Spacing & Layout

The existing 4px-derived rhythm remains authoritative. Project groups use 8–12px internal gaps, 12–16px horizontal padding, and the existing 6px `--radius`. The session workbench remains a two-column shell and collapses to one readable column at the existing mobile breakpoint.

## 5. Components

### Project Group

- Structure: folder header button, task count, project actions, nested task list.
- States: default, hover, expanded, active project, empty, focus-visible.
- Accessibility: semantic buttons, `aria-expanded`, visible focus, complete keyboard reachability.
- Motion: existing 160ms transform/opacity transitions only.

### Project Dialog

- Structure: account selector, project name, and a project selector populated only from Codex local session metadata (`cwd`), plus cancel/save actions.
- States: default, focus, validation error, submitting.
- Accessibility: explicit labels, unique name-plus-path options, loading/empty/error copy, and modal focus behavior.

### Account Project Panel

- Structure: compact section header, managed-project count, “添加已有项目” action, and directory rows grouped inside the owning WeChat account card.
- States: populated, empty, hover, focus-visible, disabled delete when tasks still exist.
- Accessibility: every project action names its target project; full project names and paths remain available through visible text or `title`.
- Layout: rows wrap to a vertical action stack on narrow screens without horizontal scrolling.

### Channel Settings Dialog

- Structure: local display name, Webhook notification-platform selector, optional Webhook URL replacement field, provider-specific URL guidance, current Webhook status, explicit clear switch, and cancel/save actions.
- States: not configured, configured, replacing, clearing, validation error, submitting.
- Accessibility: the dialog title and close action name the channel settings task; the platform uses a native select, the URL input uses native URL semantics, and configured state is expressed in text rather than color alone.
- Security: Webhook URLs may contain signing secrets, so account list responses expose only `webhookConfigured`; the saved URL is never rendered back into the browser or written to logs.

### Webhook Status Row

- Structure: a third channel-identifier row labeled `Webhook`, with concise `已配置` or `未配置` text.
- States: configured and not configured.
- Layout: reuse the existing identifier grid without introducing a new badge or card style.

### Session Row

- Structure: active marker, task title, activity time, context preview, actions.
- States: default, hover, selected, responding, disabled actions.
- Accessibility: existing pressed states and action labels remain.

### Taskboard Integration Panel

- Structure: local-service enable switch, loopback URL, connection state, and one mapping row per managed Codex project.
- States: connected, unavailable, disabled, mapped, unmapped.
- Accessibility: connection meaning is expressed in text as well as color; paths remain selectable and horizontally wrap instead of clipping.
- Security: the URL field accepts HTTP loopback origins only; remote Taskboard endpoints are outside this local-console contract.

### Taskboard Workbench

- Structure: compact status metrics, project/status/search filters, a dense issue list, and a detail panel with description, Codex thread attribution, progress comments, and workflow actions.
- States: connected, unavailable, empty, filtered-empty, loading detail, selected issue, read-only unbound issue, actionable issue, blocked, in review, and done.
- Workflow: the workbench exposes only mapped workspaces; comments and transitions require an existing Codex thread. `blocked` and `in_review` require evidence, and `done` is available only from `in_review` through an explicit acceptance dialog.
- Accessibility: issue rows are pressed-state buttons, filters have visible labels, status is always expressed in text, and workflow confirmation uses a labelled modal.
- Layout: the list/detail split follows the Session Workbench and collapses to a single column below 760px without horizontal scrolling.

The legacy workbench contract remains documented for compatibility with older builds. The current management UI uses the full Taskboard management view below.

### Taskboard Management View

- Structure: a fourth peer tab named “任务面板” in the existing management-view navigation and a full-width Taskboard frame in the main content region.
- Behavior: selecting the tab replaces the Bridge status and content surfaces in place; it does not open another window or sidebar. The frame uses the configured loopback Taskboard URL and is loaded on first selection.
- States: default, hover, focus-visible, active, Taskboard loading, and Taskboard unavailable.
- Accessibility: the tab uses the existing keyboard-reachable tab primitive and the frame has a concise Chinese title.
- Security: the frame policy permits HTTP loopback hosts only; arbitrary remote frame origins remain blocked.

### Channel Task Workbench

- Structure: one project-scoped overview card, paged task rows, a task detail card, and native channel forms for creation, progress, blocking, review, and return. The complete Taskboard remains available through a loopback deep link for desktop clients.
- Behavior: natural-language intents and card actions resolve to the same typed Taskboard operations as the command surface. Overview filters, task selection, form opening, submissions, and workflow results replace the originating card in place when the channel supports message updates; text-only channels receive the command-compatible fallback.
- States: overview, filtered overview, empty, detail, form entry, submitting, success, stale-version conflict, invalid transition, and unavailable. A successful action returns to fresh Taskboard data rather than preserving optimistic card state.
- Workflow: action visibility follows the Taskboard transition map. Blocking, review, and return require a native text field; completion requires an explicit acceptance action. Every mutating card carries the issue version so a stale or duplicate submission refreshes instead of blindly retrying.
- Accessibility: controls use visible verbs and status text, required fields carry explicit labels, destructive or final actions use confirmation, and the card never relies on color alone. Platform-native focus, keyboard, touch, validation, and reduced-motion behavior remain authoritative.
- Interaction: async state follows idle to submitting to refreshed-success or refreshed-error. Feishu owns control motion; the Bridge communicates progress by replacing actionable controls with the latest card state rather than adding custom animation.
- Security: card callbacks are parsed at the channel boundary, accept only declared form fields and bounded lengths, and never include credentials. The clicking actor is authorized separately from the reply conversation; an allowed conversation ID is an explicit group-wide ACL. Evidence and its version-checked status transition commit in one Taskboard transaction. Taskboard links remain loopback-only and are supplemental because mobile clients cannot open the host Mac's loopback service.

### Codex Sidebar Integration Entries

- Structure: two native-looking rows placed immediately after Codex's Plugins row: “任务面板” first and “渠道配置” second.
- Behavior: the two rows are peer navigation entries. “任务面板” and “渠道配置” switch the same embedded main-workspace surface between Taskboard and the loopback Codex Channel Bridge page; selecting the current row keeps the current page instead of opening another surface.
- Layout: the shared embedded surface begins below Codex's measured native titlebar and fills the remaining project workspace; standalone Taskboard and Channel Bridge pages retain their own full-page layout.
- States: default, hover, focus-visible, and active. Exactly one integration row claims the current-page state while its embedded surface is visible.
- Accessibility: each row has a distinct icon, visible text, and an action-specific accessible name.
- Security: the channel entry resolves only to an HTTP(S) loopback URL and never carries credentials in its label or DOM text. Channel Bridge permits the exact `app://-` Codex frame ancestor while ordinary web ancestors remain blocked; mutation-origin checks remain unchanged.

## 6. Motion & Interaction

Use the existing 160ms micro-interaction timing. Respect `prefers-reduced-motion`; no layout animation.

## 7. Depth & Surface

Mixed but restrained: tonal shifts for hierarchy, borders for separation, and the existing single workbench shadow. Nested cards and decorative gradients are not introduced.

## 8. Accessibility Constraints & Accepted Debt

Target WCAG 2.2 AA, visible focus on every interactive control, and no horizontal scrolling of primary content at 375px. No new accepted debt.
