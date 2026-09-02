(() => {
  "use strict";

  const VERSION = "0.7.0";
  const SOURCE_HASH = window.__CODEX_TASKBOARD_SOURCE_HASH__;
  const SENTINEL_KEY = "__codexTaskboardInjection__";
  const DEFAULT_TASKBOARD_URL = "http://127.0.0.1:47823/?host=codex";
  const DEFAULT_SUB2API_URL = "http://127.0.0.1:10009/";
  const DEFAULT_CHANNEL_BRIDGE_URL = "http://127.0.0.1:8787/";
  const ENTRY_ID = "codex-taskboard-entry";
  const SUB2API_ENTRY_ID = "codex-sub2api-entry";
  const CHANNEL_ENTRY_ID = "codex-im-gateway-entry";
  const CAPABILITY_ENTRY_PREFIX = "codex-capability-entry-";
  const CAPABILITY_ENTRY_ATTRIBUTE = "data-codex-capability-entry";
  const PAGE_ID = "codex-taskboard-page";
  const FRAME_ID = "codex-taskboard-frame";
  const DRAG_REGION_ID = "codex-taskboard-drag-region";
  const NO_DRAG_LEFT_ID = "codex-taskboard-no-drag-left";
  const NO_DRAG_RIGHT_ID = "codex-taskboard-no-drag-right";
  const STATUS_ID = "codex-taskboard-status";
  const STYLE_ID = "codex-taskboard-inject-style";
  const OWNED_ATTRIBUTE = "data-codex-taskboard-owned";
  const HIDDEN_ATTRIBUTE = "data-codex-taskboard-native-hidden";
  const HOST_ATTRIBUTE = "data-codex-taskboard-page-host";
  const NATIVE_SELECTED_ATTRIBUTE = "data-codex-taskboard-native-selected";
  const HOST_BINDING_NAME = "__codexTaskboardHostV1";
  const HOST_HEARTBEAT_NAME = "__codexTaskboardHostHeartbeatV1";
  const REATTACH_DELAY_MS = 160;
  const FRAME_READY_TIMEOUT_MS = 12_000;
  const HOST_REQUEST_TIMEOUT_MS = 12_000;
  const HOST_HEARTBEAT_MAX_AGE_MS = 8_000;
  const CAPABILITY_REFRESH_MS = 5_000;
  const MACOS_TITLEBAR_SAFE_LEFT = 80;
  const FRAME_REFRESH_PARAM = "__codex_taskboard_refresh";
  const TASKBOARD_VIEW = "taskboard";
  const SUB2API_VIEW = "sub2api";
  const CHANNEL_VIEW = "channel";
  const CAPABILITY_VIEW_PREFIX = "capability:";
  const PLUGIN_LABELS = ["插件", "plugins"];
  const NATIVE_PAGE_LABELS = [
    "新建任务",
    "new task",
    "new chat",
    "拉取请求",
    "pull requests",
    "站点",
    "sites",
    "已安排",
    "scheduled",
    "插件",
    "plugins",
  ];
  const PROJECT_SECTION_LABELS = ["projects", "项目"];
  const TASK_SECTION_LABELS = ["tasks", "任务", "chats", "对话"];

  const previous = window[SENTINEL_KEY];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try {
    previous?.destroy?.();
  } catch (_) {}

  let entry = null;
  let sub2apiEntry = null;
  let channelEntry = null;
  let capabilityEntries = new Map();
  let capabilityNavigation = [];
  let capabilityRefreshTimer = null;
  let capabilityRequestGeneration = 0;
  let page = null;
  let frame = null;
  let dragRegion = null;
  let noDragLeft = null;
  let noDragRight = null;
  let status = null;
  let frameOrigin = "";
  let frameReady = false;
  let frameReadyWaiters = new Set();
  let hostRequests = new Map();
  let hostRequestSequence = 0;
  let observer = null;
  let reattachTimer = null;
  let lastFocusedElement = null;
  let hostContextSnapshot = null;
  let mutedNativeSelections = new Map();
  let openGeneration = 0;
  let pendingThreadCreation = null;
  let lastNativeThreadId = "";
  let active = false;
  let activeView = null;
  let destroyed = false;

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeThreadId(value) {
    return String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  }

  function resolveTaskboardUrl() {
    const configured = typeof window.__CODEX_TASKBOARD_URL__ === "string"
      ? window.__CODEX_TASKBOARD_URL__.trim()
      : "";
    try {
      const url = new URL(configured || DEFAULT_TASKBOARD_URL);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:")
        || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
        || url.username
        || url.password
      ) {
        throw new Error("Unsupported local Taskboard URL");
      }
      if (!url.searchParams.has("host")) url.searchParams.set("host", "codex");
      return url;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL);
    }
  }

  function resolveChannelBridgeUrl() {
    const configured = typeof window.__CODEX_IM_GATEWAY_URL__ === "string"
      ? window.__CODEX_IM_GATEWAY_URL__.trim()
      : typeof window.__CODEX_CHANNEL_BRIDGE_URL__ === "string"
        ? window.__CODEX_CHANNEL_BRIDGE_URL__.trim()
        : "";
    try {
      const url = new URL(configured || DEFAULT_CHANNEL_BRIDGE_URL);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:")
        || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      ) {
        throw new Error("Unsupported Codex IM Gateway URL");
      }
      return url;
    } catch (_) {
      return new URL(DEFAULT_CHANNEL_BRIDGE_URL);
    }
  }

  function resolveSub2apiUrl() {
    return new URL(DEFAULT_SUB2API_URL);
  }

  function resolveCapabilityApiUrl() {
    return new URL("/api/channel-capabilities", resolveChannelBridgeUrl());
  }

  function capabilityView(id) {
    return `${CAPABILITY_VIEW_PREFIX}${id}`;
  }

  function activeCapability() {
    if (!activeView?.startsWith?.(CAPABILITY_VIEW_PREFIX)) return null;
    const id = activeView.slice(CAPABILITY_VIEW_PREFIX.length);
    return capabilityNavigation.find((candidate) => candidate.id === id) || null;
  }

  function normalizeCapabilityNavigation(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.navigation)) return [];
    const result = [];
    const ids = new Set();
    for (const value of payload.navigation) {
      if (!value || typeof value !== "object") continue;
      const { id, label, ariaLabel, url, order, icon, allowClipboard } = value;
      if (
        typeof id !== "string"
        || !/^[a-z][a-z0-9-]{0,63}$/.test(id)
        || ids.has(id)
        || typeof label !== "string"
        || !label.trim()
        || label.length > 32
        || typeof ariaLabel !== "string"
        || !ariaLabel.trim()
        || ariaLabel.length > 80
        || typeof url !== "string"
        || typeof order !== "number"
        || !Number.isInteger(order)
        || !["document", "database", "generic"].includes(icon)
        || (allowClipboard !== undefined && typeof allowClipboard !== "boolean")
      ) continue;
      try {
        const parsedUrl = new URL(url);
        if (
          !["http:", "https:"].includes(parsedUrl.protocol)
          || !["127.0.0.1", "localhost"].includes(parsedUrl.hostname)
          || parsedUrl.username
          || parsedUrl.password
        ) continue;
        ids.add(id);
        result.push({
          id,
          label: label.trim(),
          ariaLabel: ariaLabel.trim(),
          url: parsedUrl.href,
          order,
          icon,
          allowClipboard: allowClipboard === true,
        });
      } catch (_) {}
    }
    return result.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  async function refreshCapabilityNavigation() {
    const generation = ++capabilityRequestGeneration;
    try {
      const response = await window.fetch(resolveCapabilityApiUrl(), {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Capability API returned ${response.status}`);
      const nextNavigation = normalizeCapabilityNavigation(await response.json());
      if (destroyed || generation !== capabilityRequestGeneration) return;
      if (JSON.stringify(nextNavigation) === JSON.stringify(capabilityNavigation)) return;
      const activeId = activeCapability()?.id || null;
      capabilityEntries.forEach((button) => button.remove());
      capabilityEntries.clear();
      capabilityNavigation = nextNavigation;
      ensureEntry();
      if (activeId && !capabilityNavigation.some((candidate) => candidate.id === activeId)) {
        openTaskboard();
      } else if (activeId) {
        openCapability(activeId);
      }
    } catch (_) {
      // A transient local-service failure must not disturb existing navigation.
    }
  }

  function scheduleCapabilityRefresh() {
    if (destroyed) return;
    if (capabilityRefreshTimer !== null) window.clearTimeout(capabilityRefreshTimer);
    capabilityRefreshTimer = window.setTimeout(() => {
      capabilityRefreshTimer = null;
      refreshCapabilityNavigation().finally(scheduleCapabilityRefresh);
    }, CAPABILITY_REFRESH_MS);
  }

  function isTrustedTaskboardOrigin(origin) {
    try {
      return new URL(origin).origin === resolveTaskboardUrl().origin;
    } catch (_) {
      return false;
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_ATTRIBUTE, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"],
      #${SUB2API_ENTRY_ID}[aria-current="page"],
      [${CAPABILITY_ENTRY_ATTRIBUTE}="true"][aria-current="page"],
      #${CHANNEL_ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible,
      #${SUB2API_ENTRY_ID}:focus-visible,
      [${CAPABILITY_ENTRY_ATTRIBUTE}="true"]:focus-visible,
      #${CHANNEL_ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-border, Highlight);
        outline-offset: 2px;
      }
      [${HOST_ATTRIBUTE}="true"] {
        position: relative !important;
        z-index: 31 !important;
        pointer-events: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] {
        background-color: transparent !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] [class*="text-token-list-active-selection"] {
        color: var(--color-token-foreground, inherit) !important;
      }
      #${PAGE_ID} {
        position: absolute;
        top: var(--codex-taskboard-top-offset, 46px);
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 1;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: Canvas;
        color: CanvasText;
        pointer-events: auto;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
      #${FRAME_ID}[hidden] {
        display: none !important;
      }
      #${DRAG_REGION_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: drag;
      }
      #${NO_DRAG_LEFT_ID},
      #${NO_DRAG_RIGHT_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: no-drag;
      }
      #${DRAG_REGION_ID}[hidden],
      #${NO_DRAG_LEFT_ID}[hidden],
      #${NO_DRAG_RIGHT_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--color-token-text-secondary, color-mix(in srgb, CanvasText 60%, transparent));
        font: 13px/1.5 system-ui, sans-serif;
        text-align: center;
      }
      #${STATUS_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} button {
        margin-top: 10px;
        border: 1px solid var(--color-token-border, color-mix(in srgb, CanvasText 16%, transparent));
        border-radius: 7px;
        padding: 5px 10px;
        background: var(--color-token-main-surface-secondary, Canvas);
        color: var(--color-token-foreground, CanvasText);
        cursor: pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonMatches(button, labels) {
    if (!button) return false;
    const text = normalizedLabel(button.textContent || button.getAttribute("aria-label"));
    return labels.includes(text);
  }

  function findReferenceButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = Array.from(scroll.querySelectorAll("button"));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin?.parentElement) return plugin;

    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = Array.from(scroll.querySelectorAll("div")).filter((element) => {
      const directButtons = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    });
    const group = groups.sort((left, right) => right.children.length - left.children.length)[0];
    return Array.from(group?.children || []).filter((child) => child.tagName === "BUTTON").at(-1) || null;
  }

  function replaceEntryIcon(button, kind) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    if (kind === "taskboard") {
      icon.innerHTML = `
        <rect x="3.5" y="4" width="17" height="16" rx="2.5"></rect>
        <path d="M9 4v16M14.5 8h2.5M14.5 12h2.5M14.5 16h2.5"></path>
      `;
      return;
    }
    if (kind === "document") {
      icon.innerHTML = `
        <path d="M6 3.5h8l4 4v13H6z"></path>
        <path d="M14 3.5v4h4M9 12h6M9 15.5h6"></path>
      `;
      return;
    }
    if (kind === "database") {
      icon.innerHTML = `
        <ellipse cx="12" cy="5.5" rx="7.5" ry="3"></ellipse>
        <path d="M4.5 5.5v6c0 1.65 3.36 3 7.5 3s7.5-1.35 7.5-3v-6"></path>
        <path d="M4.5 11.5v6c0 1.65 3.36 3 7.5 3s7.5-1.35 7.5-3v-6"></path>
      `;
      return;
    }
    if (kind === "sub2api") {
      icon.innerHTML = `
        <ellipse cx="12" cy="5.5" rx="7.5" ry="3"></ellipse>
        <path d="M4.5 5.5v6c0 1.65 3.36 3 7.5 3s7.5-1.35 7.5-3v-6"></path>
        <path d="M4.5 11.5v6c0 1.65 3.36 3 7.5 3s7.5-1.35 7.5-3v-6"></path>
      `;
      return;
    }
    icon.innerHTML = `
        <path d="M12 3.5a2.2 2.2 0 0 1 2.1 1.55l.23.75a7 7 0 0 1 1.18.68l.77-.18a2.2 2.2 0 0 1 2.45 1.16l.8 1.38a2.2 2.2 0 0 1-.35 2.68l-.55.57c.03.22.04.45.04.68 0 .23-.01.46-.04.68l.55.57a2.2 2.2 0 0 1 .35 2.68l-.8 1.38a2.2 2.2 0 0 1-2.45 1.16l-.77-.18a7 7 0 0 1-1.18.68l-.23.75A2.2 2.2 0 0 1 12 21.5h-1.6a2.2 2.2 0 0 1-2.1-1.55l-.23-.75a7 7 0 0 1-1.18-.68l-.77.18a2.2 2.2 0 0 1-2.45-1.16l-.8-1.38a2.2 2.2 0 0 1 .35-2.68l.55-.57a5 5 0 0 1 0-1.36l-.55-.57a2.2 2.2 0 0 1-.35-2.68l.8-1.38A2.2 2.2 0 0 1 6.12 6.3l.77.18a7 7 0 0 1 1.18-.68l.23-.75a2.2 2.2 0 0 1 2.1-1.55H12Z"></path>
        <circle cx="11.2" cy="12.5" r="2.7"></circle>
      `;
  }

  function createEntry(reference, { id, labelText, ariaLabel, iconKind, onClick }) {
    const button = reference.cloneNode(true);
    button.id = id;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.setAttribute("aria-label", ariaLabel);
    button.setAttribute("title", labelText);
    button.setAttribute(OWNED_ATTRIBUTE, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    const label = button.querySelector(".text-fade-truncate")
      || Array.from(button.querySelectorAll("span")).find((node) => buttonMatches(node, PLUGIN_LABELS));
    if (label) label.textContent = labelText;
    else button.textContent = labelText;
    replaceEntryIcon(button, iconKind);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function syncEntryState() {
    if (!entry || !sub2apiEntry || !channelEntry) return;
    const taskboardActive = active && activeView === TASKBOARD_VIEW;
    const sub2apiActive = active && activeView === SUB2API_VIEW;
    const channelActive = active && activeView === CHANNEL_VIEW;
    if (taskboardActive) entry.setAttribute("aria-current", "page");
    else entry.removeAttribute("aria-current");
    if (sub2apiActive) sub2apiEntry.setAttribute("aria-current", "page");
    else sub2apiEntry.removeAttribute("aria-current");
    capabilityEntries.forEach((button, id) => {
      if (active && activeView === capabilityView(id)) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (channelActive) channelEntry.setAttribute("aria-current", "page");
    else channelEntry.removeAttribute("aria-current");
    activeIntegrationEntry()?.scrollIntoView({ block: "nearest" });
  }

  function activeIntegrationEntry() {
    if (!active) return null;
    if (activeView === TASKBOARD_VIEW) return entry;
    if (activeView === SUB2API_VIEW) return sub2apiEntry;
    if (activeView === CHANNEL_VIEW) return channelEntry;
    for (const [id, button] of capabilityEntries) {
      if (activeView === capabilityView(id)) return button;
    }
    return null;
  }

  function isIntegrationEntry(node) {
    return node === entry
      || node === sub2apiEntry
      || node === channelEntry
      || capabilityEntriesHasNode(node)
      || Boolean(node?.closest?.(`#${ENTRY_ID}, #${SUB2API_ENTRY_ID}, #${CHANNEL_ENTRY_ID}, [${CAPABILITY_ENTRY_ATTRIBUTE}="true"]`));
  }

  function capabilityEntriesHasNode(node) {
    for (const button of capabilityEntries.values()) {
      if (button === node) return true;
    }
    return false;
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) return;
    if (!entry) {
      entry = createEntry(reference, {
        id: ENTRY_ID,
        labelText: "任务面板",
        ariaLabel: "切换到任务面板",
        iconKind: "taskboard",
        onClick: openTaskboard,
      });
    }
    if (!channelEntry) {
      channelEntry = createEntry(reference, {
        id: CHANNEL_ENTRY_ID,
        labelText: "渠道配置",
        ariaLabel: "切换到渠道配置",
        iconKind: "channel",
        onClick: openChannelConfig,
      });
    }
    if (!sub2apiEntry) {
      sub2apiEntry = createEntry(reference, {
        id: SUB2API_ENTRY_ID,
        labelText: "Sub2API",
        ariaLabel: "切换到 Sub2API",
        iconKind: "sub2api",
        onClick: openSub2api,
      });
    }
    if (
      sub2apiEntry.parentElement !== reference.parentElement
      || sub2apiEntry.previousElementSibling !== reference
    ) {
      reference.after(sub2apiEntry);
    }
    let previousEntry = sub2apiEntry;
    for (const capability of capabilityNavigation) {
      let capabilityEntry = capabilityEntries.get(capability.id);
      if (!capabilityEntry) {
        capabilityEntry = createEntry(reference, {
          id: `${CAPABILITY_ENTRY_PREFIX}${capability.id}`,
          labelText: capability.label,
          ariaLabel: capability.ariaLabel,
          iconKind: capability.icon,
          onClick: () => openCapability(capability.id),
        });
        capabilityEntry.setAttribute(CAPABILITY_ENTRY_ATTRIBUTE, "true");
        capabilityEntries.set(capability.id, capabilityEntry);
      }
      if (
        capabilityEntry.parentElement !== reference.parentElement
        || capabilityEntry.previousElementSibling !== previousEntry
      ) previousEntry.after(capabilityEntry);
      previousEntry = capabilityEntry;
    }
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== previousEntry) {
      previousEntry.after(entry);
    }
    if (
      channelEntry.parentElement !== reference.parentElement
      || channelEntry.previousElementSibling !== entry
    ) {
      entry.after(channelEntry);
    }
    syncEntryState();
  }

  function findPageHost() {
    const direct = document.querySelector(".app-shell-main-content-frame");
    if (direct?.closest?.("[data-app-shell-main-content-layout]")) return direct;

    const viewport = document.querySelector("[data-app-shell-main-content-layout]");
    if (!viewport) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const headerBottom = document.querySelector("main > header")?.getBoundingClientRect().bottom
      ?? viewportRect.top;
    return Array.from(viewport.children).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width >= viewportRect.width * 0.8
        && rect.height >= viewportRect.height * 0.7
        && rect.top >= headerBottom - 1;
    }) || null;
  }

  function findPageMount() {
    const frameHost = findPageHost();
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]");
    const surface = viewport?.parentElement;
    if (!frameHost || !viewport || !surface || !surface.closest("main")) return null;
    return { frameHost, surface };
  }

  function pageTopOffset(surface) {
    const header = document.querySelector("main > header");
    const headerRect = header?.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    if (!headerRect || !Number.isFinite(headerRect.bottom) || !Number.isFinite(surfaceRect.top)) {
      return 46;
    }
    return Math.max(0, Math.ceil(headerRect.bottom - surfaceRect.top));
  }

  function muteNativeSelection() {
    if (!active) return;
    document.querySelectorAll('aside nav[role="navigation"] [aria-current]')
      .forEach((node) => {
        if (isIntegrationEntry(node)) return;
        if (!mutedNativeSelections.has(node)) {
          mutedNativeSelections.set(node, node.getAttribute("aria-current"));
        }
        node.removeAttribute("aria-current");
        node.setAttribute(NATIVE_SELECTED_ATTRIBUTE, "true");
      });
  }

  function restoreNativeSelection() {
    mutedNativeSelections.forEach((ariaCurrent, node) => {
      if (!node.isConnected) return;
      node.setAttribute("aria-current", ariaCurrent);
      node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE);
    });
    mutedNativeSelections.clear();
    document.querySelectorAll(`[${NATIVE_SELECTED_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE));
  }

  function hideNativeHeader() {
    document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]')
      .forEach((surface) => {
        Array.from(surface.children).forEach((child) => {
          if (child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
            child.setAttribute(HIDDEN_ATTRIBUTE, "true");
          }
        });
      });
  }

  function currentTheme() {
    const root = document.documentElement;
    const explicit = String(root.dataset.theme || root.getAttribute("data-color-theme") || "").toLowerCase();
    if (explicit.includes("dark") || root.classList.contains("dark")) return "dark";
    if (explicit.includes("light") || root.classList.contains("light")) return "light";
    try {
      return window.getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function threadIdFromLocation() {
    const source = `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function activeThreadRow() {
    const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
    return rows.find((row) => row.getAttribute("data-app-action-sidebar-thread-active") === "true")
      || rows.find((row) => ["page", "true"].includes(row.getAttribute("aria-current")))
      || null;
  }

  function readCodexProjects() {
    const seen = new Set();
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .flatMap((row) => {
        const id = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
        const name = (
          row.getAttribute("data-app-action-sidebar-project-label")
          || row.getAttribute("aria-label")
          || ""
        ).trim();
        if (!id || !name || seen.has(id)) return [];
        seen.add(id);
        return [{ id, name }];
      });
  }

  function findProjectsSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section-heading]"))
      .find((node) => PROJECT_SECTION_LABELS.includes(normalizedLabel(
        node.getAttribute("data-app-action-sidebar-section-heading") || node.textContent,
      )))
      ?.closest("[data-app-action-sidebar-section]") || null;
  }

  function findTasksSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section]"))
      .find((section) => {
        const heading = section.querySelector("[data-app-action-sidebar-section-heading]");
        const label = heading?.getAttribute("data-app-action-sidebar-section-heading")
          || heading?.textContent
          || section.textContent;
        return TASK_SECTION_LABELS.includes(normalizedLabel(label));
      }) || null;
  }

  async function captureHostContext() {
    let projects = readCodexProjects();
    let section = findProjectsSection();
    const sectionDeadline = Date.now() + 1_200;
    while (!section && Date.now() < sectionDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    const tasksSection = findTasksSection();
    const expandedSections = [section, tasksSection].filter((candidate) => (
      candidate?.getAttribute("data-app-action-sidebar-section-collapsed") === "true"
    ));
    expandedSections.forEach((candidate) => (
      candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click()
    ));
    if (expandedSections.length > 0) {
      const deadline = Date.now() + 1_200;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        projects = readCodexProjects();
      } while ((projects.length === 0 || !activeThreadRow()) && Date.now() < deadline);
    }
    const context = readHostContext(projects);
    expandedSections.forEach((candidate) => {
      if (candidate.isConnected && candidate.getAttribute("data-app-action-sidebar-section-collapsed") === "false") {
        candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
      }
    });
    return context;
  }

  function workspaceFromLocation() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("workspace") || url.searchParams.get("cwd") || "";
    } catch (_) {
      return "";
    }
  }

  function titlebarLeftInset() {
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return 0;
    if (nativeSidebarCollapsed()) return MACOS_TITLEBAR_SAFE_LEFT;
    const surfaceLeft = findPageMount()?.surface.getBoundingClientRect().left;
    if (!Number.isFinite(surfaceLeft)) return 0;
    return Math.max(0, Math.ceil(MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft));
  }

  function nativeSidebarTrigger() {
    const triggers = Array.from(
      document.querySelectorAll('[data-app-shell-sidebar-trigger="true"]'),
    );
    return triggers.find((trigger) => getComputedStyle(trigger).visibility !== "hidden")
      || triggers[0]
      || null;
  }

  function nativeSidebarCollapsed() {
    const label = normalizedLabel(nativeSidebarTrigger()?.getAttribute("aria-label"));
    return label.startsWith("显示") || label.startsWith("show ");
  }

  function expandNativeSidebar() {
    const trigger = nativeSidebarTrigger();
    if (!trigger || !nativeSidebarCollapsed()) return;
    trigger.click();
    window.setTimeout(postHostContext, REATTACH_DELAY_MS);
  }

  function userIdFromName(name) {
    const slug = name.normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96);
    if (slug) return slug;
    let hash = 2166136261;
    for (const character of name) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `codex-user-${(hash >>> 0).toString(36)}`;
  }

  function readCodexUser() {
    const avatar = Array.from(document.querySelectorAll("img"))
      .find((image) => image.src.includes("cdn.auth0.com/avatars/"));
    const profileButton = avatar?.closest("button")
      || Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((button) => (
        normalizedLabel(button.getAttribute("aria-label")).includes("profile")
        || normalizedLabel(button.getAttribute("aria-label")).includes("个人资料")
      ));
    const name = profileButton?.textContent?.replace(/\s+/g, " ").trim();
    if (!name) return null;
    const avatarUrl = avatar?.currentSrc || avatar?.src || null;
    return {
      type: "user",
      id: userIdFromName(name),
      name,
      avatarUrl,
    };
  }

  function readHostContext(projects = readCodexProjects()) {
    const row = activeThreadRow();
    const activeThreadId = normalizeThreadId(row?.getAttribute("data-app-action-sidebar-thread-id"));
    if (activeThreadId) lastNativeThreadId = activeThreadId;
    const threadId = activeThreadId || lastNativeThreadId || normalizeThreadId(threadIdFromLocation());
    const projectList = row?.closest?.("[data-app-action-sidebar-project-list-id]");
    const projectRow = row?.closest?.("[data-app-action-sidebar-project-id]")
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]')
      || document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]');
    const projectId = projectList?.getAttribute("data-app-action-sidebar-project-list-id")
      || projectRow?.getAttribute("data-app-action-sidebar-project-id")
      || "";
    const workspacePath = workspaceFromLocation();
    const payload = {
      theme: currentTheme(),
      projects,
      user: readCodexUser() ?? undefined,
      titlebarLeftInset: titlebarLeftInset(),
      sidebarCollapsed: nativeSidebarCollapsed(),
    };
    if (workspacePath) payload.workspacePath = workspacePath;
    if (projectId) payload.projectId = projectId;
    if (threadId) payload.threadId = threadId;
    return payload;
  }

  function postToFrame(message) {
    if (!frame?.contentWindow || !frameOrigin) return;
    frame.contentWindow.postMessage(message, frameOrigin);
  }

  function dispatchHostMessage(message) {
    window.postMessage(message, window.location.origin);
  }

  function postHostContext() {
    if (!frame || activeView !== TASKBOARD_VIEW) return;
    const liveContext = readHostContext();
    const payload = hostContextSnapshot
      ? {
          ...hostContextSnapshot,
          ...liveContext,
          projects: liveContext.projects.length > 0
            ? liveContext.projects
            : hostContextSnapshot.projects,
        }
      : liveContext;
    postToFrame({ type: "taskboard:host-context", payload });
    postToFrame({ type: "taskboard:theme", theme: payload.theme });
  }

  function findThreadRow(threadId) {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")) === normalizeThreadId(threadId)) || null;
  }

  function routeForThread(threadId) {
    return `/local/${encodeURIComponent(threadId)}`;
  }

  async function openThread(threadId) {
    if (typeof threadId !== "string" || !threadId.trim()) return;
    const normalizedThreadId = normalizeThreadId(threadId);
    lastNativeThreadId = normalizedThreadId;
    const row = findThreadRow(normalizedThreadId);
    closeTaskboard(false);

    if (row?.isConnected) {
      row.click?.();
      return;
    }

    try {
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: routeForThread(normalizedThreadId),
      });
    } catch (_) {}
  }

  function projectRowById(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => row.getAttribute("data-app-action-sidebar-project-id") === projectId.trim()) || null;
  }

  function projectRowByLabel(label) {
    if (typeof label !== "string" || !label.trim()) return null;
    const expected = normalizedLabel(label);
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => normalizedLabel(row.getAttribute("data-app-action-sidebar-project-label")) === expected) || null;
  }

  async function ensureProjectRows() {
    let section = findProjectsSection();
    const deadline = Date.now() + 1_200;
    while (!section && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    if (section?.getAttribute("data-app-action-sidebar-section-collapsed") === "true") {
      section.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
    }
    while (readCodexProjects().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  async function waitForPreparedComposer(identifier, skillPath) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const editor = document.querySelector('[data-codex-composer="true"][contenteditable="true"]');
      if (editor && editor.getClientRects().length > 0) {
        const containsIdentifier = normalizedLabel(editor.textContent).includes(normalizedLabel(identifier));
        const skillMention = Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((mention) => (
            mention.getAttribute("skill-mention-name") === "manage-taskboard"
            && mention.getAttribute("skill-mention-path") === skillPath
          ));
        if (containsIdentifier && skillMention) return editor;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error("Codex 对话输入框没有生成 manage-taskboard Skill 引用");
  }

  async function createThreadForTask(payload) {
    const taskId = typeof payload?.taskId === "string" ? payload.taskId.trim() : "";
    const identifier = typeof payload?.identifier === "string" ? payload.identifier.trim() : "";
    const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
    const skillName = typeof payload?.skillName === "string" ? payload.skillName.trim() : "";
    const skillDisplayName = typeof payload?.skillDisplayName === "string"
      ? payload.skillDisplayName.trim()
      : "";
    const skillPath = typeof payload?.skillPath === "string" ? payload.skillPath.trim() : "";
    const workspacePath = typeof payload?.workspacePath === "string"
      ? payload.workspacePath.trim()
      : "";
    if (
      !taskId
      || !identifier
      || !instruction
      || !skillName
      || !skillDisplayName
      || !skillPath
      || pendingThreadCreation
    ) return;
    pendingThreadCreation = taskId;
    try {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        throw new Error("当前 Codex 版本没有提供原生对话导航能力");
      }

      if (workspacePath) {
        await bridge.sendMessageFromView({
          type: "electron-set-active-workspace-root",
          root: workspacePath,
        });
      } else {
        await ensureProjectRows();
        const snapshotProjectId = hostContextSnapshot?.projectId || "";
        const requestedProjectId = typeof payload.codexProjectId === "string"
          ? payload.codexProjectId.trim()
          : "";
        const row = projectRowByLabel(payload.workspaceLabel)
          || projectRowById(requestedProjectId)
          || projectRowById(snapshotProjectId)
          || projectRowByLabel(payload.projectName);
        if (row?.getAttribute("data-app-action-sidebar-project-collapsed") === "true") {
          row.click?.();
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
        const selectProject = row?.querySelector("[data-app-action-sidebar-select-project]");
        selectProject?.click?.();
        if (selectProject) await new Promise((resolve) => window.setTimeout(resolve, 120));
      }

      closeTaskboard(false);
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: "/",
        state: {
          focusComposerNonce: Date.now(),
        },
      });
      await requestHostTaskComposerPrefill({
        instruction,
        skillDisplayName,
        skillName,
        skillPath,
      });
      await waitForPreparedComposer(identifier, skillPath);
      postToFrame({ type: "taskboard:thread-prepared", payload: { taskId } });
    } catch (error) {
      postToFrame({
        type: "taskboard:thread-create-error",
        payload: { taskId, error: error instanceof Error ? error.message : "无法创建 Codex 对话" },
      });
    } finally {
      pendingThreadCreation = null;
    }
  }

  function buildAutomationHostPayload(payload) {
    return {
      requestId: payload.requestId,
      operation: payload.operation,
      taskboardProjectId: payload.taskboardProjectId,
      codexProjectId: payload.codexProjectId,
      projectName: payload.projectName,
      workspacePath: payload.workspacePath,
      skillPath: payload.skillPath,
      enabledByUser: payload.enabledByUser,
      quotaAware: payload.quotaAware,
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
    };
  }

  async function handleAutomationRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    if (activeView !== TASKBOARD_VIEW || !isTrustedTaskboardOrigin(frameOrigin)) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: { requestId, ok: false, error: "仅本地任务面板可用" },
      });
      return;
    }
    try {
      const response = await requestHost(
        "automation",
        buildAutomationHostPayload(payload),
      );
      postToFrame({
        type: "taskboard:automation-response",
        payload: response.error
          ? { requestId, ok: false, error: response.error }
          : {
              requestId,
              ok: true,
              item: response.item,
              items: response.items,
              quota: response.quota,
              policy: response.policy,
            },
      });
    } catch (error) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : "Codex 自动任务操作失败",
        },
      });
    }
  }

  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const taskboardUrl = resolveTaskboardUrl();
    if (
      !active
      || activeView !== TASKBOARD_VIEW
      || event.origin !== taskboardUrl.origin
      || !frameMatchesTaskboardUrl(taskboardUrl)
    ) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "taskboard:ready") {
      frameReady = true;
      frameReadyWaiters.forEach(({ resolve, timer }) => {
        window.clearTimeout(timer);
        resolve();
      });
      frameReadyWaiters.clear();
      if (active && activeView === TASKBOARD_VIEW) showFrame();
      postHostContext();
      return;
    }
    if (message.type === "taskboard:drag-region") {
      updateDragRegion(message.payload);
      return;
    }
    if (message.type === "taskboard:open-thread") {
      void openThread(message.payload?.threadId);
      return;
    }
    if (message.type === "taskboard:expand-sidebar") {
      expandNativeSidebar();
      return;
    }
    if (message.type === "taskboard:automation-request") {
      void handleAutomationRequest(message.payload);
      return;
    }
    if (message.type === "taskboard:create-thread") void createThreadForTask(message.payload);
  }

  function updateDragRegion(payload) {
    if (!dragRegion || !noDragLeft || !noDragRight) return;
    const [x, y, width, height] = [payload?.x, payload?.y, payload?.width, payload?.height];
    if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
      dragRegion.hidden = true;
      noDragLeft.hidden = true;
      noDragRight.hidden = true;
      return;
    }
    const left = Math.max(0, x);
    const right = left + width;
    dragRegion.style.left = `${left}px`;
    dragRegion.style.top = `${Math.max(0, y)}px`;
    dragRegion.style.width = `${width}px`;
    dragRegion.style.height = `${height}px`;
    noDragLeft.style.left = "0";
    noDragLeft.style.top = `${Math.max(0, y)}px`;
    noDragLeft.style.width = `${left}px`;
    noDragLeft.style.height = `${height}px`;
    noDragRight.style.left = `${right}px`;
    noDragRight.style.top = `${Math.max(0, y)}px`;
    noDragRight.style.right = "0";
    noDragRight.style.height = `${height}px`;
    dragRegion.hidden = false;
    noDragLeft.hidden = left <= 0;
    noDragRight.hidden = right >= page.clientWidth;
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED_ATTRIBUTE, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "任务面板");

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    dragRegion = document.createElement("div");
    dragRegion.id = DRAG_REGION_ID;
    dragRegion.hidden = true;
    dragRegion.setAttribute(OWNED_ATTRIBUTE, "true");
    dragRegion.setAttribute("aria-hidden", "true");
    section.appendChild(dragRegion);

    noDragLeft = document.createElement("div");
    noDragLeft.id = NO_DRAG_LEFT_ID;
    noDragLeft.hidden = true;
    noDragLeft.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragLeft.setAttribute("aria-hidden", "true");
    section.appendChild(noDragLeft);

    noDragRight = document.createElement("div");
    noDragRight.id = NO_DRAG_RIGHT_ID;
    noDragRight.hidden = true;
    noDragRight.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragRight.setAttribute("aria-hidden", "true");
    section.appendChild(noDragRight);
    return section;
  }

  function showLoading(message = "正在启动任务面板…") {
    if (!status) return;
    status.replaceChildren(document.createTextNode(message));
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function showFrame() {
    if (status) status.hidden = true;
    if (frame) {
      frame.hidden = false;
      frame.focus?.();
    }
  }

  function showLoadError(message, retryAction = openTaskboard) {
    if (!status) return;
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新启动";
    retry.addEventListener("click", retryAction, { once: true });
    content.append(text, retry);
    status.replaceChildren(content);
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function cancelFrameReadyWaiters(error) {
    frameReadyWaiters.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(error);
    });
    frameReadyWaiters.clear();
  }

  function waitForFrameReady() {
    if (frameReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: window.setTimeout(() => {
          frameReadyWaiters.delete(waiter);
          reject(new Error("任务面板页面加载超时"));
        }, FRAME_READY_TIMEOUT_MS),
      };
      frameReadyWaiters.add(waiter);
    });
  }

  function loadTaskboardFrame(cacheBust = false) {
    cancelFrameReadyWaiters(new Error("任务面板正在重新加载"));
    frame?.remove();
    frame = null;
    frameReady = false;
    if (dragRegion) dragRegion.hidden = true;
    if (noDragLeft) noDragLeft.hidden = true;
    if (noDragRight) noDragRight.hidden = true;

    const taskboardUrl = resolveTaskboardUrl();
    if (cacheBust) {
      taskboardUrl.searchParams.set(FRAME_REFRESH_PARAM, Date.now().toString(36));
    }
    frameOrigin = taskboardUrl.origin;
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.hidden = true;
    nextFrame.src = taskboardUrl.href;
    nextFrame.title = "任务面板";
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    nextFrame.addEventListener("load", postHostContext);
    frame = nextFrame;
    page.appendChild(nextFrame);
  }

  function frameMatchesChannelBridgeUrl(channelUrl) {
    if (!frame) return false;
    try {
      const loadedUrl = new URL(frame.getAttribute("src") || frame.src);
      loadedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      const expectedUrl = new URL(channelUrl.href);
      expectedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      return loadedUrl.href === expectedUrl.href;
    } catch (_) {
      return false;
    }
  }

  function frameMatchesCapabilityUrl(capabilityUrl) {
    if (!frame) return false;
    try {
      const loadedUrl = new URL(frame.getAttribute("src") || frame.src);
      loadedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      const expectedUrl = new URL(capabilityUrl.href);
      expectedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      return loadedUrl.href === expectedUrl.href;
    } catch (_) {
      return false;
    }
  }

  function frameMatchesSub2apiUrl(sub2apiUrl) {
    if (!frame) return false;
    try {
      const loadedUrl = new URL(frame.getAttribute("src") || frame.src);
      loadedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      const expectedUrl = new URL(sub2apiUrl.href);
      expectedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      return loadedUrl.href === expectedUrl.href;
    } catch (_) {
      return false;
    }
  }

  function loadSub2apiFrame(generation, cacheBust = false) {
    cancelFrameReadyWaiters(new Error("Sub2API 正在重新加载"));
    frame?.remove();
    frame = null;
    frameReady = false;
    updateDragRegion(null);

    const sub2apiUrl = resolveSub2apiUrl();
    if (cacheBust) {
      sub2apiUrl.searchParams.set(FRAME_REFRESH_PARAM, Date.now().toString(36));
    }
    frameOrigin = sub2apiUrl.origin;
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.hidden = true;
    nextFrame.src = sub2apiUrl.href;
    nextFrame.title = "Sub2API";
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    nextFrame.addEventListener("load", () => {
      if (
        frame !== nextFrame
        || !active
        || activeView !== SUB2API_VIEW
        || generation !== openGeneration
      ) return;
      frameReady = true;
      showFrame();
    }, { once: true });
    frame = nextFrame;
    page.appendChild(nextFrame);
  }

  function loadCapabilityFrame(generation, capability, cacheBust = false) {
    cancelFrameReadyWaiters(new Error(`${capability.label} 正在重新加载`));
    frame?.remove();
    frame = null;
    frameReady = false;
    updateDragRegion(null);

    const capabilityUrl = new URL(capability.url);
    if (cacheBust) {
      capabilityUrl.searchParams.set(FRAME_REFRESH_PARAM, Date.now().toString(36));
    }
    frameOrigin = capabilityUrl.origin;
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.hidden = true;
    nextFrame.src = capabilityUrl.href;
    nextFrame.title = capability.label;
    nextFrame.referrerPolicy = "no-referrer";
    if (capability.allowClipboard) {
      nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    }
    nextFrame.addEventListener("load", () => {
      if (
        frame !== nextFrame
        || !active
        || activeView !== capabilityView(capability.id)
        || generation !== openGeneration
      ) return;
      frameReady = true;
      showFrame();
    }, { once: true });
    frame = nextFrame;
    page.appendChild(nextFrame);
  }

  function loadChannelBridgeFrame(generation, cacheBust = false) {
    cancelFrameReadyWaiters(new Error("渠道配置正在重新加载"));
    frame?.remove();
    frame = null;
    frameReady = false;
    if (dragRegion) dragRegion.hidden = true;
    if (noDragLeft) noDragLeft.hidden = true;
    if (noDragRight) noDragRight.hidden = true;

    const channelUrl = resolveChannelBridgeUrl();
    if (cacheBust) {
      channelUrl.searchParams.set(FRAME_REFRESH_PARAM, Date.now().toString(36));
    }
    frameOrigin = channelUrl.origin;
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.hidden = true;
    nextFrame.src = channelUrl.href;
    nextFrame.title = "渠道配置";
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.addEventListener("load", () => {
      if (
        frame !== nextFrame
        || !active
        || activeView !== CHANNEL_VIEW
        || generation !== openGeneration
      ) return;
      frameReady = true;
      showFrame();
    }, { once: true });
    frame = nextFrame;
    page.appendChild(nextFrame);
  }

  function reloadFrame() {
    if (!frame) return false;
    const generation = ++openGeneration;
    if (activeView === SUB2API_VIEW) {
      showLoading("正在打开 Sub2API…");
      loadSub2apiFrame(generation, true);
      return true;
    }
    const capability = activeCapability();
    if (capability) {
      showLoading(`正在打开 ${capability.label}…`);
      loadCapabilityFrame(generation, capability, true);
      return true;
    }
    if (activeView === CHANNEL_VIEW) {
      showLoading("正在启动渠道配置…");
      loadChannelBridgeFrame(generation, true);
      return true;
    }
    if (active) showLoading();
    loadTaskboardFrame(true);
    if (active) {
      waitForFrameReady()
        .then(() => {
          if (!active || activeView !== TASKBOARD_VIEW || generation !== openGeneration) return;
          showFrame();
          postHostContext();
        })
        .catch((error) => {
          if (!active || activeView !== TASKBOARD_VIEW || generation !== openGeneration) return;
          showLoadError(error.message);
        });
    }
    return true;
  }

  function managedTaskboardOrigin() {
    const configured = typeof window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ === "string"
      ? window.__CODEX_TASKBOARD_MANAGED_ORIGIN__.trim()
      : "";
    try {
      return new URL(configured || DEFAULT_TASKBOARD_URL).origin;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL).origin;
    }
  }

  function hasLiveHostBinding() {
    const heartbeat = Number(window[HOST_HEARTBEAT_NAME]);
    return typeof window[HOST_BINDING_NAME] === "function"
      && Number.isFinite(heartbeat)
      && Date.now() - heartbeat <= HOST_HEARTBEAT_MAX_AGE_MS;
  }

  function requestHost(action, payload = {}) {
    const binding = window[HOST_BINDING_NAME];
    if (!hasLiveHostBinding()) {
      return Promise.reject(new Error("Taskboard 启动器未运行，无法操作 Codex 对话输入框"));
    }

    const id = `${Date.now().toString(36)}-${(++hostRequestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        hostRequests.delete(id);
        reject(new Error("任务面板启动器没有响应"));
      }, HOST_REQUEST_TIMEOUT_MS);
      hostRequests.set(id, { resolve, reject, timeout });
      try {
        binding(JSON.stringify({ ...payload, id, action }));
      } catch (error) {
        window.clearTimeout(timeout);
        hostRequests.delete(id);
        reject(error);
      }
    });
  }

  function requestHostEnsure(taskboardUrl) {
    if (taskboardUrl.origin !== managedTaskboardOrigin() || !hasLiveHostBinding()) {
      return Promise.resolve({ managed: false, restarted: false });
    }
    return requestHost("ensure");
  }

  function requestHostTaskComposerPrefill({
    instruction,
    skillDisplayName,
    skillName,
    skillPath,
  }) {
    return requestHost("prefill-task-composer", {
      instruction,
      skillDisplayName,
      skillName,
      skillPath,
    });
  }

  function frameMatchesTaskboardUrl(taskboardUrl) {
    if (!frame) return false;
    try {
      const loadedUrl = new URL(frame.getAttribute("src") || frame.src);
      loadedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      const expectedUrl = new URL(taskboardUrl.href);
      expectedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      return loadedUrl.href === expectedUrl.href;
    } catch (_) {
      return false;
    }
  }

  function onHostResponse(response) {
    if (!response || typeof response !== "object" || typeof response.id !== "string") return;
    const pending = hostRequests.get(response.id);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    hostRequests.delete(response.id);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "任务面板服务启动失败"));
  }

  async function prepareTaskboard(generation) {
    const taskboardUrl = resolveTaskboardUrl();
    const canReuseFrame = Boolean(
      frameReady
      && frame?.isConnected
      && frameMatchesTaskboardUrl(taskboardUrl),
    );
    if (canReuseFrame) showFrame();
    else showLoading();

    try {
      const [result, context] = await Promise.all([
        requestHostEnsure(taskboardUrl),
        captureHostContext(),
      ]);
      if (!active || activeView !== TASKBOARD_VIEW || generation !== openGeneration) return;
      hostContextSnapshot = context;
      if (!frameReady || result.restarted || !frameMatchesTaskboardUrl(taskboardUrl)) {
        showLoading();
        loadTaskboardFrame();
        await waitForFrameReady();
      }
      if (!active || activeView !== TASKBOARD_VIEW || generation !== openGeneration) return;
      showFrame();
      postHostContext();
    } catch (error) {
      if (!active || activeView !== TASKBOARD_VIEW || generation !== openGeneration) return;
      const bindingAvailable = hasLiveHostBinding();
      showLoadError(bindingAvailable
        ? error.message
        : "任务面板服务未就绪。请保持 Taskboard 启动器运行后重试。");
    }
  }

  function restoreNativeContent() {
    document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HIDDEN_ATTRIBUTE));
    document.querySelectorAll(`[${HOST_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HOST_ATTRIBUTE));
  }

  function mountActivePage() {
    if (!active) return;
    if (!page) page = createPage();
    const mount = findPageMount();
    if (!mount) return;
    const { surface } = mount;

    if (page.parentElement !== surface) {
      restoreNativeContent();
      surface.appendChild(page);
    }
    page.style.setProperty("--codex-taskboard-top-offset", `${pageTopOffset(surface)}px`);
    surface.setAttribute(HOST_ATTRIBUTE, "true");
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
        child.setAttribute(HIDDEN_ATTRIBUTE, "true");
      }
    });
    hideNativeHeader();
    muteNativeSelection();
    const pageLabel = activeView === CHANNEL_VIEW
      ? "渠道配置"
      : activeView === SUB2API_VIEW
        ? "Sub2API"
        : activeCapability()?.label || "任务面板";
    page.setAttribute("aria-label", pageLabel);
    page.hidden = false;
    document.documentElement.setAttribute("data-codex-taskboard-open", "true");
  }

  function closeTaskboard(restoreFocus = true) {
    if (!active && page?.hidden !== false) return;
    openGeneration += 1;
    active = false;
    activeView = null;
    if (page) page.hidden = true;
    restoreNativeContent();
    restoreNativeSelection();
    document.documentElement.removeAttribute("data-codex-taskboard-open");
    syncEntryState();
    if (restoreFocus) lastFocusedElement?.focus?.();
    lastFocusedElement = null;
    hostContextSnapshot = null;
  }

  function openTaskboard() {
    if (destroyed) return;
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = null;
    }
    const generation = ++openGeneration;
    active = true;
    activeView = TASKBOARD_VIEW;
    ensureEntry();
    mountActivePage();
    syncEntryState();
    prepareTaskboard(generation).catch((error) => {
      if (!active || activeView !== TASKBOARD_VIEW || generation !== openGeneration) return;
      showLoadError(error instanceof Error ? error.message : "任务面板启动失败");
    });
  }

  function openChannelConfig() {
    if (destroyed) return;
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = null;
    }
    const generation = ++openGeneration;
    active = true;
    activeView = CHANNEL_VIEW;
    updateDragRegion(null);
    ensureEntry();
    mountActivePage();
    syncEntryState();

    const channelUrl = resolveChannelBridgeUrl();
    if (frameReady && frame?.isConnected && frameMatchesChannelBridgeUrl(channelUrl)) {
      showFrame();
      return;
    }
    showLoading("正在启动渠道配置…");
    loadChannelBridgeFrame(generation);
  }

  function openCapability(id) {
    if (destroyed) return;
    const capability = capabilityNavigation.find((candidate) => candidate.id === id);
    if (!capability) return;
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = null;
    }
    const generation = ++openGeneration;
    active = true;
    activeView = capabilityView(capability.id);
    updateDragRegion(null);
    ensureEntry();
    mountActivePage();
    syncEntryState();

    const capabilityUrl = new URL(capability.url);
    if (frameReady && frame?.isConnected && frameMatchesCapabilityUrl(capabilityUrl)) {
      showFrame();
      return;
    }
    showLoading(`正在打开 ${capability.label}…`);
    loadCapabilityFrame(generation, capability);
  }

  function openSub2api() {
    if (destroyed) return;
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = null;
    }
    const generation = ++openGeneration;
    active = true;
    activeView = SUB2API_VIEW;
    updateDragRegion(null);
    ensureEntry();
    mountActivePage();
    syncEntryState();

    const sub2apiUrl = resolveSub2apiUrl();
    if (frameReady && frame?.isConnected && frameMatchesSub2apiUrl(sub2apiUrl)) {
      showFrame();
      return;
    }
    showLoading("正在打开 Sub2API…");
    loadSub2apiFrame(generation);
  }

  function isNativePageNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (
      !clickable
      || clickable === entry
      || clickable === sub2apiEntry
      || clickable === channelEntry
      || capabilityEntriesHasNode(clickable)
      || clickable.closest(`#${ENTRY_ID}, #${SUB2API_ENTRY_ID}, #${CHANNEL_ENTRY_ID}, [${CAPABILITY_ENTRY_ATTRIBUTE}="true"]`)
    ) return false;
    if (!clickable.closest("aside nav[role='navigation']")) return false;
    if (clickable.hasAttribute("data-app-action-sidebar-section-toggle")) return false;
    if (buttonMatches(clickable, NATIVE_PAGE_LABELS)) return true;
    return Boolean(clickable.closest(
      "[data-app-action-sidebar-thread-id],"
      + "[data-app-action-sidebar-project-row],"
      + "[data-app-action-sidebar-project-id]",
    ));
  }

  function onDocumentClick(event) {
    const threadRow = event.target?.closest?.("[data-app-action-sidebar-thread-id]");
    const clickedThreadId = normalizeThreadId(threadRow?.getAttribute?.("data-app-action-sidebar-thread-id"));
    if (clickedThreadId) lastNativeThreadId = clickedThreadId;
    if (!active || !isNativePageNavigation(event.target)) return;
    closeTaskboard(false);
  }

  function scheduleRefresh() {
    if (destroyed || reattachTimer !== null) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = null;
      ensureEntry();
      mountActivePage();
      postHostContext();
    }, REATTACH_DELAY_MS);
  }

  function refresh() {
    ensureEntry();
    mountActivePage();
    postHostContext();
    refreshCapabilityNavigation();
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer || !document.documentElement) return;
    ensureEntry();
    refreshCapabilityNavigation().finally(scheduleCapabilityRefresh);
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "data-theme",
        "data-color-theme",
        "data-app-action-sidebar-thread-active",
        "aria-label",
        "aria-current",
      ],
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (reattachTimer !== null) window.clearTimeout(reattachTimer);
    reattachTimer = null;
    if (capabilityRefreshTimer !== null) window.clearTimeout(capabilityRefreshTimer);
    capabilityRefreshTimer = null;
    capabilityRequestGeneration += 1;
    observer?.disconnect();
    observer = null;
    cancelFrameReadyWaiters(new Error("任务面板已关闭"));
    hostRequests.forEach(({ reject, timeout }) => {
      window.clearTimeout(timeout);
      reject(new Error("任务面板已关闭"));
    });
    hostRequests.clear();
    pendingThreadCreation = null;
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("popstate", onNativeRouteChange);
    window.removeEventListener("hashchange", onNativeRouteChange);
    window.removeEventListener("resize", scheduleRefresh);
    closeTaskboard(false);
    document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    entry = null;
    sub2apiEntry = null;
    channelEntry = null;
    capabilityEntries.clear();
    capabilityNavigation = [];
    page = null;
    frame = null;
    dragRegion = null;
    noDragLeft = null;
    noDragRight = null;
    status = null;
    frameOrigin = "";
    if (window[SENTINEL_KEY] === api) delete window[SENTINEL_KEY];
  }

  function onNativeRouteChange() {
    if (active) closeTaskboard(false);
  }

  const api = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    refresh,
    reloadFrame,
    open: openTaskboard,
    openSub2api,
    openCapability,
    openChannelConfig,
    close: closeTaskboard,
    destroy,
    hostResponse: onHostResponse,
  };
  window[SENTINEL_KEY] = api;

  window.addEventListener("message", onFrameMessage);
  window.addEventListener("popstate", onNativeRouteChange);
  window.addEventListener("hashchange", onNativeRouteChange);
  window.addEventListener("resize", scheduleRefresh);
  document.addEventListener("click", onDocumentClick, true);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
