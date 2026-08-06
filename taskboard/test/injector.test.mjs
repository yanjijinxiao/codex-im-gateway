import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector supervises the fixed local Taskboard service", () => {
  assert.match(source, /function createTaskboardSupervisor/);
  assert.match(source, /await isReachable\(taskboardHealthUrl, taskboardHealthTimeoutMs\)/);
  assert.match(source, /ensureInFlight/);
  assert.match(source, /await supervisor\.ensure\(\{ force: true \}\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(timeoutMs\)/);
});

test("the resident injector lets a busy Taskboard health endpoint answer before restarting it", () => {
  assert.match(source, /const taskboardHealthTimeoutMs = 5_000/);
  assert.match(source, /async function isReachable\(url, timeoutMs = 1_500\)/);
  assert.match(source, /AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(source, /isReachable\(taskboardHealthUrl, taskboardHealthTimeoutMs\)/);
});

test("the supervisor does not start a competing server when the Taskboard port is occupied", () => {
  const ensureStart = source.indexOf("  async function ensure({ force = false } = {})");
  const ensureEnd = source.indexOf("\n\n  function stop()", ensureStart);
  const ensureSource = source.slice(ensureStart, ensureEnd);
  const occupiedPortCheck = ensureSource.indexOf("await isPortListening(taskboardOrigin)");
  const serverStart = ensureSource.indexOf("startTaskboard({ detached })");

  assert.notEqual(ensureStart, -1);
  assert.notEqual(ensureEnd, -1);
  assert.match(source, /function isPortListening\(origin, timeoutMs = 500\)/);
  assert.notEqual(occupiedPortCheck, -1);
  assert.notEqual(serverStart, -1);
  assert.ok(occupiedPortCheck < serverStart);
  assert.match(ensureSource, /owns its port but did not answer \/health/);
});

test("a slow Taskboard recovery cannot block resident host heartbeats", () => {
  const loopStart = source.indexOf("    let serviceEnsurePending = false;");
  const loopEnd = source.indexOf("    supervisor.stop();", loopStart);

  assert.notEqual(loopStart, -1);
  assert.notEqual(loopEnd, -1);
  const loopSource = source.slice(loopStart, loopEnd);
  assert.match(loopSource, /let serviceEnsurePending = false/);
  assert.match(loopSource, /supervisor\.ensure\(\)\s*\.catch/);
  assert.match(loopSource, /\.finally\(\(\) => \{\s*serviceEnsurePending = false;/);
  assert.doesNotMatch(loopSource, /await supervisor\.ensure\(\)/);
  assert.match(loopSource, /await publishHostHeartbeat/);
});

test("the CDP bridge accepts only service ensure and native Skill composer prefill actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 1_024/);
  assert.match(runtimeSource, /request\.skillPath\.length <= 1_024/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: "\$" \}\)/);
  assert.match(source, /data-composer-overlay-floating-ui/);
  assert.match(source, /button\[data-list-navigation-item="true"\]/);
  assert.match(source, /\[skill-mention-name\]/);
  assert.match(source, /skill-mention-path/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(source, /hostResponse/);
  assert.match(source, /if \(keepAlive\) await installTaskboardHostBinding/);
  assert.match(source, /publishHostHeartbeat/);
  assert.match(source, /__codexTaskboardHostHeartbeatV1/);
});

test("the CDP bridge exposes only the fixed Taskboard automation operations", () => {
  assert.match(source, /parseTaskboardAutomationHostRequest/);
  assert.match(source, /reconcileTaskboardAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-update",\s*\]\)/);
  assert.match(source, /bridge\.sendMessageFromView\(\{\s*type: "fetch",\s*requestId,/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /vscode:\/\/codex\/\$\{method\}/);
  assert.match(source, /body: JSON\.stringify\(params\)/);
  assert.match(source, /message\.type !== "fetch-response"/);
  assert.match(source, /message\.responseType/);
  assert.match(source, /message\.status/);
  assert.match(source, /message\.bodyJsonString/);
  assert.doesNotMatch(source, /automation-delete/);
  assert.doesNotMatch(source, /automations\.toml/);
});

test("the package injection command remains resident for tab-triggered recovery", () => {
  assert.match(packageJson.scripts["codex:inject"], /--watch/);
  assert.match(packageJson.scripts["codex:daemon"], /--daemon --open/);
  assert.match(source, /function startResidentInjector/);
  assert.match(source, /const defaultCodexDebuggingPort = 9229/);
  assert.match(source, /port: defaultCodexDebuggingPort/);
  assert.match(source, /--startup-token/);
  assert.match(source, /__codexTaskboardHostStartupTokenV1/);
});

test("the resident injector can adopt the next normal Codex launch without interrupting the current window", () => {
  assert.match(source, /--adopt-normal-launch/);
  assert.match(source, /--defer-existing/);
  assert.match(source, /adoptNormalCodexLaunch/);
  assert.match(source, /findUndebuggableCodexPids/);
  assert.match(source, /injectedTargets\.clear\(\)/);
});

test("a stalled CDP request retires its connection instead of freezing resident heartbeats", () => {
  const sendStart = source.indexOf("  send(method, params = {})");
  const sendEnd = source.indexOf("\n  waitFor(method, timeoutMs)", sendStart);
  const sendSource = source.slice(sendStart, sendEnd);

  assert.notEqual(sendStart, -1);
  assert.notEqual(sendEnd, -1);
  assert.match(sendSource, /const timeout = setTimeout/);
  assert.match(sendSource, /this\.pending\.delete\(id\)/);
  assert.match(sendSource, /this\.close\(\)/);
  assert.match(sendSource, /Timed out waiting for CDP response/);
  assert.match(sendSource, /clearTimeout\(timeout\)/);
});

test("a freshly adopted renderer waits for its first document before the CSP bypass reload", () => {
  const attachBranchStart = source.indexOf("if (keepAlive && attachExisting)");
  const attachBranchEnd = source.indexOf("const scriptIdentifier =", attachBranchStart);
  const attachBranch = source.slice(attachBranchStart, attachBranchEnd);
  const waitIndex = attachBranch.indexOf("await waitForRendererDocument(cdp, 60_000)");
  const reloadIndex = attachBranch.indexOf('await cdp.send("Page.reload")');

  assert.notEqual(waitIndex, -1);
  assert.notEqual(reloadIndex, -1);
  assert.ok(waitIndex < reloadIndex);
  assert.match(attachBranch, /const reloaded = cdp\.waitFor\("Page\.loadEventFired", 60_000\)/);
  assert.match(attachBranch, /await reloaded/);
  assert.match(source, /documentState\.readyState === "complete"/);
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_TASKBOARD_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexTaskboardInjection__\?\.sourceHash \|\| null/);
  assert.match(source, /const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__"/);
  assert.match(source, /scriptIdentifier: window\[\$\{JSON\.stringify\(injectionScriptIdentifierName\)\}\] \|\| null/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(source, /reconcileInjectionRuntime/);
  assert.match(source, /expectedSourceHash/);
});

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(source, /!target\.url\?\.includes\("initialRoute="\)/);
});

test("initial injection waits for the main Codex renderer after browser CDP is ready", () => {
  const waitIndex = source.indexOf("await waitForCodexRendererTarget(options.port, 30_000)");
  const injectionIndex = source.indexOf("const firstResults = await injectAll(");

  assert.notEqual(waitIndex, -1);
  assert.ok(waitIndex < injectionIndex);
});

test("a completed web build refreshes an already-open Codex iframe", () => {
  assert.match(packageJson.scripts.build, /--refresh-if-running/);
  assert.match(packageJson.scripts["codex:refresh"], /--refresh/);
  assert.match(source, /async function refreshTaskboardFrames/);
  assert.match(source, /function codexDebuggingPorts/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /taskboard\.reloadFrame\(\)/);
  assert.match(source, /__codex_taskboard_refresh/);
  assert.match(source, /await restartResidentInjectorForRefresh\(port\)/);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /const taskboardPageUrl = `\$\{taskboardOrigin\}\/\?host=codex`/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/);
});
