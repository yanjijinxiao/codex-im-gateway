/* Read-only presentation of /api/sessions. Filters are UI state, not another binding registry. */
window.createBindingOverview = function createBindingOverview(hooks) {
  const { snapshot, escapeHtml: html, escapeAttr: attr, accountName, showView, sessionAction, refresh, drawIcons } = hooks;
  const root = document.querySelector("#bindingsView");
  const list = root.querySelector("#bindingsList");
  const accountFilter = root.querySelector("#bindingAccountFilter");
  const projectFilter = root.querySelector("#bindingProjectFilter");
  const search = root.querySelector("#bindingSearch");
  const count = root.querySelector("#bindingCount");
  let historyOpen = false;

  const projectFor = (session, state) => state.projects.find(project => project.accountId === session.accountId && project.id === session.projectId);
  const option = (value, label) => `<option value="${attr(value)}">${html(label)}</option>`;
  function options(control, markup) {
    if (control.innerHTML !== markup) {
      const value = control.value;
      control.innerHTML = markup;
      control.value = [...control.options].some(item => item.value === value) ? value : "";
    }
  }
  function renderRow(session, state) {
    const binding = session.binding;
    const current = binding?.bound === true;
    const identity = binding?.conversation;
    const kind = identity?.kind === "group" ? "群聊" : identity?.kind === "direct" ? "私聊" : "对话类型待确认";
    const name = identity?.name || (identity?.kind === "group" ? "群名待确认" : identity?.kind === "direct" ? "私聊名称待确认" : "对话名称待确认");
    const project = projectFor(session, state);
    const account = state.accounts.find(item => item.accountId === session.accountId);
    const unavailable = binding?.nativeUnavailable;
    const routeUnknown = binding?.deliveryRoute === "unconfirmed";
    const stopped = account?.status !== "running";
    const stateLabel = !current ? "历史关联 · 非当前绑定" : unavailable ? "已归档或不可用 · 交互暂停"
      : stopped ? "渠道未运行" : routeUnknown ? "投递身份待确认" : !session.threadId ? "等待创建 session" : "当前绑定";
    const route = !current ? "不参与当前提问投递" : unavailable ? "交互已暂停，绑定记录保留"
      : binding?.interaction?.current ? "提问入口：此对话" : binding?.interaction?.destination ? "提问入口：其他跟随对话" : "提问入口：未确定或原入口失效";
    const canPrimary = current && session.threadId && session.follow !== false && !unavailable && !stopped && binding?.deliveryRoute === "available";
    const target = `data-account-id="${attr(session.accountId)}" data-session-id="${attr(session.id)}"`;
    const badgeClass = !current ? "is-history" : unavailable || routeUnknown || stopped ? "is-warning" : "is-current";
    return `<article class="binding-row" aria-label="${attr(name)}对应${attr(session.title)}">
      <div class="binding-conversation"><span class="binding-column-label">钉钉 / IM 对话</span>
        <span class="binding-kind">${html(accountName(session.accountId))} · ${kind}</span>
        <strong>${html(name)}</strong><span class="binding-id">${html(binding?.conversationId || session.senderId)}</span>
      </div>
      <div class="binding-session"><span class="binding-column-label">Codex session</span>
        <strong>${html(session.title)}</strong><span class="binding-id">${html(session.threadId || "尚未创建 Codex session")}</span>
        <span class="binding-meta">主机：${html(binding?.hostId || session.hostId || "local")}</span>
        <span class="binding-meta">项目：${html(project?.name || (session.projectId ? "项目记录不可用" : "无项目"))}</span>
      </div>
      <div class="binding-status"><span class="binding-column-label">状态与提问入口</span>
        <span class="binding-badge ${badgeClass}">${stateLabel}</span><span>${route}</span>
        ${current && session.runtimeRecovery ? `<small>系统恢复：${html(session.runtimeRecovery.message)}</small>` : ""}
        ${current && routeUnknown ? `<small>投递身份需由此对话的下一条机器人消息确认。</small>` : ""}
        ${current && !unavailable && !stopped && session.threadId && !binding?.deliveryRoute ? `<small>投递通道尚未检查</small>` : ""}
      </div>
      <div class="binding-actions"><button class="button button-secondary" type="button" data-session-action="inspect" ${target}>查看会话</button>
        ${current ? `<button class="button button-secondary" type="button" data-session-action="primary" ${target} ${!canPrimary || binding?.interaction?.current ? "disabled" : ""}>${binding?.interaction?.current ? "当前提问入口" : "设为提问入口"}</button>
        <button class="button button-secondary" type="button" data-session-action="unbind" ${target}>解绑</button>` : ""}
      </div>
    </article>`;
  }
  function render() {
    const state = snapshot();
    const accounts = [...new Set([...state.accounts.map(item => item.accountId), ...state.sessions.map(item => item.accountId)])];
    options(accountFilter, option("", "全部消息渠道") + accounts.map(id => option(id, accountName(id))).join(""));
    const projects = state.projects.filter(item => !accountFilter.value || item.accountId === accountFilter.value);
    options(projectFilter, option("", "全部项目") + option("~none", "无项目")
      + projects.map(project => option(JSON.stringify([project.accountId, project.id]), `${project.name} · ${accountName(project.accountId)}`)).join(""));
    const query = search.value.trim().toLocaleLowerCase();
    const records = state.sessions.filter(session => {
      if (accountFilter.value && session.accountId !== accountFilter.value) return false;
      if (projectFilter.value === "~none" && session.projectId) return false;
      if (projectFilter.value && projectFilter.value !== "~none" && JSON.stringify([session.accountId, session.projectId]) !== projectFilter.value) return false;
      const project = projectFor(session, state);
      return !query || [session.title, session.threadId, session.senderId, session.binding?.conversation?.name,
        session.binding?.hostId, session.hostId, project?.name, accountName(session.accountId)].filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
    });
    const current = records.filter(session => session.binding?.bound === true);
    const historical = records.filter(session => session.binding?.bound !== true);
    count.textContent = `当前绑定 ${current.length} · 历史关联 ${historical.length}`;
    const markup = `<div class="binding-table-head" aria-hidden="true"><span>钉钉 / IM 对话</span><span>Codex session</span><span>状态与提问入口</span><span>操作</span></div>
      <div class="binding-current-list">${current.map(session => renderRow(session, state)).join("") || `<p class="binding-empty">当前筛选下没有有效绑定。旧记录可在下方“历史关联”中查看。</p>`}</div>
      ${historical.length ? `<details class="binding-history" ${historyOpen ? "open" : ""}><summary>历史关联 <b>${historical.length}</b><span>不参与当前消息和提问路由</span></summary>${historical.map(session => renderRow(session, state)).join("")}</details>` : ""}`;
    if (list.innerHTML !== markup) list.innerHTML = markup;
    drawIcons();
  }
  function open(accountId = "", projectId = "") {
    render();
    accountFilter.value = accountId;
    render();
    projectFilter.value = projectId ? JSON.stringify([accountId, projectId]) : "";
    search.value = "";
    historyOpen = false;
    render();
    showView("bindings");
    root.querySelector("h1").focus();
  }
  accountFilter.addEventListener("change", () => { projectFilter.value = ""; render(); });
  projectFilter.addEventListener("change", render);
  search.addEventListener("input", render);
  root.querySelector("#refreshBindingsButton").addEventListener("click", () => void refresh());
  list.addEventListener("toggle", event => {
    if (event.target.matches(".binding-history")) historyOpen = event.target.open;
  }, true);
  list.addEventListener("click", event => void sessionAction(event));
  document.querySelector("#accountsList").addEventListener("click", event => {
    const button = event.target.closest("[data-binding-link]");
    if (button) open(button.dataset.accountId, button.dataset.projectId);
  });
  return { render, open };
};
