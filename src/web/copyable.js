// Shared copy-only control. Never submits a form or approves an IDE request.
window.gatewayCopy = (() => {
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  function field(label, value) {
    return `<div class="gateway-copy" data-copy-field><label>${escape(label)}<textarea data-copy-value readonly rows="1" spellcheck="false" autocapitalize="off">${escape(value)}</textarea></label><button type="button" data-copy-button aria-label="${escape(`复制${label}`)}">复制</button><small data-copy-status role="status" aria-live="polite"></small></div>`;
  }
  async function copy(container) {
    const value = container.querySelector("[data-copy-value]"), button = container.querySelector("[data-copy-button]"), status = container.querySelector("[data-copy-status]");
    if (!value || !button || !status || button.disabled) return;
    button.disabled = true; status.textContent = "正在复制…";
    try {
      try {
        if (!navigator.clipboard?.writeText) throw Error("clipboard unavailable");
        await navigator.clipboard.writeText(value.value);
      } catch {
        value.focus({ preventScroll: true }); value.select(); value.setSelectionRange(0, value.value.length);
        if (!document.execCommand?.("copy")) throw Error("manual copy required");
      }
      status.textContent = "已复制";
    } catch {
      status.textContent = "自动复制不可用，内容已选中，请长按复制或按 Ctrl/Cmd+C。";
    } finally { button.disabled = false; }
  }
  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-copy-button]");
    if (button) void copy(button.closest("[data-copy-field]"));
  });
  // Refresh must not interrupt a tap, clipboard operation or manual selection.
  // The original browser still exchanges its proof; copying cannot authorize it.
  if (document.querySelector("[data-ide-wait]")) {
    let pausedUntil = 0;
    for (const name of ["pointerdown", "keydown", "copy"]) document.addEventListener(name, () => { pausedUntil = Date.now() + 8000; });
    window.setInterval(() => { if (!document.hidden && Date.now() >= pausedUntil) window.location.reload(); }, 3000);
  }
  return { field, copy };
})();
