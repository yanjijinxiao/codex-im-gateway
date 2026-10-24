let bindingExpiryTarget;

function renderBindingExpiry(session) {
  const expiry = session.binding?.expiry;
  if (!expiry) return "";
  if (!session.binding.bound) return expiry.endedReason === "idle"
    ? '<span class="session-expiry is-expired">因长期无人工消息已自动解绑 · session 保留</span>' : "";
  const time = value => new Date(value).toLocaleString("zh-CN", { hour12: false });
  const label = expiry.status === "disabled" ? "自动解绑已关闭" : expiry.status === "policy-pending" ? "新期限待应用，将给予完整宽限期"
    : expiry.status === "due" ? "期限已到 · 等待安全核验，不会强行解绑"
    : `预计解绑：${time(expiry.expiresAt)}`;
  return `<span class="session-expiry${expiry.status === "due" ? " is-due" : ""}">${escapeHtml(label)}</span>
    <span class="session-binding-id">${expiry.lastHumanAt ? `最近人工消息：${escapeHtml(time(expiry.lastHumanAt))}` : `暂无人工消息 · 从绑定宽限期计时`}</span>`;
}

function openBindingExpiryDialog(session) {
  if (!session.binding?.bound || !session.binding.expiry) return;
  const expiry = session.binding.expiry;
  bindingExpiryTarget = { accountId: session.accountId, sessionId: session.id,
    expected: { conversationId: session.binding.conversationId, hostId: session.binding.hostId,
      threadId: session.binding.threadId, generation: expiry.generation } };
  document.querySelector("#bindingExpiryTarget").textContent = `${accountDisplayName(session.accountId)} · ${session.senderId}\n${session.threadId || "尚未创建 Codex session"}`;
  const inherit = document.querySelector("#bindingExpiryInherit"), days = document.querySelector("#bindingExpiryDays");
  inherit.checked = expiry.inherited; days.value = expiry.effectiveDays; days.disabled = inherit.checked;
  document.querySelector("#bindingExpiryError").hidden = true;
  document.querySelector("#bindingExpiryDialog").showModal();
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#bindingExpiryInherit").addEventListener("change", event => {
    const input = document.querySelector("#bindingExpiryDays");
    input.disabled = event.target.checked;
    if (event.target.checked) input.value = state.config?.bindingIdleDays ?? 15;
  });
  document.querySelector("#bindingExpiryForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!bindingExpiryTarget) return;
    const target = bindingExpiryTarget, submit = event.submitter, error = document.querySelector("#bindingExpiryError");
    try {
      const days = document.querySelector("#bindingExpiryInherit").checked ? null : Number(document.querySelector("#bindingExpiryDays").value);
      if (days !== null && (!Number.isInteger(days) || days < 0 || days > 3650)) throw new Error("请输入 0–3650 的整数天数，0 为关闭。");
      submit.disabled = true; error.hidden = true;
      await api(`/api/sessions/${encodeURIComponent(target.accountId)}/${encodeURIComponent(target.sessionId)}/binding-expiry`,
        { method: "POST", body: { ...target.expected, idleDays: days } });
      document.querySelector("#bindingExpiryDialog").close(); bindingExpiryTarget = undefined;
      await refreshData(false); toast("自动解绑期限已保存，宽限期重新开始。");
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { submit.disabled = false; }
  });
});
