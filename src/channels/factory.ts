import { accountChannel, type ChannelAccount, type WeixinAccount, type WeComAccount, type DingTalkAccount, type FeishuAccount } from "../weixin/accounts.js";
import type { WeixinApiClient } from "../weixin/api.js";
import { monitorWeixin, type MonitorOptions } from "../weixin/monitor.js";
import { WeixinChannelAdapter } from "./weixin.js";
import { DingTalkChannelAdapter } from "./dingtalk.js";
import { FeishuChannelAdapter } from "./feishu.js";
import { WeComChannelAdapter } from "./wecom.js";
import { adaptLegacyClient } from "./legacy.js";
import type { ChannelAdapter, ChannelClient } from "./types.js";

export type ChannelAdapterOptions = { inboundDir: string; maxInboundBytes: number };
export type ChannelAdapterFactory = (account: ChannelAccount, options: ChannelAdapterOptions) => ChannelAdapter;

/** The sole channel dispatch point. Gateway commands and Codex backends are channel-independent. */
export const createChannelAdapter: ChannelAdapterFactory = (account, options) => {
  switch (accountChannel(account)) {
    case "weixin": return new WeixinChannelAdapter(account as WeixinAccount, options);
    case "dingtalk": return new DingTalkChannelAdapter(account as DingTalkAccount, options);
    case "feishu": return new FeishuChannelAdapter(account as FeishuAccount, options);
    case "wecom": return new WeComChannelAdapter(account as WeComAccount);
  }
};

/** Legacy dependency-injection seam for existing embedders; not used by the server defaults. */
export function channelFactoryWithLegacyOverrides(overrides: {
  clientFactory?: (account: WeixinAccount) => WeixinApiClient;
  monitor?: (options: MonitorOptions) => Promise<void>;
  channelFactory?: (account: WeComAccount | FeishuAccount | DingTalkAccount, options: { inboundDir: string }) => ChannelAdapter;
}): ChannelAdapterFactory {
  return (account, options) => {
    const kind = accountChannel(account);
    if (kind !== "weixin" && overrides.channelFactory) {
      const adapter = overrides.channelFactory(account as WeComAccount | FeishuAccount | DingTalkAccount, options);
      if (adapter.client.capabilities) return adapter;
      const client = adaptLegacyClient(adapter.client, options);
      return { client: { ...client, channel: kind } as ChannelClient, monitor: async (input) => {
        input.onStatus?.({ state: "connected" });
        await adapter.monitor(input);
      } };
    }
    if (kind === "weixin" && overrides.clientFactory) {
      const api = overrides.clientFactory(account as WeixinAccount);
      return {
        client: adaptLegacyClient(api, { ...options, cdnBaseUrl: (account as WeixinAccount).cdnBaseUrl }),
        monitor: async (input) => {
          if (overrides.monitor) input.onStatus?.({ state: "connected" });
          await (overrides.monitor ?? monitorWeixin)({ ...input, client: api, initialSyncKey: input.checkpoint, onSyncKey: input.onCheckpoint });
        }
      };
    }
    return createChannelAdapter(account, options);
  };
}
