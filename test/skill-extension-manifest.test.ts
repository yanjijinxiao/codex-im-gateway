import assert from "node:assert/strict";
import test from "node:test";

import {
  createChannelCapabilityFromManifest,
  SkillExtensionManifestSchema
} from "../src/bridge/skill-extension-manifest.js";

function validManifest(): unknown {
  return {
    schemaVersion: 1,
    channel: {
      capabilityId: "example-capability",
      command: {
        name: "example",
        aliases: ["ex", "示例"],
        helpLine: "/example [status|run] - 示例能力",
        usage: "/example [status|run]",
        defaultOperation: "status"
      },
      operations: [{
        name: "status",
        aliases: ["show", "查看"],
        instruction: "查看示例状态。",
        ai: { intent: "example_status", guidance: "查看示例状态。", argument: "detail" }
      }, {
        name: "run",
        aliases: ["执行"],
        instruction: "执行示例操作。",
        confirmation: "explicit",
        ai: { intent: "example_run", guidance: "执行示例操作。", argument: "detail" }
      }]
    },
    sidebar: {
      id: "example-capability",
      label: "示例",
      ariaLabel: "切换到示例",
      url: "http://127.0.0.1:43210/",
      order: 10,
      icon: "document"
    }
  };
}

test("strict generic manifest compiles deterministic command, AI, and navigation data", () => {
  const parsed = SkillExtensionManifestSchema.safeParse(validManifest());
  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.message);
  const capability = createChannelCapabilityFromManifest("manage-example", parsed.data);
  assert.ok(capability);
  assert.deepEqual(capability.aliases, { ex: "example", "示例": "example" });
  assert.deepEqual(capability.aiActions.map((action) => action.intent), ["example_status", "example_run"]);
  assert.equal(Object.isFrozen(capability.aiActions), true);
  assert.equal(Object.isFrozen(capability.aiActions[0]), true);
  assert.deepEqual(capability.navigation, {
    id: "example-capability",
    label: "示例",
    ariaLabel: "切换到示例",
    url: "http://127.0.0.1:43210/",
    order: 10,
    icon: "document",
    allowClipboard: false
  });
  assert.equal(capability.resolve("").kind, "run_skill");
  const execution = capability.resolve("执行 补充事实");
  assert.equal(execution.kind, "run_skill");
  if (execution.kind === "run_skill") {
    assert.equal(execution.skillName, "manage-example");
    assert.equal(execution.operation, "run");
    assert.match(execution.instruction, /用户补充：补充事实/);
    assert.match(execution.instruction, /显式确认/);
  }
  assert.equal(capability.resolve("unknown").kind, "reply");
});

test("strict manifest rejects unknown fields, duplicate tokens, and unsafe navigation", () => {
  const invalid = [{
    schemaVersion: 1,
    channel: {
      capabilityId: "example",
      command: {
        name: "example",
        aliases: [],
        helpLine: "/example - 示例",
        usage: "/example",
        defaultOperation: "status",
        executable: "./plugin.js"
      },
      operations: [{ name: "status", aliases: [], instruction: "查看状态。" }]
    }
  }, {
    schemaVersion: 1,
    channel: {
      capabilityId: "example",
      command: {
        name: "example",
        aliases: [],
        helpLine: "/example - 示例",
        usage: "/example",
        defaultOperation: "status"
      },
      operations: [
        { name: "status", aliases: ["show"], instruction: "查看状态。" },
        { name: "run", aliases: ["show"], instruction: "执行。" }
      ]
    }
  }, {
    schemaVersion: 1,
    channel: {
      capabilityId: "example",
      command: {
        name: "example",
        aliases: ["EXAMPLE"],
        helpLine: "/example - 示例",
        usage: "/example",
        defaultOperation: "status"
      },
      operations: [{ name: "status", aliases: [], instruction: "查看状态。" }]
    }
  }, {
    schemaVersion: 1,
    channel: {
      capabilityId: "example",
      command: {
        name: "example",
        aliases: [],
        helpLine: "/example - 示例",
        usage: "/example",
        defaultOperation: "status"
      },
      operations: [{ name: "status", aliases: [], instruction: "查看\u202e状态。" }]
    }
  }, {
    schemaVersion: 1,
    sidebar: {
      id: "remote",
      label: "远程",
      ariaLabel: "切换到远程",
      url: "https://example.com/",
      order: 10,
      icon: "generic"
    }
  }, {
    schemaVersion: 2,
    sidebar: {
      id: "example",
      label: "示例",
      ariaLabel: "切换到示例",
      url: "http://127.0.0.1:43210/",
      order: 10,
      icon: "generic"
    }
  }, {
    ...validManifest(),
    sidebar: {
      id: "different-id",
      label: "示例",
      ariaLabel: "切换到示例",
      url: "http://127.0.0.1:43210/",
      order: 10,
      icon: "generic"
    }
  }];

  for (const value of invalid) assert.equal(SkillExtensionManifestSchema.safeParse(value).success, false);
});
