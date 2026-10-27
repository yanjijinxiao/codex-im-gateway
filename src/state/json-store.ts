import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export function writeJsonFile(filePath: string, value: unknown, options: { durable?: boolean } = {}): void {
  writeAtomicTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function writeAtomicTextFile(filePath: string, text: string, options: { durable?: boolean } = {}): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, text, "utf8");
      if (options.durable) fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, filePath);
    // Windows does not support opening a directory handle through fs.openSync.
    // The file itself is still flushed before the atomic rename on every OS.
    if (options.durable && process.platform !== "win32") {
      const dir = fs.openSync(path.dirname(filePath), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally { fs.rmSync(tmp, { force: true }); }
}


/** JSON syntax is insufficient for map-like state: arrays silently discard
 * named properties during stringify, destroying receipts/binding keys. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function readJsonObjectFile<T extends object>(filePath: string, fallback: T): T {
  const value = readJsonFile<unknown>(filePath, fallback);
  if (!isJsonObject(value)) throw new Error(`Invalid object state file: ${path.basename(filePath)}; original file preserved`);
  return value as T;
}
