/** Inert presentation only. One exact reply per block, with no descriptions,
 * hidden callbacks or credentials mixed into the value a person copies. */
export function copyBlock(value: string): string {
  const width = Math.max(3, ...Array.from(value.matchAll(/`+/g), match => match[0].length + 1));
  const fence = "`".repeat(width);
  return `${fence}text\n${value}\n${fence}`;
}

export function copyableChoices(text: string, choices: readonly { label: string; value: string }[]): string {
  const missing = choices.filter(choice => choice.value && !text.includes(copyBlock(choice.value)));
  return missing.length ? [text, "可复制的选项（复制不会执行）：", ...missing.map(choice => `${choice.label}\n\n${copyBlock(choice.value)}`)].join("\n\n") : text;
}
