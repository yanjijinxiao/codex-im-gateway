/* A projection of the live controller, never a second permission allowlist. */
window.createApprovalView = function ({ api, escapeHtml: html, escapeAttr: attr }) {
  const root = document.querySelector("#approvalsView"), list = root.querySelector("#approvalsList");
  const feedback = root.querySelector("#approvalFeedback"), count = document.querySelector("#approvalTabCount");
  const admissionList = root.querySelector("#admissionList"), admissionAdmins = root.querySelector("#admissionAdmins");
  let admission = { requests: [], candidates: [], admins: [] };
  const submitted = new Set();
  let records = [], loading, busy = false;
  const key = record => JSON.stringify([record.accountId, record.recipientId, record.id, record.version]);
  function render() {
    const shown = records.filter(record => !submitted.has(key(record)));
    const total = shown.length + admission.requests.length;
    count.textContent = total ? ` · ${total}` : "";
    renderAdmission();
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
  function renderAdmission() {
    if (!admissionList || !admissionAdmins || busy) return;
    const signature = JSON.stringify(admission);
    if (admissionList.dataset.signature === signature) return;
    admissionList.dataset.signature = signature;
    admissionList.innerHTML = (admission.error ? `<p role="alert">${html(admission.error)}</p>` : "") +
      (admission.requests.map(record => `<article class="approval-row">
        <header><strong>准入申请 · ${html(record.principal.accountId)}</strong></header>
        <p class="approval-details">用户：${html(record.principal.actorId)}<br>来源${record.kind === "group" ? "群聊" : "私聊"}：${html(record.conversationId)}</p>
        <p class="chat-context">仅允许用户包含 IM 与本人 IDE 配对资格；整个群聊覆盖其他群成员，仅含 IM。原消息不会自动执行。申请有效至 ${html(new Date(record.expiresAt).toLocaleString())}。</p>
        ${record.phase === "applying" ? `<p role="alert">上次授权结果未确认，不能重复提交；请核对账号授权。</p>` : `<form data-admission-id="${attr(record.id)}" data-admission-version="${attr(record.version)}">
          <label>准入范围<select name="choice" required><option value="" selected disabled>请选择</option>
          <option value="actor">仅允许此用户</option>${record.kind === "group" ? `<option value="conversation">允许整个群聊</option>` : ""}<option value="deny">拒绝申请</option></select></label>
          <button class="button button-primary" type="submit">提交决定</button></form>`}</article>`).join("") || `<p class="binding-empty">当前没有待处理准入申请。尚未获准的用户向机器人发送消息后会登记于此；已获准用户不会重复列出。</p>`);
    admissionAdmins.innerHTML = admission.admins.map((principal, index) => `<article class="approval-row"><p>${html(principal.accountId)} · ${html(principal.actorId)}</p><button type="button" class="button button-secondary" data-remove-admin="${index}">撤销准入审批资格</button></article>`).join("") +
      `<form data-enroll-admin><label>已核验的个人身份<select name="identity" required><option value="" selected disabled>请选择本人身份</option>${admission.candidates.filter(r => r.phase === "pending").map(r => `<option value="${attr(r.id)}">${html(r.principal.accountId)} · 用户 ${html(r.principal.actorId)} · 来源 ${html(r.conversationId)}</option>`).join("")}</select></label><button class="button button-primary" type="submit">指定为准入审批管理员</button></form>`;
  }
  async function admissionAction(event) {
    event.preventDefault(); if (busy) return;
    const form = event.target.closest("form"); if (!form) return;
    const values = new FormData(form), enroll = form.hasAttribute("data-enroll-admin");
    const record = admission.candidates.find(r => r.id === (enroll ? values.get("identity") : form.dataset.admissionId)
      && (enroll || r.version === form.dataset.admissionVersion));
    if (!record) return;
    const choice = values.get("choice"); if (!enroll && !["actor", "conversation", "deny"].includes(choice)) return;
    if (!window.confirm(`${enroll ? "指定此用户为准入审批管理员，可给所属渠道的其他人或整个群聊授权" : choice === "conversation" ? "允许群内所有成员使用 IM" : choice === "actor" ? "仅允许此用户使用 IM 及本人 IDE 配对" : "拒绝此准入申请"}？\n\n账号：${record.principal.accountId}\n用户：${record.principal.actorId}\n来源：${record.conversationId}`)) return;
    busy = true; form.querySelectorAll("select,button").forEach(node => { node.disabled = true; });
    try { feedback.textContent = (await api(enroll ? "/api/admission/admins" : "/api/admission/decision", { method: "POST", body: { id: record.id, version: record.version, ...(enroll ? {} : { choice }) } })).message; }
    catch (error) { feedback.textContent = error.message; }
    finally { busy = false; admissionList.dataset.signature = ""; await refresh(); render(); }
  }
  admissionList?.addEventListener("submit", admissionAction);
  admissionAdmins?.addEventListener("submit", admissionAction);
  admissionAdmins?.addEventListener("click", async event => {
    const button = event.target.closest("button[data-remove-admin]"); if (!button || busy) return;
    const principal = admission.admins[Number(button.dataset.removeAdmin)];
    if (!principal || !window.confirm(`撤销 ${principal.accountId} 的用户 ${principal.actorId} 的准入审批资格？`)) return;
    busy = true; button.disabled = true;
    try { feedback.textContent = (await api("/api/admission/admins/remove", { method: "POST", body: { principal } })).message; }
    catch (error) { feedback.textContent = error.message; }
    finally { busy = false; admissionList.dataset.signature = ""; await refresh(); render(); }
  });
  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      await Promise.all([
        (async () => { try { records = (await api("/api/approvals")).approvals; }
          catch (error) { if (!root.hidden) feedback.textContent = `Codex 审批读取失败：${error.message}`; } })(),
        (async () => { if (!admissionList) return;
          try { admission = await api("/api/admission"); }
          catch (error) { admission = { ...admission, error: `准入申请读取失败：${error.message}` }; } })()
      ]); render();
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
