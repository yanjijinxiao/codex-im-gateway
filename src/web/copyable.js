// Shared cross-surface handoff controls, not a decoration for arbitrary text.
// Producers explicitly opt in replies/transfers; ordinary forms stay native.
window.gatewayCopy = (() => {
  const sources = new WeakMap(), controls = new WeakMap();
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  function field(label, value, options) {
    if (!["reply", "transfer"].includes(options?.purpose)) throw Error("Copy controls require a reply or transfer purpose");
    const rows = options.rows === 2 ? 2 : 1;
    return `<div class="gateway-copy" data-copy-field data-copy-purpose="${options.purpose}"><label>${escape(label)}<textarea data-copy-value readonly rows="${rows}" spellcheck="false" autocapitalize="off">${escape(value)}</textarea></label><button type="button" data-copy-button aria-label="${escape(`复制${label}`)}">复制</button><small data-copy-status role="status" aria-live="polite"></small></div>`;
  }
  async function copy(container) {
    const value = container.querySelector("[data-copy-value]"), button = container.querySelector("[data-copy-button]"), status = container.querySelector("[data-copy-status]");
    if (!value || !button || !status || button.disabled) return;
    const source = sources.get(container);
    if (source) value.value = sourceValue(source);
    if (!value.value) { status.textContent = "暂无可复制内容"; return; }
    button.disabled = true; status.textContent = "正在复制…";
    try {
      // Keep an exact, visible manual-copy box even in embedded IM browsers.
      // Synchronous selection copying also preserves their short user gesture.
      value.hidden = false;
      value.focus({ preventScroll: true }); value.select(); value.setSelectionRange(0, value.value.length);
      if (!document.execCommand?.("copy")) {
        if (!navigator.clipboard?.writeText) throw Error("clipboard unavailable");
        await navigator.clipboard.writeText(value.value);
      }
      status.textContent = "已请求复制；粘贴未更新时，可长按框内复制。";
    } catch {
      status.textContent = "自动复制不可用，内容已选中，请长按复制或按 Ctrl/Cmd+C。";
    } finally { button.disabled = false; }
  }
  function cleanText(source) {
    const clone = source.cloneNode(true);
    clone.querySelectorAll("[data-copy-field],[data-copy-tools]").forEach(node => node.remove());
    return clone.textContent.trim();
  }
  function sourceValue(source) {
    const declared = source.getAttribute("data-copy-output");
    if (declared !== null) return declared;
    if (source.tagName === "SELECT") return [...source.selectedOptions].map(option => option.value || option.label).join("\n");
    if (typeof source.value === "string") return source.value;
    return cleanText(source);
  }
  function sourceLabel(source) {
    let label;
    if (source.labels?.[0]) {
      const clone = source.labels[0].cloneNode(true);
      clone.querySelectorAll("input,select,textarea,[data-copy-field]").forEach(node => node.remove());
      label = clone.textContent.trim().slice(0, 100);
    }
    return source.getAttribute("aria-label") || label || (source.tagName === "LI" && cleanText(source).slice(0, 60))
      || "需发送或回填的内容";
  }
  function enhance(root = document) {
    if (!root.querySelectorAll) return;
    for (const source of root.querySelectorAll('[data-copy-purpose="reply"],[data-copy-purpose="transfer"]')) {
      if (source.closest("[data-copy-field],[data-copy-ignore],[contenteditable=true]")) continue;
      if (source.tagName === "CODE" && source.closest("pre")) continue;
      if (["hidden", "password", "file", "submit", "button", "reset", "image", "color", "range", "checkbox", "radio"].includes(source.type)) continue;
      if (controls.get(source)?.isConnected) continue;
      const label = source.getAttribute("data-copy-label") || sourceLabel(source), tools = document.createElement("span");
      tools.className = "gateway-copy-tools"; tools.setAttribute("data-copy-field", ""); tools.setAttribute("data-copy-tools", "");
      tools.innerHTML = `<button type="button" data-copy-button aria-label="${escape(`复制${label}`)}">复制</button><small data-copy-status role="status" aria-live="polite"></small><textarea data-copy-value readonly hidden rows="2" aria-label="${escape(`可手动复制的${label}`)}" spellcheck="false"></textarea>`;
      sources.set(tools, source); controls.set(source, tools);
      // Never put interactive controls inside a form label or link: that would
      // change the input's accessible name or make a copy tap activate a link.
      (source.closest("label,a") || source).insertAdjacentElement("afterend", tools);
    }
  }
  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-copy-button]");
    if (button) {
      event.preventDefault?.(); event.stopPropagation?.();
      void copy(button.closest("[data-copy-field]"));
    }
  }, true); // A copy tap inside a clickable row must not execute that row.
  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return; scheduled = true;
      (window.requestAnimationFrame || (fn => setTimeout(fn, 0)))(() => { scheduled = false; enhance(); });
    };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    schedule();
  }
  // Refresh must not interrupt a tap, clipboard operation or manual selection.
  // The original browser still exchanges its proof; copying cannot authorize it.
  if (document.querySelector("[data-ide-wait]")) {
    let pausedUntil = 0;
    for (const name of ["pointerdown", "keydown", "copy"]) document.addEventListener(name, () => { pausedUntil = Date.now() + 8000; });
    window.setInterval(() => { if (!document.hidden && Date.now() >= pausedUntil) window.location.reload(); }, 3000);
  }
  return { field, copy, enhance };
})();
