export type NewSessionTarget =
  | { kind: "current" }
  | { kind: "standalone" }
  | { kind: "project"; selector: string }
  | { kind: "help" }
  | { kind: "invalid" };

export const NEW_SESSION_USAGE = [
  "/new：在当前项目新建会话",
  "/new P2 或 /new C1：在指定项目新建并切换（编号来自 /project）",
  "/new --project 完整项目名：按名称选择项目；同名时请用编号",
  "/new --standalone：新建本机独立会话，不归属任何项目",
  "/session new ... 是 /new ... 的别名。下一条消息才会启动 Codex。"
].join("\n\n");

/** Reject ambiguous/mixed flags rather than silently creating in the wrong context. */
export function parseNewSessionTarget(arg: string): NewSessionTarget {
  const input = arg.trim();
  if (!input) return { kind: "current" };
  if (/^(?:help|--help)$/i.test(input)) return { kind: "help" };
  if (/^--standalone$/i.test(input)) return { kind: "standalone" };
  const project = /^--project\s+(.+)$/i.exec(input)?.[1] ?? input;
  if (/(?:^|\s)--\S*/.test(project)) return { kind: "invalid" };
  const selector = project.replace(/^(["'])(.*)\1$/, "$2").trim();
  return selector ? { kind: "project", selector } : { kind: "invalid" };
}
