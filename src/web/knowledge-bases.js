const knowledgeBaseInspections = new Map();

window.renderKnowledgeBasesPage = renderKnowledgeBasesPage;

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#addKnowledgeBaseButton").addEventListener("click", openNewKnowledgeBaseDialog);
  document.querySelector("#knowledgeBaseForm").addEventListener("submit", async (event) => {
    await saveKnowledgeBase(event);
  });
  document.querySelector("#knowledgeBaseList").addEventListener("click", async (event) => {
    await handleKnowledgeBaseAction(event);
  });
  document.querySelector("#knowledgeBindingList").addEventListener("change", async (event) => {
    await handleKnowledgeBaseBinding(event);
  });
});

function renderKnowledgeBasesPage() {
  const list = document.querySelector("#knowledgeBaseList");
  const bindings = document.querySelector("#knowledgeBindingList");
  if (!list || !bindings) return;
  if (!state.knowledgeBases.length) {
    list.innerHTML = emptyState(
      "library-big",
      "还没有 llm-wiki 知识库",
      "添加一个包含 wiki/ 和只读检索能力的 llm-wiki 项目。",
      '<button class="button button-primary" type="button" data-knowledge-action="add"><i data-lucide="library-big"></i><span>添加 llm-wiki</span></button>'
    );
  } else {
    list.innerHTML = state.knowledgeBases.map(renderKnowledgeBaseRow).join("");
  }
  const projects = [...state.projects].sort((left, right) => (
    `${left.accountId}:${left.name}`.localeCompare(`${right.accountId}:${right.name}`, "zh-CN")
  ));
  bindings.innerHTML = projects.length
    ? projects.map(renderKnowledgeBinding).join("")
    : emptyState("folder", "还没有 Codex 项目", "先在消息渠道页添加项目，再绑定问答知识库。");
  drawIcons();
}

function renderKnowledgeBaseRow(knowledgeBase) {
  const inspection = knowledgeBaseInspections.get(knowledgeBaseKey(knowledgeBase));
  const account = state.accounts.find((item) => item.accountId === knowledgeBase.accountId);
  const boundProjects = knowledgeBase.boundProjects || [];
  const status = inspection?.loading
    ? '<span class="knowledge-health is-checking"><i data-lucide="loader-circle"></i>正在检查</span>'
    : inspection?.error
      ? `<span class="knowledge-health is-error"><i data-lucide="circle-alert"></i>${kbEscape(inspection.error)}</span>`
      : inspection?.status
        ? `<span class="knowledge-health is-healthy"><i data-lucide="circle-check"></i>${inspection.status.documentCount} 文档 · ${inspection.status.blockCount} 区块</span>`
        : '<span class="knowledge-health"><i data-lucide="circle-dashed"></i>尚未检查</span>';
  return `<article class="knowledge-base-row" data-knowledge-key="${kbEscape(knowledgeBaseKey(knowledgeBase))}">
    <div class="knowledge-base-icon" aria-hidden="true"><i data-lucide="library-big"></i></div>
    <div class="knowledge-base-main">
      <div class="knowledge-base-title"><strong>${kbEscape(knowledgeBase.name)}</strong>${status}</div>
      <code title="${kbEscape(knowledgeBase.rootPath)}">${kbEscape(knowledgeBase.rootPath)}</code>
      <p>${kbEscape(account?.displayName || account?.name || knowledgeBase.accountId)} · ${knowledgeBase.channelDefault ? "渠道问答默认" : "非渠道默认"} · ${boundProjects.length ? `已绑定 ${boundProjects.map((project) => project.name).join("、")}` : "尚未绑定项目"}</p>
    </div>
    <div class="knowledge-base-actions">
      <button class="icon-button" type="button" data-knowledge-action="inspect" data-account-id="${kbEscape(knowledgeBase.accountId)}" data-knowledge-id="${kbEscape(knowledgeBase.id)}" title="重新检查 ${kbEscape(knowledgeBase.name)}" aria-label="重新检查 ${kbEscape(knowledgeBase.name)}"><i data-lucide="activity"></i></button>
      <button class="icon-button" type="button" data-knowledge-action="edit" data-account-id="${kbEscape(knowledgeBase.accountId)}" data-knowledge-id="${kbEscape(knowledgeBase.id)}" title="编辑 ${kbEscape(knowledgeBase.name)}" aria-label="编辑 ${kbEscape(knowledgeBase.name)}"><i data-lucide="pencil"></i></button>
      <button class="icon-button is-danger" type="button" data-knowledge-action="delete" data-account-id="${kbEscape(knowledgeBase.accountId)}" data-knowledge-id="${kbEscape(knowledgeBase.id)}" title="${knowledgeBase.channelDefault ? "请先取消渠道问答默认" : `删除 ${kbEscape(knowledgeBase.name)}`}" aria-label="${knowledgeBase.channelDefault ? `无法删除 ${kbEscape(knowledgeBase.name)}：仍是渠道问答默认` : `删除 ${kbEscape(knowledgeBase.name)}`}" ${boundProjects.length || knowledgeBase.channelDefault ? "disabled" : ""}><i data-lucide="trash-2"></i></button>
    </div>
  </article>`;
}

function renderKnowledgeBinding(project) {
  const available = state.knowledgeBases.filter((knowledgeBase) => knowledgeBase.accountId === project.accountId);
  const account = state.accounts.find((item) => item.accountId === project.accountId);
  return `<label class="knowledge-binding-row">
    <span class="knowledge-binding-project"><strong>${kbEscape(project.name)}</strong><small>${kbEscape(account?.displayName || account?.name || project.accountId)} · ${kbEscape(project.workspace)}</small></span>
    <select data-knowledge-binding data-account-id="${kbEscape(project.accountId)}" data-project-id="${kbEscape(project.id)}" aria-label="为项目 ${kbEscape(project.name)} 选择问答知识库">
      <option value="">不启用问答模式</option>
      ${available.map((knowledgeBase) => `<option value="${kbEscape(knowledgeBase.id)}" ${project.knowledgeBaseId === knowledgeBase.id ? "selected" : ""}>${kbEscape(knowledgeBase.name)}</option>`).join("")}
    </select>
  </label>`;
}

function openNewKnowledgeBaseDialog() {
  document.querySelector("#knowledgeBaseDialogTitle").textContent = "添加 llm-wiki";
  document.querySelector("#editingKnowledgeBaseId").value = "";
  document.querySelector("#editingKnowledgeBaseAccountId").value = "";
  document.querySelector("#knowledgeBaseAccountField").hidden = false;
  const accountInput = document.querySelector("#knowledgeBaseAccountInput");
  accountInput.innerHTML = state.accounts.map((account) => (
    `<option value="${kbEscape(account.accountId)}">${kbEscape(account.displayName || account.name || account.accountId)}</option>`
  )).join("");
  document.querySelector("#knowledgeBaseNameInput").value = "";
  document.querySelector("#knowledgeBaseRootInput").value = "";
  document.querySelector("#knowledgeBaseEngineInput").value = "";
  document.querySelector("#knowledgeBaseStateInput").value = "";
  setKnowledgeBaseFormError("");
  document.querySelector("#knowledgeBaseDialog").showModal();
  document.querySelector("#knowledgeBaseNameInput").focus();
}

function openEditKnowledgeBaseDialog(knowledgeBase) {
  document.querySelector("#knowledgeBaseDialogTitle").textContent = "编辑 llm-wiki";
  document.querySelector("#editingKnowledgeBaseId").value = knowledgeBase.id;
  document.querySelector("#editingKnowledgeBaseAccountId").value = knowledgeBase.accountId;
  document.querySelector("#knowledgeBaseAccountField").hidden = true;
  document.querySelector("#knowledgeBaseNameInput").value = knowledgeBase.name;
  document.querySelector("#knowledgeBaseRootInput").value = knowledgeBase.rootPath;
  document.querySelector("#knowledgeBaseEngineInput").value = knowledgeBase.engineRoot || "";
  document.querySelector("#knowledgeBaseStateInput").value = knowledgeBase.stateDir || "";
  setKnowledgeBaseFormError("");
  document.querySelector("#knowledgeBaseDialog").showModal();
  document.querySelector("#knowledgeBaseNameInput").focus();
}

async function saveKnowledgeBase(event) {
  event.preventDefault();
  const button = event.submitter;
  const knowledgeBaseId = document.querySelector("#editingKnowledgeBaseId").value;
  const editingAccountId = document.querySelector("#editingKnowledgeBaseAccountId").value;
  const accountId = editingAccountId || document.querySelector("#knowledgeBaseAccountInput").value;
  const body = {
    name: document.querySelector("#knowledgeBaseNameInput").value.trim(),
    rootPath: document.querySelector("#knowledgeBaseRootInput").value.trim(),
    engineRoot: document.querySelector("#knowledgeBaseEngineInput").value.trim() || (knowledgeBaseId ? null : undefined),
    stateDir: document.querySelector("#knowledgeBaseStateInput").value.trim() || (knowledgeBaseId ? null : undefined)
  };
  setKnowledgeBaseFormError("");
  try {
    button.disabled = true;
    button.querySelector("span").textContent = "正在验证";
    const result = knowledgeBaseId
      ? await api(`/api/knowledge-bases/${encodeURIComponent(accountId)}/${encodeURIComponent(knowledgeBaseId)}`, { method: "PATCH", body })
      : await api("/api/knowledge-bases", { method: "POST", body: { accountId, ...body } });
    const saved = result.knowledgeBase;
    if (result.inspection) knowledgeBaseInspections.set(knowledgeBaseKey(saved), result.inspection);
    document.querySelector("#knowledgeBaseDialog").close();
    await refreshData(false);
    toast(knowledgeBaseId ? "知识库已更新" : "llm-wiki 已添加");
  } catch (error) {
    setKnowledgeBaseFormError(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "验证并保存";
  }
}

async function handleKnowledgeBaseAction(event) {
  const button = event.target.closest("[data-knowledge-action]");
  if (!button) return;
  if (button.dataset.knowledgeAction === "add") {
    openNewKnowledgeBaseDialog();
    return;
  }
  const knowledgeBase = state.knowledgeBases.find((item) => (
    item.accountId === button.dataset.accountId && item.id === button.dataset.knowledgeId
  ));
  if (!knowledgeBase) return;
  if (button.dataset.knowledgeAction === "edit") {
    openEditKnowledgeBaseDialog(knowledgeBase);
    return;
  }
  if (button.dataset.knowledgeAction === "inspect") {
    await inspectKnowledgeBase(knowledgeBase, button);
    return;
  }
  if (button.dataset.knowledgeAction === "delete") {
    if (!window.confirm(`删除知识库“${knowledgeBase.name}”？不会删除磁盘目录。`)) return;
    try {
      button.disabled = true;
      await api(`/api/knowledge-bases/${encodeURIComponent(knowledgeBase.accountId)}/${encodeURIComponent(knowledgeBase.id)}`, { method: "DELETE" });
      knowledgeBaseInspections.delete(knowledgeBaseKey(knowledgeBase));
      await refreshData(false);
      toast("知识库记录已删除，磁盘目录未改动");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      button.disabled = false;
    }
  }
}

async function inspectKnowledgeBase(knowledgeBase, button) {
  const key = knowledgeBaseKey(knowledgeBase);
  knowledgeBaseInspections.set(key, { loading: true });
  renderKnowledgeBasesPage();
  try {
    button.disabled = true;
    const result = await api(`/api/knowledge-bases/${encodeURIComponent(knowledgeBase.accountId)}/${encodeURIComponent(knowledgeBase.id)}/inspect`, { method: "POST" });
    knowledgeBaseInspections.set(key, result.inspection);
    toast("llm-wiki 状态正常");
  } catch (error) {
    knowledgeBaseInspections.set(key, { error: error instanceof Error ? error.message : String(error) });
    toast("知识库检查失败", true);
  } finally {
    renderKnowledgeBasesPage();
  }
}

async function handleKnowledgeBaseBinding(event) {
  const select = event.target.closest("[data-knowledge-binding]");
  if (!select) return;
  try {
    select.disabled = true;
    await api(`/api/projects/${encodeURIComponent(select.dataset.accountId)}/${encodeURIComponent(select.dataset.projectId)}/knowledge-base`, {
      method: "PUT",
      body: { knowledgeBaseId: select.value || null }
    });
    await refreshData(false);
    toast(select.value ? "项目问答知识库已绑定" : "项目问答模式已关闭");
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
    await refreshData(false);
  } finally {
    select.disabled = false;
  }
}

function setKnowledgeBaseFormError(message) {
  const element = document.querySelector("#knowledgeBaseFormError");
  element.textContent = message;
  element.hidden = !message;
}

function knowledgeBaseKey(knowledgeBase) {
  return `${knowledgeBase.accountId}:${knowledgeBase.id}`;
}

function kbEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
