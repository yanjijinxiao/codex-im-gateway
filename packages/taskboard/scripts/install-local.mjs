#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, lstat, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(installerPath), "..");
const minimumNodeVersion = [22, 5, 0];

function parseOptions(argv) {
  const options = { check: false, skipBuild: false, skipDependencies: false };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--skip-dependencies") options.skipDependencies = true;
    else if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node scripts/install-local.mjs [options]

Options:
  --check               Verify the local installation without changing files
  --skip-dependencies   Do not run npm ci when dependencies are missing or stale
  --skip-build          Do not rebuild the production web application
  --help, -h            Show this help`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function assertNodeVersion() {
  const actual = process.versions.node.split(".").map(Number);
  for (let index = 0; index < minimumNodeVersion.length; index += 1) {
    if ((actual[index] ?? 0) > minimumNodeVersion[index]) return;
    if ((actual[index] ?? 0) < minimumNodeVersion[index]) {
      throw new Error(`Node.js 22.5 or newer is required; current version is ${process.versions.node}`);
    }
  }
}

async function fileStatus(target) {
  try {
    return await stat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function dependenciesAreCurrent() {
  const lock = await fileStatus(path.join(projectRoot, "package-lock.json"));
  const installedLock = await fileStatus(path.join(projectRoot, "node_modules", ".package-lock.json"));
  return Boolean(lock && installedLock && installedLock.mtimeMs >= lock.mtimeMs);
}

async function latestModifiedAt(target) {
  const entry = await lstat(target);
  if (!entry.isDirectory()) return entry.mtimeMs;
  const { readdir } = await import("node:fs/promises");
  const children = await readdir(target);
  const values = await Promise.all(children.map((child) => latestModifiedAt(path.join(target, child))));
  return Math.max(entry.mtimeMs, ...values);
}

async function buildIsCurrent() {
  const output = await fileStatus(path.join(projectRoot, "dist", "web", "index.html"));
  if (!output) return false;
  const inputs = [
    path.join(projectRoot, "package-lock.json"),
    path.join(projectRoot, "web", "index.html"),
    path.join(projectRoot, "web", "vite.config.ts"),
    path.join(projectRoot, "web", "src"),
  ];
  const newestInput = Math.max(...await Promise.all(inputs.map(latestModifiedAt)));
  return output.mtimeMs >= newestInput;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`));
    });
  });
}

async function linkState(source, destination) {
  let entry;
  try {
    entry = await lstat(destination);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "missing", destination };
    }
    throw error;
  }
  if (!entry.isSymbolicLink()) return { state: "conflict", destination };
  const currentTarget = path.resolve(path.dirname(destination), await readlink(destination));
  try {
    const [resolvedSource, resolvedTarget] = await Promise.all([realpath(source), realpath(currentTarget)]);
    return resolvedSource === resolvedTarget
      ? { state: "current", destination }
      : { state: "conflict", destination, currentTarget };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "conflict", destination, currentTarget };
    }
    throw error;
  }
}

async function ensureLink(source, destination, checkOnly) {
  const current = await linkState(source, destination);
  if (current.state === "conflict") {
    throw new Error(`Refusing to overwrite existing path: ${destination}`);
  }
  if (current.state === "current" || checkOnly) return current;
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(source, destination);
  return { state: "created", destination };
}

async function verifyServer() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-install-"));
  const { createTaskboardServer } = await import("../server/app.mjs");
  const app = createTaskboardServer({ dataDirectory: temporaryDirectory });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    if (!address || typeof address === "string") throw new Error("Unable to resolve verification server address");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Verification server returned HTTP ${response.status}`);
  } finally {
    await app.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  assertNodeVersion();
  if (process.platform === "win32") {
    throw new Error("The one-command installer currently supports macOS and Linux; use the manual guide on Windows");
  }

  const userHome = os.homedir();
  const dependencyCurrent = await dependenciesAreCurrent();
  if (!dependencyCurrent && !options.check && !options.skipDependencies) {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts"]);
  }

  const buildCurrent = await buildIsCurrent();
  if (!buildCurrent && !options.check && !options.skipBuild) {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
  }

  const skill = await ensureLink(
    path.join(projectRoot, "skills", "manage-taskboard"),
    path.join(userHome, ".codex", "skills", "manage-taskboard"),
    options.check,
  );
  const taskctl = await ensureLink(
    path.join(projectRoot, "cli", "taskctl.mjs"),
    path.join(userHome, ".local", "bin", "taskctl"),
    options.check,
  );

  const finalDependencies = await dependenciesAreCurrent();
  const finalBuild = await buildIsCurrent();
  const linksCurrent = [skill, taskctl].every((item) => item.state === "current" || item.state === "created");
  const ok = finalDependencies && finalBuild && linksCurrent;
  if (!options.check && ok) await verifyServer();

  console.log(JSON.stringify({
    ok,
    mode: options.check ? "check" : "install",
    projectRoot,
    nodeVersion: process.versions.node,
    dependencies: finalDependencies ? "current" : "missing-or-stale",
    build: finalBuild ? "current" : "missing-or-stale",
    skill,
    taskctl,
    next: {
      localServer: "CODEX_TASKBOARD_HOST=127.0.0.1 npm start",
      codexEmbed: "CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex",
      url: "http://127.0.0.1:47823",
    },
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
