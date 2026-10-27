/** Syntax only: permissions, aliases and the command inventory belong to Bridge.
 * Free-text queue/steer arguments may start in Chinese without an ASCII space.
 * Do not turn /queueing, paths, quoted commands or embedded mentions into queue.
 */
export function splitCommandText(text: string): { name: string; argument: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return;
  const compact = /^\/(queue|steer|iv)(?=\p{Script=Han})/iu.exec(trimmed);
  if (compact) return { name: compact[1].toLowerCase(), argument: trimmed.slice(compact[0].length) };
  const head = /^\/([^\s]+)(?:\s+|$)/u.exec(trimmed);
  return head ? { name: head[1].toLowerCase(), argument: trimmed.slice(head[0].length) } : undefined;
}

/** Called only by the group adapter. Remove addressing at the very beginning,
 * including native rich-text joins with no separator or with a newline. */
export function addressedCommandText(text: string): string {
  const trimmed = text.trim();
  const prefix = /^(?:(?:<@[^<>\s]+>|@[^@<>/\s，。！？：；,!?;:'"`]+)\s*)+/u.exec(trimmed);
  if (!prefix) return trimmed;
  const candidate = trimmed.slice(prefix[0].length), command = splitCommandText(candidate);
  return command && /^[a-z][a-z0-9_-]*$/i.test(command.name) ? candidate : trimmed;
}
