import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeBotMenus,
  syncFeishuShortcutMenu,
  type SyncFeishuShortcutMenuOptions
} from "../src/channels/feishu-menu-sync.js";
import type { FeishuAccount } from "../src/weixin/accounts.js";

function account(): FeishuAccount {
  return {
    channel: "feishu",
    accountId: "feishu-test",
    appId: "cli_test",
    appSecret: "secret",
    savedAt: "2026-08-08T00:00:00.000Z",
    enabled: true
  };
}

function client(input: {
  readonly onlineVersionId?: string;
  readonly unauditVersionId?: string;
  readonly menus?: Array<{ readonly event_key?: string; readonly default_name?: string; readonly sort?: number }>;
} = {}): {
  readonly options: SyncFeishuShortcutMenuOptions;
  readonly calls: {
    readonly config: Array<unknown>;
    readonly ability: Array<unknown>;
    readonly publish: Array<unknown>;
  };
} {
  const calls = { config: [], ability: [], publish: [] };
  return {
    calls,
    options: {
      client: {
        application: {
          v6: {
            application: {
              async get() {
                return {
                  code: 0,
                  data: {
                    app: {
                      create_source: "developer_console",
                      online_version_id: input.onlineVersionId,
                      unaudit_version_id: input.unauditVersionId
                    }
                  }
                };
              }
            },
            applicationAppVersion: {
              async get() {
                return {
                  code: 0,
                  data: {
                    app_version: {
                      ability: { bot: { bot_menus: input.menus ?? [] } }
                    }
                  }
                };
              }
            }
          },
          v7: {
            applicationConfig: {
              async patch(request) {
                calls.config.push(request);
                return { code: 0 };
              }
            },
            applicationAbility: {
              async patch(request) {
                calls.ability.push(request);
                return { code: 0 };
              }
            },
            applicationPublish: {
              async create(request) {
                calls.publish.push(request);
                return { code: 0, data: { version_id: "oav_synced", version: "1.2.3" } };
              }
            }
          }
        }
      }
    }
  };
}

test("syncs a native Feishu menu, its event subscription, and a bot release", async () => {
  const fake = client({
    onlineVersionId: "oav_online",
    menus: [{ event_key: "external.status", default_name: "外部状态", sort: 1 }]
  });

  const result = await syncFeishuShortcutMenu(account(), fake.options);

  assert.deepEqual(result, {
    appId: "cli_test",
    menuCount: 4,
    publishedVersionId: "oav_synced",
    publishedVersion: "1.2.3"
  });
  assert.deepEqual(fake.calls.config, [{
    path: { app_id: "cli_test" },
    data: {
      event: {
        subscription_type: "websocket",
        add_events: ["application.bot.menu_v6"]
      }
    }
  }]);
  assert.deepEqual(fake.calls.ability, [{
    path: { app_id: "cli_test" },
    data: {
      bot: {
        enable: true,
        bot_menu_enable: true,
        bot_menus: [
          { event_key: "external.status", default_name: "外部状态", sort: 1 },
          {
            default_name: "Codex 工作台",
            i18n_name: { zh_cn: "Codex 工作台" },
            event_key: "codex.workbench",
            sort: 2
          },
          {
            default_name: "任务面板",
            i18n_name: { zh_cn: "任务面板" },
            event_key: "codex.taskboard",
            sort: 3
          },
          {
            default_name: "项目与模式",
            i18n_name: { zh_cn: "项目与模式" },
            event_key: "codex.project",
            sort: 4
          }
        ]
      }
    }
  }]);
  assert.deepEqual(fake.calls.publish, [{
    path: { app_id: "cli_test" },
    data: {
      mobile_default_ability: "bot",
      pc_default_ability: "bot",
      remark: "同步 Codex 原生快捷菜单",
      changelog: "新增 Codex 工作台、任务面板、项目与模式三个机器人快捷入口。"
    }
  }]);
});

test("replaces previous Codex menu entries without duplicating them", () => {
  assert.deepEqual(mergeBotMenus([
    { event_key: "codex.workbench", default_name: "旧工作台", sort: 1 },
    { event_key: "external.status", default_name: "外部状态", sort: 2 }
  ]), [
    { event_key: "external.status", default_name: "外部状态", sort: 2 },
    {
      default_name: "Codex 工作台",
      i18n_name: { zh_cn: "Codex 工作台" },
      event_key: "codex.workbench",
      sort: 3
    },
    {
      default_name: "任务面板",
      i18n_name: { zh_cn: "任务面板" },
      event_key: "codex.taskboard",
      sort: 4
    },
    {
      default_name: "项目与模式",
      i18n_name: { zh_cn: "项目与模式" },
      event_key: "codex.project",
      sort: 5
    }
  ]);
});

test("does not mutate a Feishu app while another version is under review", async () => {
  const fake = client({ unauditVersionId: "oav_review" });

  await assert.rejects(
    syncFeishuShortcutMenu(account(), fake.options),
    /正在审核的版本/
  );
  assert.deepEqual(fake.calls.config, []);
  assert.deepEqual(fake.calls.ability, []);
  assert.deepEqual(fake.calls.publish, []);
});
