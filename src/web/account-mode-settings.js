(function initializeAccountModeSettings() {
  const MODES = ["session", "task", "qa"];
  const MODE_LABELS = { session: "会话", task: "任务", qa: "问答" };

  function normalized(account) {
    const stored = account.modeSettings || {};
    const enabledModes = MODES.filter((mode) => stored.enabledModes?.includes(mode));
    const availableModes = enabledModes.length ? enabledModes : [...MODES];
    return {
      defaultMode: availableModes.includes(stored.defaultMode) ? stored.defaultMode : availableModes[0],
      enabledModes: availableModes,
      qaKnowledgeBaseId: stored.qaKnowledgeBaseId || ""
    };
  }

  function summary(account, knowledgeBases) {
    const settings = normalized(account);
    const knowledgeBase = knowledgeBases.find((candidate) => (
      candidate.accountId === account.accountId && candidate.id === settings.qaKnowledgeBaseId
    ));
    return {
      defaultLabel: MODE_LABELS[settings.defaultMode],
      enabledLabel: settings.enabledModes.map((mode) => MODE_LABELS[mode]).join(" · "),
      qaLabel: settings.enabledModes.includes("qa")
        ? knowledgeBase?.name || "跟随项目"
        : "问答未开启"
    };
  }

  function populate(account, knowledgeBases) {
    const settings = normalized(account);
    for (const mode of MODES) {
      document.querySelector(`#accountMode${capitalize(mode)}Input`).checked = settings.enabledModes.includes(mode);
    }
    const source = document.querySelector("#accountQaSourceInput");
    source.replaceChildren(new Option("跟随当前项目绑定", "project"));
    for (const knowledgeBase of knowledgeBases.filter((candidate) => candidate.accountId === account.accountId)) {
      source.add(new Option(`已有知识库 · ${knowledgeBase.name}`, `managed:${knowledgeBase.id}`));
    }
    source.add(new Option("添加 llm-wiki 目录…", "directory"));
    source.value = settings.qaKnowledgeBaseId ? `managed:${settings.qaKnowledgeBaseId}` : "project";
    if (source.selectedIndex < 0) source.value = "project";
    document.querySelector("#accountDefaultModeInput").dataset.selectedMode = settings.defaultMode;
    document.querySelector("#accountQaDirectoryNameInput").value = "";
    document.querySelector("#accountQaDirectoryRootInput").value = "";
    document.querySelector("#accountQaEngineRootInput").value = "";
    document.querySelector("#accountQaStateDirInput").value = "";
    syncForm();
  }

  function syncForm() {
    const checkedModes = MODES.filter((mode) => document.querySelector(`#accountMode${capitalize(mode)}Input`).checked);
    if (!checkedModes.length) {
      document.querySelector("#accountModeSessionInput").checked = true;
      checkedModes.push("session");
    }
    const defaultInput = document.querySelector("#accountDefaultModeInput");
    const selectedMode = checkedModes.includes(defaultInput.value)
      ? defaultInput.value
      : defaultInput.dataset.selectedMode;
    defaultInput.replaceChildren(...checkedModes.map((mode) => new Option(`${MODE_LABELS[mode]}模式`, mode)));
    defaultInput.value = checkedModes.includes(selectedMode) ? selectedMode : checkedModes[0];
    defaultInput.dataset.selectedMode = defaultInput.value;
    const qaEnabled = checkedModes.includes("qa");
    document.querySelector("#accountQaSourceField").hidden = !qaEnabled;
    const directoryEnabled = qaEnabled && document.querySelector("#accountQaSourceInput").value === "directory";
    document.querySelector("#accountQaDirectoryFields").hidden = !directoryEnabled;
    const rootInput = document.querySelector("#accountQaDirectoryRootInput");
    rootInput.required = directoryEnabled;
    rootInput.setAttribute("aria-required", directoryEnabled ? "true" : "false");
    if (!directoryEnabled) rootInput.setAttribute("aria-invalid", "false");
  }

  function serialize() {
    const enabledModes = MODES.filter((mode) => document.querySelector(`#accountMode${capitalize(mode)}Input`).checked);
    const source = document.querySelector("#accountQaSourceInput").value;
    const qaKnowledgeBase = enabledModes.includes("qa")
      ? source === "directory"
        ? directorySelection()
        : source.startsWith("managed:")
          ? { kind: "managed", knowledgeBaseId: source.slice("managed:".length) }
          : { kind: "project" }
      : { kind: "project" };
    return {
      defaultMode: document.querySelector("#accountDefaultModeInput").value,
      enabledModes,
      qaKnowledgeBase
    };
  }

  function directorySelection() {
    const rootInput = document.querySelector("#accountQaDirectoryRootInput");
    const rootPath = rootInput.value.trim();
    if (!rootPath) {
      rootInput.setAttribute("aria-invalid", "true");
      rootInput.focus();
      throw new Error("请填写 llm-wiki 根目录。目录会先验证，再保存为知识库项目。");
    }
    const name = document.querySelector("#accountQaDirectoryNameInput").value.trim();
    const engineRoot = document.querySelector("#accountQaEngineRootInput").value.trim();
    const stateDir = document.querySelector("#accountQaStateDirInput").value.trim();
    return {
      kind: "directory",
      rootPath,
      ...(name ? { name } : {}),
      ...(engineRoot ? { engineRoot } : {}),
      ...(stateDir ? { stateDir } : {})
    };
  }

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  window.channelModeSettings = { populate, serialize, summary, syncForm };
}());
