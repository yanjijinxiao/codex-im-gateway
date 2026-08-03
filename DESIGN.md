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

### Session Row

- Structure: active marker, task title, activity time, context preview, actions.
- States: default, hover, selected, responding, disabled actions.
- Accessibility: existing pressed states and action labels remain.

### Taskboard Integration Panel

- Structure: local-service enable switch, loopback URL, connection state, and one mapping row per managed Codex project.
- States: connected, unavailable, disabled, mapped, unmapped.
- Accessibility: connection meaning is expressed in text as well as color; paths remain selectable and horizontally wrap instead of clipping.
- Security: the URL field accepts HTTP loopback origins only; remote Taskboard endpoints are outside this local-console contract.

## 6. Motion & Interaction

Use the existing 160ms micro-interaction timing. Respect `prefers-reduced-motion`; no layout animation.

## 7. Depth & Surface

Mixed but restrained: tonal shifts for hierarchy, borders for separation, and the existing single workbench shadow. Nested cards and decorative gradients are not introduced.

## 8. Accessibility Constraints & Accepted Debt

Target WCAG 2.2 AA, visible focus on every interactive control, and no horizontal scrolling of primary content at 375px. No new accepted debt.
