window.gatewayIDE = (() => {
  let current, busy = false, opening = false, approval, requests = [], requestMarkup = "", instanceMarkup = "", endpointMarkup = "", sessionDuration = "15 天";
  const receipts = new Map();
  let approverMarkup = "", approverAccountsMarkup = "", approverBusy = false;
  const $ = selector => document.querySelector(selector);
  function message(text, error = false) {
    const el = $("#ideMessage"); el.textContent = text; el.classList.toggle("ide-error", error);
  }
  function showCertificate(info) {
    const status = $("#ideTLSStatus"); status.classList.toggle("ide-error", Boolean(info?.error));
    status.textContent = info?.error || (info ? `服务端证书有效至 ${new Date(info.expiresAt).toLocaleString()}。${info.managed ? `本地 CA 指纹（SHA256）：${info.caFingerprint256}。CA 到期：${new Date(info.caExpiresAt).toLocaleDateString()}。受管叶子证书会在到期前 30 天续签，CA 不静默更换。` : `外部证书需由签发工具续期，指纹：${info.fingerprint256}。`}` : "未配置内置 HTTPS。");
    $("#ideTLSDownload").hidden = !info?.managed;
  }
  async function prepareTLS() {
    if (busy || !current) return;
    const address = $("#ideTLSAddress").value, port = Number($("#idePort").value), button = $("#ideTLSGenerate");
    if (!address || !Number.isInteger(port) || port < 1024 || port > 65535) { $("#ideTLSStatus").textContent = "请先选择当前可用的本机 IP，并填写有效的 IDE 端口。"; return; }
    busy = true; button.disabled = true; $("#ideSave").disabled = true;
    const fields = ["#ideTLSAddress", "#idePort", "#ideOrigin", "#ideTLSEnabled", "#ideTLSCert", "#ideTLSKey"].map($);
    fields.forEach(field => { field.disabled = true; });
    $("#ideTLSStatus").textContent = "正在生成或复用本地证书；不会修改系统信任库，也不会立即改变网络入口…";
    try {
      const result = await api("/api/ide/tls/prepare", { method: "POST", body: { address } });
      $("#ideTLSEnabled").checked = true; $("#ideTLSCert").value = result.tls.certFile; $("#ideTLSKey").value = result.tls.keyFile;
      $("#ideOrigin").value = `https://${address.includes(":") ? `[${address}]` : address}:${port}`;
      showCertificate(result.certificate); message("证书已准备，尚未启用 HTTPS。请核对地址和 CA 指纹，再保存并应用；访问设备需自行信任该 CA。");
    } catch (error) { $("#ideTLSStatus").textContent = `未能准备证书：${error.message}。可检查后重试。`; $("#ideTLSStatus").classList.add("ide-error"); }
    finally { busy = false; button.disabled = false; $("#ideSave").disabled = false; fields.forEach(field => { field.disabled = false; }); }
  }
  function renderActivity(data) {
    if (current) current.instances = data.instances || [];
    if (data.approvers) renderApprovers(data.approvers);
    const labels = { checking: "检查主机", "remote-download": "远程下载官方包", "gateway-download": "Gateway 兜底下载", transferring: "SSH 传输", verifying: "校验并安装", ready: "已就绪", error: "失败，可重试" };
    $("#ideInstallations").innerHTML = data.installations?.length ? data.installations.map(item => `<article class="ide-instance"><div><strong>${escapeHtml(labels[item.phase] || item.phase)}</strong><p>${escapeHtml(item.hostId)} · ${escapeHtml(item.version)}${item.total ? ` · ${Math.round((item.bytes || 0) / 1048576)} / ${Math.round(item.total / 1048576)} MB` : ""}</p>${item.error ? `<p class="ide-error">${escapeHtml(item.error)}</p>` : ""}</div></article>`).join("") : '<p>暂无安装任务。自动安装需先保存主机授权。</p>';
    requests = data.accessRequests || [];
    if (data.authorization?.sessionTtlDays) sessionDuration = `${data.authorization.sessionTtlDays} 天`;
    $("#ideSessionDuration").textContent = sessionDuration;
    renderRequests();
    renderInstances(data.instances || []);
    const states = { starting: "正在启动", connecting: "正在连接", ready: "已就绪", reconnecting: "正在自动重连", error: "连接失败，后台重试" };
    const markup = data.endpoints?.length ? data.endpoints.map(endpoint => `<article class="ide-instance"><div><strong>${escapeHtml(endpoint.shared ? `共享浏览器入口 · ${endpoint.hostId}` : endpoint.hostId === "local" ? "本机维护入口 · 仅本机浏览器" : endpoint.hostId)}</strong><p role="status">${escapeHtml(states[endpoint.state] || endpoint.state)}</p><p>${escapeHtml(endpoint.publicOrigin)}</p>${endpoint.error ? `<p class="ide-error">${escapeHtml(endpoint.error)}</p>` : ""}</div></article>`).join("") : '<p>未配置固定远程入口。入口不可达时不会改发其他地址。</p>';
    if (markup !== endpointMarkup) { endpointMarkup = markup; $("#ideEndpoints").innerHTML = markup; }
  }
  function renderApprovers(data) {
    const options = (data.accounts || []).map(account => `<option value="${escapeAttr(JSON.stringify(account))}">${escapeHtml(account.accountId)} · ${escapeHtml(account.channel)}</option>`).join("");
    if (options !== approverAccountsMarkup && !approverBusy) {
      const select = $("#ideApproverAccount"), value = select.value;
      select.innerHTML = options; approverAccountsMarkup = options;
      if ([...(data.accounts || [])].some(account => JSON.stringify(account) === value)) select.value = value;
    }
    const markup = data.error ? `<p class="ide-error">${escapeHtml(data.error)}</p>` : data.owners?.length ? data.owners.map(owner =>
      `<article class="ide-instance"><div><strong>${escapeHtml(owner.accountId)} · ${escapeHtml(owner.channel)}</strong>${window.gatewayCopy.field("个人 ID", owner.actorId)}</div><button type="button" class="button button-secondary" data-ide-approver-remove="${escapeAttr(JSON.stringify(owner))}">移除审批资格</button></article>`).join("") : "<p>尚未登记管理员。跨设备审批尚不可用；本机网页审批不受影响。</p>";
    if (!approverBusy && markup !== approverMarkup) { approverMarkup = markup; $("#ideApprovers").innerHTML = markup; }
    $("#ideApproverAdd").disabled = approverBusy || Boolean(data.error) || !data.accounts?.length;
  }
  async function saveApprover(principal, remove = false) {
    if (approverBusy) return;
    if (!window.confirm(remove ? `移除 ${principal.actorId} 的 IDE 审批资格？待确认审批立即失效，已有浏览器授权不自动撤销。`
      : `请确认这是你本人的个人 ID：${principal.actorId}\n渠道账号：${principal.accountId} · ${principal.channel}\n该身份将可批准本账号项目的浏览器访问及开发终端权限。不要添加群 ID 或陌生人。继续登记？`)) return;
    approverBusy = true; $("#ideApproverAdd").disabled = true;
    const status = $("#ideApproverStatus"); status.textContent = "正在保存审批资格…";
    try {
      const result = await api("/api/ide/approvers", { method: "POST", body: { principal, remove } });
      if (current?.approvers) current.approvers.owners = result.owners;
      status.textContent = remove ? "已移除审批资格，待确认审批已失效；如需撤销已签发访问，请另行撤销浏览器授权。" : "已登记并持久保存。其他设备打开 IDE 后，请在机器人钉钉私聊发送 /ide auth 六位识别码。无需该私聊绑定 session。";
      status.classList.remove("ide-error");
    } catch (error) { status.textContent = `未保存：${error.message}。原审批配置未改变，请检查后重试。`; status.classList.add("ide-error"); }
    finally { approverBusy = false; if (current?.approvers) renderApprovers(current.approvers); else $("#ideApproverAdd").disabled = false; }
  }
  function routingFields() {
    const perHost = $("#idePerHostRouting").checked;
    $("#ideSharedIngressHost").disabled = !perHost;
    $("#ideTLSLegacyFields").hidden = perHost; $("#ideOrigin").readOnly = perHost;
    if (perHost) { $("#ideOrigin").value = `http://127.0.0.1:${$("#idePort").value}`; $("#ideTLSEnabled").checked = false; }
  }
  function renderInstances(instances) {
    const labels = { checking: "正在核验实际安装", installing: "正在安装缺失扩展", ready: "所选扩展已安装并核验", error: "扩展未就绪，可重试" };
    const markup = instances.length ? instances.map(instance => {
      const p = instance.profile;
      const profile = p ? `<p role="status">${escapeHtml(labels[p.phase] || p.phase)}${p.activeExtension ? `：${escapeHtml(p.activeExtension)}` : ""}</p>${p.installed?.length ? `<small>已安装：${p.installed.map(item => `${escapeHtml(item.id)} @ ${escapeHtml(item.version)}`).join("、")}</small>` : ""}${p.missing?.length ? `<p>未就绪：${p.missing.map(escapeHtml).join("、")}</p>` : ""}${p.warning ? `<p class="ide-error">${p.warning === "settings-unmodified" ? "IDE 设置无法安全补充，原文件未改动。请检查 settings.json。" : "扩展准备失败，编辑器仍可使用；请检查 Open VSX 网络、扩展兼容性及目录权限，停止该 IDE 后重试准备扩展。"}</p>` : ""}` : "<p>尚未核验扩展；下次启动时检查。</p>";
      return `<article class="ide-instance"><div><strong>${escapeHtml(instance.status)}</strong><p>${escapeHtml(instance.hostId)} · ${escapeHtml(instance.workspace)}</p>${profile}${instance.error ? `<p class="ide-error">${escapeHtml(instance.error)}</p>` : ""}</div><button class="button button-secondary" data-ide-stop="${escapeAttr(instance.id)}" ${["starting", "stopped"].includes(instance.status) ? "disabled" : ""}>停止 IDE</button></article>`;
    }).join("") : '<p class="empty-state">尚无 IDE 实例。保存后从会话中的「Web IDE」进入。</p>';
    if (markup !== instanceMarkup) { instanceMarkup = markup; $("#ideInstances").innerHTML = markup; }
  }
  function renderRequests() {
    // Polling must not replace the clicked/focused button or an in-flight
    // confirmation. Keep the exact request snapshot until the operation ends.
    const items = [...requests.filter(item => !receipts.has(item.id)), ...receipts.values()];
    const markup = items.length ? items.map(item => {
      const button = (trust, label) => `<button type="button" class="button button-secondary" data-ide-approve="${escapeAttr(item.id)}" data-ide-entry="${escapeAttr(item.entryId)}" data-ide-code="${escapeAttr(item.code)}" data-ide-trust="${trust}">${label}</button>`;
      return `<article class="ide-instance" data-ide-request="${escapeAttr(item.id)}"><div>${window.gatewayCopy.field("浏览器识别码", item.code)}<p>${escapeHtml(item.projectName)} · ${escapeHtml(item.hostId)}</p><p>${escapeHtml(item.workspace)}</p><small>申请有效至 ${escapeHtml(new Date(item.expiresAt).toLocaleTimeString())}；新授权有效期 ${escapeHtml(sessionDuration)}，重启不丢失。</small></div><div class="ide-approval-actions">${item.approved ? `<p role="status">已批准${item.trustWorkspace ? "并信任此目录" : "访问"}。原浏览器将自动继续；若仍在等待，请在原页点击「批准后继续」。</p>` : button(true, "批准并信任此目录") + button(false, "仅批准访问")}</div></article>`;
    }).join("") : '<p>没有待批准的浏览器。</p>';
    if (approval || requestMarkup === markup) return;
    requestMarkup = markup; $("#ideAccessRequests").innerHTML = markup;
  }
  function beginApproval(button) {
    if (approval) return;
    const request = requests.find(item => item.id === button.dataset.ideApprove && item.entryId === button.dataset.ideEntry);
    if (!request || request.expiresAt <= Date.now()) { toast("申请已过期，请在原浏览器刷新并核对新识别码"); return; }
    const panel = button.closest(".ide-approval-actions");
    approval = { ...request, trustWorkspace: button.dataset.ideTrust === "true", panel, pending: false };
    panel.innerHTML = `<p>请核对原浏览器识别码 <strong>${escapeHtml(request.code)}</strong>，只批准你本人发起的申请。授权有效期 ${escapeHtml(sessionDuration)}。</p><p>${approval.trustWorkspace ? "同时允许上方精确目录的任务、调试和扩展运行；只影响项目专属 IDE，不修改全局 VS Code 设置。" : "允许当前项目的文件编辑和终端访问；不自动信任目录代码。"}</p><p data-ide-approval-status role="status"></p><button type="button" class="button button-primary" data-ide-confirm>确认${approval.trustWorkspace ? "批准并信任" : "仅批准访问"}</button><button type="button" class="button button-secondary" data-ide-cancel>取消</button>`;
    panel.querySelector("[data-ide-cancel]").focus();
  }
  async function confirmApproval() {
    const selected = approval; if (!selected || selected.pending) return;
    const status = selected.panel.querySelector("[data-ide-approval-status]");
    if (selected.expiresAt <= Date.now()) { status.textContent = "申请已过期，请在原浏览器刷新，并取消此确认后核对新识别码。"; status.classList.add("ide-error"); return; }
    selected.pending = true;
    for (const button of selected.panel.querySelectorAll("button")) button.disabled = true;
    status.classList.remove("ide-error"); status.textContent = "正在核对项目目录并批准，请稍候…";
    try {
      await api("/api/ide/access/approve", { method: "POST", body: { requestId: selected.id, entryId: selected.entryId, trustWorkspace: selected.trustWorkspace } });
      receipts.set(selected.id, { ...selected, approved: true });
      // Retain only this page's latest receipts, never browser credentials.
      if (receipts.size > 20) receipts.delete(receipts.keys().next().value);
      approval = undefined; renderRequests();
      message(`已批准此浏览器，原页面将自动继续。新授权有效期 ${sessionDuration}，重启保留；可随时撤销。`);
      toast("浏览器已批准，原页面将自动继续");
    } catch (error) {
      selected.pending = false;
      status.textContent = `未能批准：${error.message}。请核对申请是否过期后重试。`; status.classList.add("ide-error");
      for (const button of selected.panel.querySelectorAll("button")) button.disabled = false;
      toast(`IDE 授权失败：${error.message}`);
    }
  }
  async function refresh() {
    if (busy) return;
    try {
      current = await api("/api/ide"); const config = current.config;
      $("#ideEnabled").checked = config.enabled; $("#ideOrigin").value = config.publicOrigin; $("#idePort").value = config.port;
      $("#idePerHostRouting").checked = config.routing === "per-host";
      const ingressHosts = config.hosts.filter(host => host.hostId !== "local");
      $("#ideSharedIngressHost").innerHTML = '<option value="">未选择：按项目主机分别生成链接</option>' + ingressHosts.map(host => `<option value="${escapeAttr(host.hostId)}">${escapeHtml(host.hostId)}${host.enabled && host.access ? "" : "（需启用并配置固定 HTTPS）"}</option>`).join("");
      $("#ideSharedIngressHost").value = config.sharedIngressHostId || "";
      const addresses = [...(current.networkAddresses || [])];
      if (config.tls && !addresses.some(item => item.address === config.tls.bindAddress)) addresses.unshift({ name: "已配置，当前不在线", address: config.tls.bindAddress });
      $("#ideTLSAddress").innerHTML = addresses.map(item => `<option value="${escapeAttr(item.address)}" ${config.tls?.bindAddress === item.address ? "selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.address)}</option>`).join("");
      $("#ideTLSEnabled").checked = Boolean(config.tls); $("#ideTLSCert").value = config.tls?.certFile || ""; $("#ideTLSKey").value = config.tls?.keyFile || "";
      showCertificate(current.certificate);
      $("#ideProfile").value = JSON.stringify(config.profile.settings, null, 2);
      $("#ideHosts").innerHTML = current.hosts.map(hostId => {
        const host = config.hosts.find(h => h.hostId === hostId);
        const access = host?.access;
        const entrance = hostId === "local" ? "" : `<label class="ide-access-field">固定 HTTPS 入口<input type="url" data-ide-access-origin="${escapeAttr(hostId)}" value="${escapeAttr(access?.publicOrigin || "")}" placeholder="https://固定IP:映射端口"></label><label class="ide-access-field">远程容器 / 主机的精确监听 IP<input type="text" data-ide-access-bind="${escapeAttr(hostId)}" value="${escapeAttr(access?.bindAddress || "")}" placeholder="远程实际网卡地址，不是宿主机映射 IP"></label><label class="ide-access-field">映射到的远程监听端口<input type="number" min="1" max="65535" data-ide-access-port="${escapeAttr(hostId)}" value="${access?.port || ""}"></label><small>仅分主机模式生效。三个字段需一起填写；空白表示此主机不提供远程入口。Gateway 不创建 Docker 映射、不修改 sshd、不使用 sudo；固定映射需已配置。</small>`;
        return `<div class="ide-host"><label><input type="checkbox" data-ide-host="${escapeAttr(hostId)}" ${host?.enabled ? "checked" : ""}>${escapeHtml(hostId === "local" ? "本机" : hostId)}</label><input aria-label="${escapeAttr(hostId)} code-server 可执行文件" data-ide-binary="${escapeAttr(hostId)}" value="${escapeAttr(host?.binary || "code-server")}" placeholder="code-server 或绝对路径"><label><input type="checkbox" data-ide-auto="${escapeAttr(hostId)}" ${host?.autoInstall ? "checked" : ""}>缺失时自动安装（用户目录）</label><button type="button" class="button button-secondary" data-ide-install="${escapeAttr(hostId)}">检测 / 安装 / 重试</button>${entrance}</div>`;
      }).join("");
      routingFields();
      $("#ideExtensions").innerHTML = current.extensionChoices.map(id => `<label><input type="checkbox" value="${escapeAttr(id)}" ${config.profile.extensions.includes(id) ? "checked" : ""}>${escapeHtml(id)}</label>`).join("");
      message(current.error || (current.running ? "IDE 访问入口已就绪；实例按需启动。" : "未启用 IDE 访问入口，IM 与 Codex 不受影响。"), Boolean(current.error));
      renderActivity(current);
    } catch (error) { message(error.message, true); }
  }
  async function save(event) {
    event.preventDefault(); if (busy || !current) return;
    const button = $("#ideSave"); busy = true; button.disabled = true;
    try {
      const perHost = $("#idePerHostRouting").checked;
      const accessFor = hostId => {
        const value = (selector, key) => [...document.querySelectorAll(selector)].find(el => el.dataset[key] === hostId)?.value.trim() || "";
        const publicOrigin = value("[data-ide-access-origin]", "ideAccessOrigin"), bindAddress = value("[data-ide-access-bind]", "ideAccessBind"), port = value("[data-ide-access-port]", "ideAccessPort");
        if (!perHost || !(publicOrigin || bindAddress || port)) return {};
        if (!publicOrigin || !bindAddress || !port) throw new Error(`${hostId} 的远程入口三个字段必须一起填写`);
        return { access: { publicOrigin, bindAddress, port: Number(port) } };
      };
      const hosts = [...document.querySelectorAll("[data-ide-host]")].map(input => ({ hostId: input.dataset.ideHost, enabled: input.checked, ...accessFor(input.dataset.ideHost),
        autoInstall: [...document.querySelectorAll("[data-ide-auto]")].find(el => el.dataset.ideAuto === input.dataset.ideHost).checked,
        binary: [...document.querySelectorAll("[data-ide-binary]")].find(el => el.dataset.ideBinary === input.dataset.ideHost).value.trim() }));
      const config = { enabled: $("#ideEnabled").checked, port: Number($("#idePort").value), publicOrigin: perHost ? `http://127.0.0.1:${Number($("#idePort").value)}` : $("#ideOrigin").value.trim(), hosts,
        ...(perHost ? { routing: "per-host", ...($("#ideSharedIngressHost").value ? { sharedIngressHostId: $("#ideSharedIngressHost").value } : {}) } : {}),
        ...(!perHost && $("#ideTLSEnabled").checked ? { tls: { bindAddress: $("#ideTLSAddress").value, certFile: $("#ideTLSCert").value.trim(), keyFile: $("#ideTLSKey").value.trim() } } : {}),
        profile: { settings: JSON.parse($("#ideProfile").value), extensions: [...document.querySelectorAll("#ideExtensions input:checked")].map(el => el.value) } };
      const previous = current.config;
      const affectsExisting = previous.enabled && (!config.enabled || previous.routing !== config.routing
        || previous.sharedIngressHostId !== config.sharedIngressHostId || previous.port !== config.port || previous.publicOrigin !== config.publicOrigin
        || JSON.stringify(previous.tls) !== JSON.stringify(config.tls) || JSON.stringify(previous.profile) !== JSON.stringify(config.profile)
        || previous.hosts.filter(h => h.enabled).some(h => { const next = hosts.find(n => n.hostId === h.hostId);
          return !next?.enabled || next.binary !== h.binary || JSON.stringify(next.access) !== JSON.stringify(h.access); }));
      if (affectsExisting && current.instances.some(i => ["starting", "running"].includes(i.status))
        && !window.confirm("本次修改可能断开受影响主机或入口的 IDE 终端并撤销对应授权；其他主机不受影响。请先保存相关编辑内容。不停止 Codex 任务，继续？")) return;
      message("正在按差异应用配置，保留未变更的入口、实例与授权…");
      const result = await api("/api/ide/config", { method: "PUT", body: { config } });
      current.config = result?.config || config;
      receipts.clear();
      message("配置已按差异应用。新增主机无需重启 Gateway；未变更的入口、实例及授权保留。请查看下方各入口状态。");
    } catch (error) { message(error.message, true); }
    finally { busy = false; button.disabled = false; }
  }
  async function open(prepare = false) {
    if (opening) return;
    const session = selectedSession();
    if (!session?.projectId || session.projectBinding === "none") { toast("请先选择有项目的 session"); return; }
    opening = true;
    const buttons = [$("#sessionIDEButton"), $("#sessionIDEPrepareButton")]; buttons.forEach(button => { button.disabled = true; });
    let tab;
    try {
      tab = prepare ? undefined : window.open("about:blank", "_blank"); if (tab) tab.opener = null;
      const entry = await api("/api/ide/entry", { method: "POST", body: { accountId: session.accountId, sessionId: session.id } });
      if (prepare) {
        if (!window.confirm("将核验并从 Open VSX 安装该实例缺失的所选扩展；已安装的不会重复下载。需先停止对应 IDE，不会提交 Codex 任务。继续？")) return;
        toast("正在准备扩展，请勿重复操作…");
        await api(`/api/ide/workspaces/${entry.id}/prepare`, { method: "POST", body: { trustWorkspace: true } }); toast("授权并信任目录的 IDE 实例扩展准备完成");
      } else if (tab) {
        const grant = await api("/api/ide/access", { method: "POST", body: { entryId: entry.id, trustWorkspace: true } });
        // Form POST keeps the one-use credential out of URLs, history and logs.
        const doc = tab.document, form = doc.createElement("form"); form.method = "post"; form.action = grant.action;
        for (const [name, value] of Object.entries({ entryId: grant.entryId, token: grant.token })) {
          const field = doc.createElement("input"); field.type = "hidden"; field.name = name; field.value = value; form.append(field);
        }
        doc.body.append(form); form.submit();
      } else toast("浏览器阻止了新窗口，请允许弹窗后重试。");
    } catch (error) { tab?.close(); toast(error.message); }
    finally { opening = false; buttons.forEach(button => { button.disabled = false; }); }
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("#ideApproverForm").addEventListener("submit", event => {
      event.preventDefault();
      try {
        const account = JSON.parse($("#ideApproverAccount").value), actorId = $("#ideApproverActor").value.trim();
        if (!actorId || /\s/.test(actorId)) throw new Error("请填写从 /ide identity 核对的个人 ID，不含空格");
        void saveApprover({ ...account, actorId });
      } catch (error) { $("#ideApproverStatus").textContent = error.message; }
    });
    $("#ideApprovers").addEventListener("click", event => {
      const button = event.target.closest("[data-ide-approver-remove]");
      if (button) void saveApprover(JSON.parse(button.dataset.ideApproverRemove), true);
    });
    $("#ideForm").addEventListener("submit", save);
    $("#ideRefresh").addEventListener("click", () => void refresh());
    $("#idePerHostRouting").addEventListener("change", routingFields);
    $("#idePort").addEventListener("input", routingFields);
    $("#ideTLSGenerate").addEventListener("click", () => void prepareTLS());
    $("#ideRevoke").addEventListener("click", async () => { try { await api("/api/ide/revoke", { method: "POST" }); message("全部 IDE 浏览器登录和连接已撤销。"); } catch (error) { message(error.message, true); } });
    $("#ideHosts").addEventListener("click", async event => {
      const button = event.target.closest("[data-ide-install]"); if (!button) return;
      button.disabled = true;
      try { await api("/api/ide/install", { method: "POST", body: { hostId: button.dataset.ideInstall } }); message("主机准备已开始，可在下方查看进度；重复点击不会重复安装。"); }
      catch (error) { message(error.message, true); } finally { button.disabled = false; }
    });
    $("#ideAccessRequests").addEventListener("click", async event => {
      if (event.target.closest("[data-ide-cancel]")) { if (approval?.pending) return; approval = undefined; requestMarkup = ""; renderRequests(); return; }
      if (event.target.closest("[data-ide-confirm]")) { await confirmApproval(); return; }
      const button = event.target.closest("[data-ide-approve]"); if (!button) return;
      beginApproval(button);
    });
    $("#sessionIDEButton").addEventListener("click", () => void open());
    $("#sessionIDEPrepareButton").addEventListener("click", () => void open(true));
    $("#ideInstances").addEventListener("click", async event => {
      const button = event.target.closest("[data-ide-stop]"); if (!button) return;
      if (!window.confirm("停止该 IDE 将断开编辑器与其终端，不停止 Codex 任务。确认？")) return;
      button.disabled = true;
      try { await api(`/api/ide/instances/${button.dataset.ideStop}/stop`, { method: "POST" }); await refresh(); }
      catch (error) { message(error.message, true); button.disabled = false; }
    });
  });
  setInterval(async () => {
    if (busy || $("#ideView")?.hidden || document.hidden) return;
    try { renderActivity(await api("/api/ide")); } catch { /* Explicit refresh shows connectivity errors. */ }
  }, 3000);
  return { refresh };
})();
