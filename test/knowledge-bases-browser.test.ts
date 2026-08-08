import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

type PickerResult = { readonly path: string | null };
type DeferredPicker = PromiseWithResolvers<PickerResult>;

function deferredPicker(): DeferredPicker {
  return Promise.withResolvers<PickerResult>();
}

async function createKnowledgeBasePickerHarness() {
  const source = await readFile(new URL("../src/web/knowledge-bases.js", import.meta.url), "utf8");
  const label = { textContent: "选择" };
  const button = {
    dataset: { directoryTarget: "knowledgeBaseRootInput" },
    disabled: false,
    querySelector: () => label
  };
  const dialog = { open: true };
  const rootInput = { value: "/old", focus() {} };
  const projectInput = { value: "" };
  const formError = { textContent: "", hidden: true };
  const elements = new Map<string, unknown>([
    ["#knowledgeBaseDialog", dialog],
    ["#knowledgeBaseRootInput", rootInput],
    ["#knowledgeBaseProjectInput", projectInput],
    ["#knowledgeBaseFormError", formError]
  ]);
  const requests: DeferredPicker[] = [];
  const context: Record<string, unknown> = {
    api() {
      const request = deferredPicker();
      requests.push(request);
      return request.promise;
    },
    document: {
      addEventListener() {},
      querySelector(selector: string) {
        return elements.get(selector);
      },
      querySelectorAll() {
        return [button];
      }
    },
    state: { codexProjects: [] },
    window: {}
  };
  vm.runInNewContext(source, context);
  return {
    beginSession: context.beginKnowledgeBaseDialogSession as () => number,
    pickDirectory: context.pickKnowledgeBaseDirectory as (target: typeof button) => Promise<void>,
    button,
    dialog,
    formError,
    label,
    requests,
    rootInput
  };
}

test("ignores a directory result from an earlier dialog session", async () => {
  const harness = await createKnowledgeBasePickerHarness();
  harness.beginSession();
  const pending = harness.pickDirectory(harness.button);
  assert.equal(harness.button.disabled, true);

  harness.dialog.open = false;
  harness.beginSession();
  harness.dialog.open = true;
  harness.rootInput.value = "/new-session";
  harness.requests[0].resolve({ path: "/stale-selection" });
  await pending;

  assert.equal(harness.rootInput.value, "/new-session");
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.label.textContent, "选择");
});

test("ignores a directory-picker error from an earlier dialog session", async () => {
  const harness = await createKnowledgeBasePickerHarness();
  harness.beginSession();
  const pending = harness.pickDirectory(harness.button);

  harness.dialog.open = false;
  harness.beginSession();
  harness.dialog.open = true;
  harness.formError.textContent = "";
  harness.formError.hidden = true;
  harness.requests[0].reject(new Error("stale picker failure"));
  await pending;

  assert.equal(harness.formError.textContent, "");
  assert.equal(harness.formError.hidden, true);
});
