import { AsyncLocalStorage } from "node:async_hooks";

import type * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuTaskCardPayload } from "./feishu-task-card.js";

type FeishuCardPayload = Lark.InteractiveCard | FeishuTaskCardPayload;
type FeishuMessagePatch = Lark.Client["im"]["v1"]["message"]["patch"];

type CallbackResponse = {
  card: FeishuCardPayload | undefined;
};

type FeishuCardCallbackResponse = {
  readonly card: {
    readonly type: "raw";
    readonly data: FeishuCardPayload;
  };
};

export class FeishuCardUpdater {
  private readonly callbackResponse = new AsyncLocalStorage<CallbackResponse>();

  constructor(private readonly patch: FeishuMessagePatch | undefined) {}

  async respondToCallback(handler: () => Promise<void>): Promise<FeishuCardCallbackResponse | undefined> {
    const response: CallbackResponse = { card: undefined };
    await this.callbackResponse.run(response, handler);
    return response.card ? { card: { type: "raw", data: response.card } } : undefined;
  }

  async update(messageId: string, card: FeishuCardPayload): Promise<void> {
    const response = this.callbackResponse.getStore();
    if (response) {
      response.card = card;
      return;
    }
    if (!this.patch) throw new FeishuCardUpdateUnavailableError();
    await this.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) }
    });
  }
}

class FeishuCardUpdateUnavailableError extends Error {
  readonly name = "FeishuCardUpdateUnavailableError";

  constructor() {
    super("Feishu message patch capability is unavailable");
  }
}
