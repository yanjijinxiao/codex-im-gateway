#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const extensions = args[args.indexOf("--extensions-dir") + 1];
const planFile = path.join(process.cwd(), "cig-fixture-plan.json");
const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, "utf8")) : {};
fs.appendFileSync(path.join(process.cwd(), "cig-fixture-calls.jsonl"), JSON.stringify(args) + "\n");
if (args.includes("--list-extensions")) {
  if (plan.failList) process.exit(1);
  const file = path.join(extensions, "fixture-installed.json");
  const installed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  console.log(Object.entries(installed).map(([id, version]) => `${id}@${version}`).join("\n")); process.exit(0);
}
if (args.includes("--install-extension")) {
  if (plan.delayInstallMs) await new Promise(resolve => setTimeout(resolve, plan.delayInstallMs));
  if (plan.failInstall) { console.error("fixture private stderr must not escape"); process.exit(1); }
  if (!plan.omitInstall) {
    fs.mkdirSync(extensions, { recursive: true });
    const file = path.join(extensions, "fixture-installed.json");
    const installed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    installed[args[args.indexOf("--install-extension") + 1]] = "0.100.1";
    fs.writeFileSync(file, JSON.stringify(installed));
  }
  process.exit(0);
}
if (args.includes("--version")) { console.log("code-server acceptance fixture"); process.exit(0); }
const socket = args[args.indexOf("--socket") + 1];
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ cwd: process.cwd(), args, url: req.url }));
});
server.listen(socket, () => fs.chmodSync(socket, 0o600));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
