/** Provider ids only. A display name, model tag or @all is never an identity. */
export function isDirectedMentionId(value: string): boolean {
  return /^[A-Za-z0-9_.:@+-]{1,256}$/.test(value) && !["all", "@all"].includes(value.toLowerCase());
}
