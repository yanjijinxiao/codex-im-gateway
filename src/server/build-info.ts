import fs from "node:fs";

export function readBuildInfo(file: URL = new URL("../build-info.json", import.meta.url)):
  { commit: string; sourceHash: string; builtAt: string } | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!/^[a-f0-9]{40}$/.test(value.commit) || !/^[a-f0-9]{64}$/.test(value.sourceHash)
      || typeof value.builtAt !== "string" || !Number.isFinite(Date.parse(value.builtAt))) throw Error("Invalid build manifest");
    return { commit: value.commit, sourceHash: value.sourceHash, builtAt: value.builtAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
