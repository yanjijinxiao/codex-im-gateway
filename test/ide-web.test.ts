import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/web/ide.js", import.meta.url), "utf8");
const request = { id: "request-one", entryId: "project-one", code: "123456", expiresAt: Date.now() + 300_000,
  projectName: "<project>", hostId: "local", workspace: "/exact/project" };
function fixture(api: (...args: any[]) => Promise<unknown> = async () => ({})) {
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", textContent: "", disabled: false,
      classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, focus() {} });
    return nodes.get(selector);
  };
  const escape = (v: unknown) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const context = vm.createContext({ window: { confirm() { throw new Error("Native confirmation must not gate approval"); } },
    document: { querySelector: (selector: string) => selector === "[data-ide-wait]" ? null : node(selector), addEventListener() {} }, setInterval() {}, api, escapeHtml: escape, escapeAttr: escape, toast() {} });
  vm.runInContext(fs.readFileSync(new URL("../src/web/copyable.js", import.meta.url), "utf8"), context);
  vm.runInContext(source.replace("return { refresh };", "return { refresh, renderActivity, beginApproval, confirmApproval, prepareTLS, open, save };"), context);
  const ui = context.window.gatewayIDE;
  const panel = { innerHTML: "", querySelector: node, querySelectorAll: () => [node("confirm"), node("cancel")] };
  const button = { dataset: { ideApprove: request.id, ideEntry: request.entryId, ideTrust: "true" }, closest: () => panel };
  const data = { accessRequests: [request], installations: [], authorization: { sessionTtlDays: 15 } };
  return { ui, panel, button, data, node, context };
}

test("approval uses a visible exact-request confirmation and polling preserves its DOM", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { ui, panel, button, data, node } = fixture(async (url, options) => {
    assert.equal(url, "/api/ide/access/approve");
    assert.deepEqual(JSON.parse(JSON.stringify(options.body)), { requestId: request.id, entryId: request.entryId, trustWorkspace: true });
    calls++; await gate;
  });
  ui.renderActivity(data); assert.equal(node("#ideSessionDuration").textContent, "15 天");
  assert.match(node("#ideAccessRequests").innerHTML, /&lt;project&gt;/);
  node("#ideAccessRequests").innerHTML = "retained node identity";
  ui.renderActivity(data); assert.equal(node("#ideAccessRequests").innerHTML, "retained node identity");
  ui.beginApproval(button); assert.equal(calls, 0); assert.match(panel.innerHTML, /123456/); assert.match(panel.innerHTML, /data-ide-confirm/);
  const operation = ui.confirmApproval(); await ui.confirmApproval(); assert.equal(calls, 1);
  assert.match(node("[data-ide-approval-status]").textContent, /正在核对/);
  ui.renderActivity({ ...data, accessRequests: [] }); assert.equal(node("#ideAccessRequests").innerHTML, "retained node identity");
  release(); await operation;
  assert.match(node("#ideAccessRequests").innerHTML, /已批准并信任/);
  assert.match(node("#ideAccessRequests").innerHTML, /123456/);
});

test("owner registration UI escapes identity data and polling preserves inputs without granting access", () => {
  const { ui, data, node } = fixture();
  const approvers = { owners: [{ accountId: "<account>", channel: "dingtalk", providerId: "client", actorId: "<owner>" }],
    accounts: [{ accountId: "<account>", channel: "dingtalk", providerId: "client" }] };
  ui.renderActivity({ ...data, approvers });
  assert.match(node("#ideApprovers").innerHTML, /&lt;owner&gt;/); assert.doesNotMatch(node("#ideApprovers").innerHTML, /<owner>/);
  assert.match(node("#ideApprovers").innerHTML, /移除审批资格/);
  node("#ideApproverActor").value = "draft-owner"; node("#ideApproverAccount").innerHTML = "stable select";
  ui.renderActivity({ ...data, approvers }); assert.equal(node("#ideApproverActor").value, "draft-owner");
  assert.equal(node("#ideApproverAccount").innerHTML, "stable select");
  ui.renderActivity({ ...data, approvers: { ...approvers, error: "<corrupt>" } });
  assert.equal(node("#ideApproverAdd").disabled, true); assert.match(node("#ideApprovers").innerHTML, /&lt;corrupt&gt;/);
});

test("approval failure stays beside the clicked request and permits an explicit retry", async () => {
  let calls = 0;
  const { ui, button, data, node } = fixture(async () => { calls++; if (calls === 1) throw new Error("原生目录核对超时"); });
  ui.renderActivity(data); ui.beginApproval(button); await ui.confirmApproval();
  assert.match(node("[data-ide-approval-status]").textContent, /原生目录核对超时/);
  assert.equal(node("confirm").disabled, false);
  await ui.confirmApproval(); assert.equal(calls, 2); assert.match(node("#ideAccessRequests").innerHTML, /已批准/);
});

test("certificate generation is deduplicated, stages explicit TLS config and never applies it or changes system trust", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { ui, node } = fixture(async (url, options) => {
    if (url === "/api/ide") return { config: { enabled: false, port: 8790, publicOrigin: "http://127.0.0.1:8790", hosts: [], profile: { settings: {}, extensions: [] } }, hosts: [], extensionChoices: [], instances: [] };
    assert.equal(url, "/api/ide/tls/prepare"); assert.equal(options.body.address, "30.1.2.3"); calls++; await gate;
    return { tls: { certFile: "/private/server.crt", keyFile: "/private/server.key" }, certificate: { managed: true, expiresAt: "2027-10-24", caFingerprint256: "AA:BB", caExpiresAt: "2031-10-24" } };
  });
  await ui.refresh(); node("#ideTLSAddress").value = "30.1.2.3"; node("#idePort").value = "8790";
  const operation = ui.prepareTLS(); await ui.prepareTLS(); assert.equal(calls, 1); assert.equal(node("#ideSave").disabled, true);
  assert.equal(node("#ideTLSAddress").disabled, true);
  release(); await operation;
  assert.equal(node("#ideTLSEnabled").checked, true); assert.equal(node("#ideOrigin").value, "https://30.1.2.3:8790");
  assert.equal(node("#ideTLSKey").value, "/private/server.key"); assert.equal(node("#ideTLSDownload").hidden, false);
  assert.match(node("#ideMessage").textContent, /尚未启用 HTTPS/); assert.equal(node("#ideSave").disabled, false);
  assert.equal(node("#ideTLSAddress").disabled, false);
});

test("instance progress shows actual installed versions, missing extensions and safe retry text without replacing stable DOM", () => {
  const { ui, node, data } = fixture();
  const instance = { id: "example", hostId: "remote:test", workspace: "/project", status: "starting",
    profile: { phase: "installing", activeExtension: "tuttieee.emacs-mcx", requested: ["tuttieee.emacs-mcx"], installed: [], missing: ["tuttieee.emacs-mcx"] } };
  ui.renderActivity({ ...data, instances: [instance] });
  assert.match(node("#ideInstances").innerHTML, /正在安装缺失扩展/);
  assert.match(node("#ideInstances").innerHTML, /未就绪：tuttieee.emacs-mcx/);
  node("#ideInstances").innerHTML = "stable DOM";
  ui.renderActivity({ ...data, instances: [instance] }); assert.equal(node("#ideInstances").innerHTML, "stable DOM");
  ui.renderActivity({ ...data, instances: [{ ...instance, status: "running", profile: { ...instance.profile, phase: "error", warning: "extensions-unavailable" } }] });
  assert.match(node("#ideInstances").innerHTML, /扩展准备失败，编辑器仍可使用/);
  ui.renderActivity({ ...data, instances: [{ ...instance, status: "running", profile: { phase: "ready", installed: [{ id: "tuttieee.emacs-mcx", version: "0.100.1" }], missing: [] } }] });
  assert.match(node("#ideInstances").innerHTML, /tuttieee.emacs-mcx @ 0.100.1/);
  assert.doesNotMatch(node("#ideInstances").innerHTML, /未就绪/);
  ui.renderActivity({ ...data, instances: [{ ...instance, profile: { ...instance.profile, warning: "settings-unmodified" } }] });
  assert.match(node("#ideInstances").innerHTML, /原文件未改动/);
});

test("per-host management keeps local loopback read-only and exposes exact remote mapping fields", async () => {
  const { ui, node } = fixture(async () => ({ config: { enabled: true, routing: "per-host", port: 8790, publicOrigin: "http://127.0.0.1:8790",
    hosts: [{ hostId: "local", enabled: true, binary: "code-server" }, { hostId: "remote:test", enabled: true, binary: "code-server",
      access: { publicOrigin: "https://203.0.113.10:20015", bindAddress: "192.168.5.3", port: 80 } }], profile: { settings: {}, extensions: [] } },
    hosts: ["local", "remote:test"], extensionChoices: [], instances: [], endpoints: [] }));
  await ui.refresh(); assert.equal(node("#ideOrigin").value, "http://127.0.0.1:8790");
  assert.equal(node("#ideOrigin").readOnly, true); assert.equal(node("#ideTLSLegacyFields").hidden, true);
  assert.match(fs.readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8"), /\.ide-form \.ide-tls\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(node("#ideHosts").innerHTML, /https:\/\/203\.0\.113\.10:20015/);
  assert.match(node("#ideHosts").innerHTML, /192\.168\.5\.3/); assert.match(node("#ideHosts").innerHTML, /data-ide-access-port/);
});

test("endpoint polling reports per-host reconnect failures safely without replacing unchanged status", () => {
  const { ui, node, data } = fixture();
  const endpoints = [{ hostId: "remote:<test>", state: "reconnecting", publicOrigin: "https://203.0.113.10:20015", error: "<offline>" }];
  ui.renderActivity({ ...data, endpoints }); const markup = node("#ideEndpoints").innerHTML;
  assert.match(markup, /正在自动重连/); assert.match(markup, /&lt;offline&gt;/); assert.doesNotMatch(markup, /<offline>/);
  node("#ideEndpoints").innerHTML = "stable DOM"; ui.renderActivity({ ...data, endpoints }); assert.equal(node("#ideEndpoints").innerHTML, "stable DOM");
});

test("shared ingress management retains its selection, distinguishes the maintenance listener, and saves publication separately from project hosts", async () => {
  const config={ enabled:true,routing:"per-host",sharedIngressHostId:"remote:test",port:8790,publicOrigin:"http://127.0.0.1:8790",
    hosts:[{hostId:"local",enabled:true,binary:"code-server"},{hostId:"remote:test",enabled:true,binary:"code-server",access:{publicOrigin:"https://203.0.113.10:20015",bindAddress:"192.168.5.3",port:80}}],profile:{settings:{},extensions:[]} };
  let saved:any;
  const {ui,node,context}=fixture(async(url,options)=>{
    if(url==="/api/ide")return {config,hosts:["local","remote:test","remote:new"],extensionChoices:[],instances:[{status:"running",hostId:"local"}]};
    assert.equal(url,"/api/ide/config");saved=options.body.config;
  });
  await ui.refresh();assert.equal(node("#ideSharedIngressHost").value,"remote:test");
  assert.equal(node("#ideSharedIngressHost").disabled,false);
  assert.match(node("#ideSharedIngressHost").innerHTML,/remote:test/);
  ui.renderActivity({endpoints:[{hostId:"remote:test",shared:true,state:"ready",publicOrigin:"https://203.0.113.10:20015"}]});
  assert.match(node("#ideEndpoints").innerHTML,/共享浏览器入口/);
  assert.equal(node("#ideSharedIngressHost").value,"remote:test","polling cannot discard publication selection");
  context.document.querySelectorAll=(selector:string)=>{
    if(selector==="[data-ide-host]")return ["local","remote:test","remote:new"].map(hostId=>({dataset:{ideHost:hostId},checked:true}));
    if(selector==="[data-ide-binary]")return ["local","remote:test","remote:new"].map(hostId=>({dataset:{ideBinary:hostId},value:"code-server"}));
    if(selector==="[data-ide-auto]")return ["local","remote:test","remote:new"].map(hostId=>({dataset:{ideAuto:hostId},checked:false}));
    const fields:any={"[data-ide-access-origin]":["ideAccessOrigin","https://203.0.113.10:20015"],"[data-ide-access-bind]":["ideAccessBind","192.168.5.3"],"[data-ide-access-port]":["ideAccessPort","80"]};
    return fields[selector]?[{dataset:{[fields[selector][0]]:"remote:test"},value:fields[selector][1]}]:[];
  };
  await ui.save({preventDefault(){}});
  assert.equal(saved.sharedIngressHostId,"remote:test");assert.equal(saved.publicOrigin,"http://127.0.0.1:8790");
  assert.equal(saved.hosts[0].access,undefined);assert.equal(saved.hosts[1].access.publicOrigin,"https://203.0.113.10:20015");
  assert.equal(saved.hosts[2].hostId,"remote:new");assert.equal(saved.hosts[2].access,undefined,"a new shared backend requires no new Web mapping");
  assert.match(node("#ideMessage").textContent,/新增主机无需重启/);
  assert.doesNotMatch(node("#ideMessage").textContent,/旧浏览器授权.*已撤销/);
});

test("session extension preparation deduplicates clicks and releases controls on failure", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { ui, node, context } = fixture(async (url, options) => {
    calls++;
    if (url === "/api/ide/entry") { await gate; return { id: "entry" }; }
    assert.equal(url, "/api/ide/workspaces/entry/prepare"); assert.equal(options.body.trustWorkspace, true);
    throw new Error("fixture preparation failure");
  });
  context.selectedSession = () => ({ id: "session", accountId: "account", projectId: "project" });
  context.window.confirm = () => true;
  const operation = ui.open(true); await ui.open(true);
  assert.equal(calls, 1); assert.equal(node("#sessionIDEPrepareButton").disabled, true);
  release(); await operation; assert.equal(calls, 2);
  assert.equal(node("#sessionIDEPrepareButton").disabled, false); assert.equal(node("#sessionIDEButton").disabled, false);
});

test("local multi-root approval shows reference directories without copy controls and submits the exact displayed scope", async () => {
  const calls: any[] = [], scope = "a".repeat(64), roots = ["/bridge", "/farming"];
  const { ui, context } = fixture(async (url, options) => {
    calls.push({ url, body: options.body });
    if (url === "/api/ide/entry") return { id: "entry", rootPaths: roots, scope };
    assert.equal(url, "/api/ide/access"); return { entryId: "entry", action: "/authorize", token: "fixture" };
  });
  let close!: () => void, submitted = 0, show!: () => void;
  const shown = new Promise<void>(resolve => { show = resolve; });
  const dialog: any = { returnValue: "", innerHTML: "", className: "", showModal() { show(); }, remove() {},
    addEventListener(event: string, listener: () => void) { if (event === "close") close = listener; } };
  context.document.createElement = () => dialog; context.document.body = { append() {} };
  context.selectedSession = () => ({ id: "session", accountId: "account", projectId: "project" });
  context.window.open = () => ({ close() {}, document: { body: { append() {} }, createElement: () => ({ append() {}, submit() { submitted++; } }) } });
  const operation = ui.open(); await shown;
  assert.equal(calls.length, 1, "showing/copying scope must not grant access");
  assert.match(dialog.innerHTML, /\/bridge/); assert.match(dialog.innerHTML, /\/farming/);
  assert.equal((dialog.innerHTML.match(/data-copy-value/g) || []).length, 0);
  assert.match(dialog.innerHTML, /ide-root-list/);
  dialog.returnValue = "approve"; close(); await operation;
  assert.equal(calls[1].body.scope, scope); assert.equal(submitted, 1);
});

test("local direct management preserves its independent binding on save, including an offline selected address", async () => {
  const localAccess = { publicOrigin: "https://30.1.2.3:8790", bindAddress: "30.1.2.3", port: 8790 };
  const config = { enabled: true, routing: "per-host", sharedIngressHostId: "remote:test", port: 8790, publicOrigin: "http://127.0.0.1:8790", localAccess,
    hosts: [{ hostId: "local", enabled: true, binary: "code-server" }], profile: { settings: {}, extensions: [] } };
  let saved: any;
  const { ui, node, context } = fixture(async (url, options) => {
    if (url === "/api/ide") return { config, hosts: ["local"], networkAddresses: [], extensionChoices: [], instances: [] };
    assert.equal(url, "/api/ide/config"); saved = options.body.config;
  });
  await ui.refresh(); assert.equal(node("#ideLocalAccessFields").hidden, false);
  assert.equal(node("#ideLocalDirectEnabled").checked, true);
  assert.match(node("#ideLocalDirectAddress").innerHTML, /已配置，当前不在线/);
  assert.equal(node("#ideLocalDirectAddress").value, localAccess.bindAddress);
  context.document.querySelectorAll = (selector: string) => selector === "[data-ide-host]" ? [{ dataset: { ideHost: "local" }, checked: true }]
    : selector === "[data-ide-auto]" ? [{ dataset: { ideAuto: "local" }, checked: false }]
    : selector === "[data-ide-binary]" ? [{ dataset: { ideBinary: "local" }, value: "code-server" }] : [];
  await ui.save({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.localAccess)), localAccess);
  assert.equal(saved.sharedIngressHostId, "remote:test"); assert.equal(saved.publicOrigin, config.publicOrigin);
  ui.renderActivity({ endpoints: [{ hostId: "local", localDirect: true, state: "ready", publicOrigin: localAccess.publicOrigin }] });
  assert.match(node("#ideEndpoints").innerHTML, /本机项目 · 内网 \/ VPN 直连/);
});
