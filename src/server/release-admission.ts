import fs from "node:fs";
import path from "node:path";

export const validReleaseOwner = (id: unknown): id is string => typeof id === "string"
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
export const releaseAdmissionFile = (root: string): string => path.join(root, "release-admission.json");

/** A cutover keeps the replacement process closed to native writes through
 * readiness/rollback. A crash leaves a visible gate, never an auto-expiring gap. */
export function readReleaseOwner(root: string): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(releaseAdmissionFile(root), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !validReleaseOwner(value.id) || Object.keys(value).sort().join(",") !== "id,version") throw Error("Invalid release admission journal; original file preserved");
  return value.id;
}

export function saveReleaseOwner(root: string, id: string): void {
  fs.writeFileSync(releaseAdmissionFile(root), JSON.stringify({ version: 1, id }), { flag: "wx", mode: 0o600 });
}

export function clearReleaseOwner(root: string, id: string): void {
  const current = readReleaseOwner(root);
  if (current !== id) throw Error("Release admission owner changed; submissions remain frozen");
  fs.unlinkSync(releaseAdmissionFile(root));
}
