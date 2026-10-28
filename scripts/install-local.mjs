#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readlink, realpath, stat, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const taskboardRoot = path.join(projectRoot, "taskboard");

function parseOptions(argv) {
  const options = { check: false, skipDependencies: false, skipBuild: false };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else if (argument === "--skip-dependencies") options.skipDependencies = true;
    else if (argument === "--skip-build") options.skipBuild = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
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

async function buildIsCurrent() {
  const server = await fileStatus(path.join(projectRoot, "dist", "server", "index.js"));
  const taskboard = await fileStatus(path.join(taskboardRoot, "dist", "web", "index.html"));
  return Boolean(server && taskboard);
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

// .cmd files cannot be spawned directly without a Windows shell. Run npm's
// JavaScript entry with Node so paths remain individual, unquoted arguments.
function npmCommand(args) {
  const paths = process.platform === "win32" ? path.win32 : path;
  const nodeDirectory = paths.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    paths.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    paths.join(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  const cli = candidates.find(candidate => candidate && paths.isAbsolute(candidate)
    && /\.(?:c?js|mjs)$/i.test(candidate) && existsSync(candidate));
  if (cli) return { command: process.execPath, args: [cli, ...args] };
  if (process.platform === "win32") throw new Error("无法找到 npm-cli.js；请通过 npm run install:local 运行，或修复 Node.js/npm 安装");
  return { command: "npm", args };
}

async function runNpm(args) {
  const invocation = npmCommand(args);
  await run(invocation.command, invocation.args);
}

async function ensureLink(source, destination, checkOnly) {
  let entry;
  try {
    entry = await lstat(destination);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (entry && !entry.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite non-symlink path: ${destination}`);
  }
  if (entry) {
    const currentTarget = path.resolve(path.dirname(destination), await readlink(destination));
    try {
      if (await realpath(currentTarget) === await realpath(source)) return "current";
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (checkOnly) return "stale";
    await unlink(destination);
  } else if (checkOnly) {
    return "missing";
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(source, destination);
  return entry ? "migrated" : "created";
}

async function ensureBundledSkillLinks(home, checkOnly) {
  const skillsRoot = path.join(taskboardRoot, "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillNames = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillEntry = await fileStatus(path.join(skillsRoot, entry.name, "SKILL.md"));
    if (skillEntry?.isFile()) skillNames.push(entry.name);
  }
  skillNames.sort((left, right) => left.localeCompare(right));
  const statuses = await Promise.all(skillNames.map(async (skillName) => [
    skillName,
    await ensureLink(
      path.join(skillsRoot, skillName),
      path.join(home, ".codex", "skills", skillName),
      checkOnly
    )
  ]));
  return Object.fromEntries(statuses);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error(`Node.js 22 or newer is required; current version is ${process.versions.node}`);
  }
  if (!options.check && !options.skipDependencies && !await dependenciesAreCurrent()) {
    await runNpm(["ci", "--ignore-scripts"]);
  }
  if (!options.check && !options.skipBuild) await runNpm(["run", "build"]);

  const home = os.homedir();
  const links = {
    taskctl: await ensureLink(
      path.join(taskboardRoot, "cli", "taskctl.mjs"),
      path.join(home, ".local", "bin", "taskctl"),
      options.check
    ),
    skills: await ensureBundledSkillLinks(home, options.check)
  };
  const linkStatuses = [links.taskctl, ...Object.values(links.skills)];
  const ok = (options.skipDependencies || await dependenciesAreCurrent())
    && (options.skipBuild || await buildIsCurrent())
    && linkStatuses.every((value) => value === "current" || value === "created" || value === "migrated");
  console.log(JSON.stringify({
    ok,
    mode: options.check ? "check" : "install",
    projectRoot,
    taskboardRoot,
    stateDirectory: path.join(home, ".codex-im-gateway", "taskboard"),
    links,
    urls: { admin: "http://127.0.0.1:8787", taskboard: "http://127.0.0.1:47823" }
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
