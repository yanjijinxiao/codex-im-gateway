/* A projection of the live controller, never a second permission allowlist. */
window.createApprovalView = function ({ api, escapeHtml: html, escapeAttr: attr }) {
  const root = document.querySelector("#approvalsView"), list = root.querySelector("#approvalsList");
  const feedback = root.querySelector("#approvalFeedback"), count = document.querySelector("#approvalTabCount");
  const submitted = new Set();
  let records = [], loading, busy = false;
  const key = record => JSON.stringify([record.accountId, record.recipientId, record.id, record.version]);
  function render() {
    const shown = records.filter(record => !submitted.has(key(record)));
    count.textContent = shown.length ? ` · ${shown.length}` : "";
    const markup = shown.map(record => `<article class="approval-row">
      <header><strong>${html(record.id)} · ${html(record.accountId)}</strong><span>${html(record.hostId)}</span></header>
      <p class="approval-details">${html(record.body)}</p>
      <p class="chat-context">有效至 ${html(new Date(record.expiresAt).toLocaleTimeString())} · 在任一入口处理后，此处同步失效</p>
      <form data-approval-key="${attr(key(record))}"><label>授权范围<select name="choice" required ${busy ? "disabled" : ""}>
        <option value="" selected disabled>请选择授权范围</option>${record.options.map(option => `<option value="${attr(option.id)}">${html(option.label)} — ${html(option.description)}</option>`).join("")}
        </select></label><button class="button button-primary" type="submit" ${busy ? "disabled" : ""}>提交决定</button></form>
      </article>`).join("") || `<p class="binding-empty">当前没有待审批请求。已在 IM 或 Codex 处理的请求不会重复列出。</p>`;
    if (!busy && list.dataset.signature !== JSON.stringify(shown)) {
      list.innerHTML = markup; list.dataset.signature = JSON.stringify(shown);
    }
  }
  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      try { records = (await api("/api/approvals")).approvals; render(); }
      catch (error) { if (!root.hidden) feedback.textContent = `审批状态读取失败：${error.message}`; }
    })();
    try { await loading; } finally { loading = undefined; }
  }
  root.querySelector("#refreshApprovalsButton").addEventListener("click", () => void refresh());
  list.addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return;
    const form = event.target.closest("form[data-approval-key]"); if (!form) return;
    const record = records.find(record => key(record) === form.dataset.approvalKey && !submitted.has(key(record)));
    const choice = new FormData(form).get("choice"), option = record?.options.find(o => o.id === choice);
    if (!record || !option) return;
    if (!["accept", "decline", "cancel"].includes(option.id) && !window.confirm(`${option.label}\n\n${option.description}\n\n${record.body}`)) return;
    busy = true; form.querySelectorAll("select,button").forEach(node => { node.disabled = true; });
    try {
      const result = await api("/api/approvals/decision", { method: "POST", body: { accountId: record.accountId,
        recipientId: record.recipientId, id: record.id, version: record.version, choice: option.id } });
      submitted.add(key(record));
      while (submitted.size > 1000) submitted.delete(submitted.values().next().value);
      feedback.textContent = result.message;
    } catch (error) { feedback.textContent = error.message; }
    finally { busy = false; list.dataset.signature = ""; await refresh(); render(); }
  });
  return { refresh };
};
