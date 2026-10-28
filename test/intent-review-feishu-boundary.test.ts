import assert from "node:assert/strict";
import test from "node:test";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";

for (const kind of ["message", "card", "menu"] as const) test(`Feishu ${kind} receipt persistence failure reaches the application boundary`, async () => {
  let dispatcher:any,delivered=0;const reported:unknown[]=[];
  const adapter=new FeishuChannelAdapter({channel:"feishu",accountId:"synthetic",appId:"synthetic",appSecret:"synthetic",enabled:true,savedAt:""}, {
    apiClient:{im:{v1:{message:{async create(){throw Error("no outbound request expected");}}}}} as never,
    wsClient:{async start(input){dispatcher=input.eventDispatcher;},close(){}}
  });
  const controller=new AbortController(),failure=Error("synthetic journal unavailable");
  const work=adapter.monitor({signal:controller.signal,claimMessage(){throw failure;},async onMessage(){delivered++;},onMessageError(error){reported.push(error);}});
  try{
    await new Promise(resolve=>setImmediate(resolve));
    const callback=kind==="message"?"im.message.receive_v1":kind==="card"?"card.action.trigger":"application.bot.menu_v6";
    const payload=kind==="message"?{sender:{sender_id:{open_id:"ou_actor"}},message:{message_id:"m",chat_id:"oc_group",chat_type:"group",message_type:"text",content:'{"text":"hello"}'}}
      :kind==="card"?{token:"synthetic-callback",context:{open_message_id:"card",open_chat_id:"oc_group"},operator:{open_id:"ou_actor"},action:{tag:"button",value:{version:1,command:"status",arg:""}}}
      :{event_id:"menu",event_key:"codex.workbench",operator:{operator_id:{open_id:"ou_actor"}}};
    await dispatcher.handles.get(callback)(payload);
    assert.deepEqual(reported,[failure]);assert.equal(delivered,0);
  }finally{controller.abort();await work;}
});

for (const chatType of ["p2p", "group", "unknown", undefined]) test(`Feishu inbound identity retains only provider-confirmed conversation kind: ${chatType}`, async () => {
  let dispatcher: any;
  const messages: any[] = [];
  const adapter = new FeishuChannelAdapter({ channel: "feishu", accountId: "synthetic", appId: "synthetic", appSecret: "synthetic", enabled: true, savedAt: "" }, {
    apiClient: { im: { v1: { message: {} } } } as never,
    wsClient: { async start(input) { dispatcher = input.eventDispatcher; }, close() {} }
  });
  const controller = new AbortController();
  const work = adapter.monitor({ signal: controller.signal, async onMessage(message) { messages.push(message); } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    await dispatcher.handles.get("im.message.receive_v1")({ sender: { sender_id: { open_id: "ou_actor" } },
      message: { message_id: "m", chat_id: "oc_not_a_kind_signal", chat_type: chatType, message_type: "text", content: '{"text":"hello"}' } });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].conversationKind, chatType === "p2p" ? "direct" : chatType === "group" ? "group" : undefined);
  } finally { controller.abort(); await work; }
});
