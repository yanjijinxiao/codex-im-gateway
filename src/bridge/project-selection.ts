import type { ManagedProject } from "../state/runtime-state.js";
import type { CodexProjectCandidate } from "../server/codex-projects.js";
import { copyableChoices } from "../channels/copyable.js";

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
    return selected ?? { error: copyableChoices("项目编号已失效，请刷新后重新选择。", [{ label: "刷新项目列表", value: "/project" }]) };
  }
  const sameName = (name: string) => name.localeCompare(selector, undefined, { sensitivity: "accent" }) === 0;
  const matches: ProjectSelection[] = [
    ...projects.filter(p => sameName(p.name)).map(project => ({ project })),
    ...unbound.filter(p => sameName(p.name)).map(candidate => ({ candidate }))
  ];
  return matches.length === 1 ? matches[0] : {
    error: copyableChoices(matches.length > 1
      ? "有多个同名项目，请查看列表，再用当前列表给出的完整命令选择。"
      : "没有找到这个项目，请查看项目列表。", [{ label: "查看项目列表", value: "/project" }])
  };
}
