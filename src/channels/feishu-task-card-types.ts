import type { ChannelActionValue } from "./action-card.js";
import type { ChannelTaskCard } from "./task-card.js";

export type FeishuText = {
  readonly tag: "plain_text" | "lark_md";
  readonly content: string;
};

export type FeishuButton = {
  readonly tag: "button";
  readonly text: FeishuText;
  readonly type: "default" | "primary" | "danger";
  readonly value?: ChannelActionValue;
  readonly url?: string;
  readonly confirm?: { readonly title: FeishuText; readonly text: FeishuText };
};

export type FeishuFormField =
  | {
    readonly tag: "input";
    readonly name: string;
    readonly required: boolean;
    readonly placeholder: FeishuText;
    readonly label: FeishuText;
    readonly label_position: "top";
    readonly max_length: number;
    readonly input_type: "text" | "multiline_text";
    readonly rows?: number;
    readonly auto_resize?: boolean;
    readonly max_rows?: number;
    readonly default_value?: string;
  }
  | {
    readonly tag: "select_static";
    readonly name: string;
    readonly required: boolean;
    readonly placeholder: FeishuText;
    readonly initial_option?: string;
    readonly options: readonly { readonly text: FeishuText; readonly value: string }[];
  };

export type FeishuFormSubmitButton = FeishuButton & {
  readonly action_type: "form_submit";
  readonly name: string;
  readonly value: ChannelActionValue;
};

export type FeishuElement =
  | { readonly tag: "hr" }
  | {
    readonly tag: "div";
    readonly text: FeishuText;
    readonly fields?: readonly { readonly is_short: boolean; readonly text: FeishuText }[];
    readonly extra?: FeishuButton;
  }
  | { readonly tag: "note"; readonly elements: readonly FeishuText[] }
  | {
    readonly tag: "action";
    readonly layout: "bisected" | "trisection" | "flow";
    readonly actions: readonly FeishuButton[];
  }
  | {
    readonly tag: "form";
    readonly name: string;
    readonly elements: readonly (FeishuFormField | FeishuFormSubmitButton)[];
  };

export type FeishuTaskCardPayload = {
  readonly config: {
    readonly wide_screen_mode: true;
    readonly enable_forward: true;
    readonly update_multi: true;
  };
  readonly header: {
    readonly template: ChannelTaskCard["template"];
    readonly title: FeishuText;
  };
  readonly elements: readonly FeishuElement[];
  readonly card_link?: { readonly url: string };
};
