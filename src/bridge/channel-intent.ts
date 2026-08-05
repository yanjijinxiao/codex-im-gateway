export type ChannelCommand = {
  readonly name: string;
  readonly arg: string;
};

export type FriendlyChannelIntent =
  | { readonly kind: "command"; readonly command: ChannelCommand }
  | { readonly kind: "clarification"; readonly text: string };
