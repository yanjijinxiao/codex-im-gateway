import type { ManagedProject } from "../state/runtime-state.js";
import type { CodexProjectCandidate } from "../server/codex-projects.js";

export type ProjectSelection =
  | { project: ManagedProject; candidate?: never; error?: never }
  | { candidate: CodexProjectCandidate; project?: never; error?: never }
  | { error: string; project?: never; candidate?: never };

/** Shared P/C numbering and name resolution for /project and /new. No state changes. */
export function selectChannelProject(
  selector: string,
  projects: readonly ManagedProject[],
  candidates: readonly CodexProjectCandidate[],
  bound: (candidate: CodexProjectCandidate) => ManagedProject | undefined
): ProjectSelection {
  const unbound = candidates.filter(candidate => !bound(candidate));
  const code = /^([pc])([1-9]\d*)$/i.exec(selector);
  if (code) {
    const index = Number(code[2]) - 1;
    const selected = code[1].toLowerCase() === "p"
      ? projects[index] && { project: projects[index] }
      : unbound[index] && { candidate: unbound[index] };
    return selected ?? { error: "项目编号已失效，请发送 /project 刷新后重新选择。" };
  }
  const sameName = (name: string) => name.localeCompare(selector, undefined, { sensitivity: "accent" }) === 0;
  const matches: ProjectSelection[] = [
    ...projects.filter(p => sameName(p.name)).map(project => ({ project })),
    ...unbound.filter(p => sameName(p.name)).map(candidate => ({ candidate }))
  ];
  return matches.length === 1 ? matches[0] : {
    error: matches.length > 1
      ? "有多个同名项目，请发送 /project 查看列表，再用 P/C 编号选择。"
      : "没有找到这个项目。发送 /project 查看列表，可用 P/C 编号或完整项目名选择。"
  };
}
