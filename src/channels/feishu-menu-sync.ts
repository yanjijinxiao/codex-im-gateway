import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccount } from "../weixin/accounts.js";

import { FEISHU_BOT_MENU_SHORTCUTS, type FeishuBotMenuShortcut } from "./feishu-shortcuts.js";

type FeishuBotMenu = {
  readonly menu_id?: string;
  readonly parent_menu_id?: string;
  readonly sort?: number;
  readonly default_name?: string;
  readonly i18n_name?: Record<string, string>;
  readonly redirect_link?: {
    readonly pc_url?: string;
    readonly mobile_url?: string;
  };
  readonly event_key?: string;
  readonly icon_file_key?: string;
  readonly menu_content_type?: number;
};

type FeishuApplicationClient = {
  readonly application: {
    readonly v6: {
      readonly application: {
        get(input: {
          readonly params: { readonly lang: "zh_cn" };
          readonly path: { readonly app_id: string };
        }): Promise<{
          readonly code?: number;
          readonly msg?: string;
          readonly data?: {
            readonly app?: {
              readonly create_source?: string;
              readonly online_version_id?: string;
              readonly unaudit_version_id?: string;
            };
          };
        }>;
      };
      readonly applicationAppVersion: {
        get(input: {
          readonly params: { readonly lang: "zh_cn" };
          readonly path: { readonly app_id: string; readonly version_id: string };
        }): Promise<{
          readonly code?: number;
          readonly msg?: string;
          readonly data?: {
            readonly app_version?: {
              readonly ability?: {
                readonly bot?: {
                  readonly bot_menus?: FeishuBotMenu[];
                };
              };
            };
          };
        }>;
      };
    };
    readonly v7: {
      readonly applicationConfig: {
        patch(input: {
          readonly path: { readonly app_id: string };
          readonly data: {
            readonly event: {
              readonly subscription_type: "websocket";
              readonly add_events: string[];
            };
          };
        }): Promise<FeishuMutationResponse>;
      };
      readonly applicationAbility: {
        patch(input: {
          readonly path: { readonly app_id: string };
          readonly data: {
            readonly bot: {
              readonly enable: true;
              readonly bot_menu_enable: true;
              readonly bot_menus: FeishuBotMenu[];
            };
          };
        }): Promise<FeishuMutationResponse>;
      };
      readonly applicationPublish: {
        create(input: {
          readonly path: { readonly app_id: string };
          readonly data: {
            readonly mobile_default_ability: "bot";
            readonly pc_default_ability: "bot";
            readonly remark: string;
            readonly changelog: string;
          };
        }): Promise<FeishuMutationResponse & {
          readonly data?: { readonly version_id?: string; readonly version?: string };
        }>;
      };
    };
  };
};

type FeishuMutationResponse = {
  readonly code?: number;
  readonly msg?: string;
};

export type FeishuShortcutMenuSyncResult = {
  readonly appId: string;
  readonly menuCount: number;
  readonly publishedVersionId?: string;
  readonly publishedVersion?: string;
};

export type SyncFeishuShortcutMenuOptions = {
  readonly client?: FeishuApplicationClient;
};

const MENU_EVENT = "application.bot.menu_v6";

export async function syncFeishuShortcutMenu(
  account: FeishuAccount,
  options: SyncFeishuShortcutMenuOptions = {}
): Promise<FeishuShortcutMenuSyncResult> {
  const client: FeishuApplicationClient = options.client ?? new Lark.Client({
    appId: account.appId,
    appSecret: account.appSecret
  });
  const app = await getApplication(client, account.appId);
  ensureAppCanBeUpdated(app, account.appId);

  const existingMenus = app.online_version_id
    ? await getOnlineBotMenus(client, account.appId, app.online_version_id)
    : [];
  const menus = mergeBotMenus(existingMenus, FEISHU_BOT_MENU_SHORTCUTS);

  await ensureSuccess(
    client.application.v7.applicationConfig.patch({
      path: { app_id: account.appId },
      data: {
        event: {
          subscription_type: "websocket",
          add_events: [MENU_EVENT]
        }
      }
    }),
    "订阅飞书机器人菜单事件"
  );
  await ensureSuccess(
    client.application.v7.applicationAbility.patch({
      path: { app_id: account.appId },
      data: {
        bot: {
          enable: true,
          bot_menu_enable: true,
          bot_menus: menus
        }
      }
    }),
    "同步飞书机器人快捷菜单"
  );
  const published = await ensureSuccess(
    client.application.v7.applicationPublish.create({
      path: { app_id: account.appId },
      data: {
        mobile_default_ability: "bot",
        pc_default_ability: "bot",
        remark: "同步 Codex 原生快捷菜单",
        changelog: "新增 Codex 工作台、任务面板、项目与模式三个机器人快捷入口。"
      }
    }),
    "发布飞书机器人快捷菜单"
  );

  return {
    appId: account.appId,
    menuCount: menus.length,
    ...(published.data?.version_id ? { publishedVersionId: published.data.version_id } : {}),
    ...(published.data?.version ? { publishedVersion: published.data.version } : {})
  };
}

export function mergeBotMenus(
  existingMenus: readonly FeishuBotMenu[],
  shortcuts: readonly FeishuBotMenuShortcut[] = FEISHU_BOT_MENU_SHORTCUTS
): FeishuBotMenu[] {
  const shortcutKeys = new Set(shortcuts.map((shortcut) => shortcut.eventKey));
  const preserved = existingMenus.filter((menu) => !menu.event_key || !shortcutKeys.has(menu.event_key));
  const firstShortcutSort = Math.max(0, ...preserved.map((menu) => menu.sort ?? 0)) + 1;
  return [
    ...preserved,
    ...shortcuts.map((shortcut, index) => ({
      default_name: shortcut.label,
      i18n_name: { zh_cn: shortcut.label },
      event_key: shortcut.eventKey,
      sort: firstShortcutSort + index
    }))
  ];
}

async function getApplication(client: FeishuApplicationClient, appId: string): Promise<{
  readonly create_source?: string;
  readonly online_version_id?: string;
  readonly unaudit_version_id?: string;
}> {
  const result = await client.application.v6.application.get({
    params: { lang: "zh_cn" },
    path: { app_id: appId }
  });
  await ensureSuccess(Promise.resolve(result), "读取飞书应用配置");
  if (!result.data?.app) throw new Error("飞书没有返回应用配置，无法同步快捷菜单");
  return result.data.app;
}

function ensureAppCanBeUpdated(
  app: { readonly create_source?: string; readonly unaudit_version_id?: string },
  appId: string
): void {
  if (app.create_source && app.create_source !== "developer_console") {
    throw new Error("当前飞书应用不是开发者后台创建的自建应用，无法通过 API 同步机器人菜单");
  }
  if (app.unaudit_version_id) {
    throw new Error(`飞书应用 ${appId} 存在正在审核的版本，请审核完成后再同步快捷菜单`);
  }
}

async function getOnlineBotMenus(
  client: FeishuApplicationClient,
  appId: string,
  versionId: string
): Promise<readonly FeishuBotMenu[]> {
  const result = await client.application.v6.applicationAppVersion.get({
    params: { lang: "zh_cn" },
    path: { app_id: appId, version_id: versionId }
  });
  await ensureSuccess(Promise.resolve(result), "读取飞书线上机器人菜单");
  return result.data?.app_version?.ability?.bot?.bot_menus ?? [];
}

async function ensureSuccess<T extends FeishuMutationResponse>(
  response: Promise<T>,
  action: string
): Promise<T> {
  let result: T;
  try {
    result = await response;
  } catch (error) {
    throw new Error(`${action}失败：${describeFeishuRequestError(error)}`);
  }
  if (result.code && result.code !== 0) {
    throw new Error(`${action}失败（${result.code}）：${result.msg ?? "飞书未返回错误说明"}`);
  }
  return result;
}

function describeFeishuRequestError(error: unknown): string {
  const responseData = nestedRecord(error, "response", "data");
  const code = responseData?.code;
  const message = responseData?.msg;
  if (code === 99991672) {
    return "应用尚未开通 application:application:patch 权限；请在飞书开发者后台授权后重新同步";
  }
  if (typeof code === "number" && typeof message === "string") {
    return `飞书错误 ${code}：${message}`;
  }
  return error instanceof Error && error.message
    ? error.message
    : "飞书请求未返回可识别的错误说明";
}

function nestedRecord(value: unknown, ...keys: readonly string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
