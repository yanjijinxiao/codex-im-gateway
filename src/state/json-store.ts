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
    if (options.durable) {
      const dir = fs.openSync(path.dirname(filePath), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally { fs.rmSync(tmp, { force: true }); }
}

