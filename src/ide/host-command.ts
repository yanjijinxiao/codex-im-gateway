import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { resolveRemoteSshConnection, type RemoteCodexTransportOptions } from "../codex/remote-host.js";

const exec = promisify(execFile);
export function ideSshConnection(hostId: string, options: RemoteCodexTransportOptions = {}) {
  const ssh = resolveRemoteSshConnection(hostId, options);
  return { ...ssh, args: [...ssh.args, "-o", "ControlMaster=no", "-o", "ControlPath=none"] };
}
export function ideHostCommand(hostId: string, script: string, input: object) {
  const data = Buffer.from(JSON.stringify(input)).toString("base64");
  if (hostId === "local") return { command: process.execPath, args: ["-e", script, data] };
  const ssh = ideSshConnection(hostId), code = Buffer.from(script).toString("base64");
  return { command: ssh.command, args: [...ssh.args, ssh.target,
    `exec node -e "eval(Buffer.from('${code}','base64').toString())" '${data}'`] };
}
export async function runIDEHost<T>(hostId: string, script: string, input: object, signal?: AbortSignal, timeout = 30_000): Promise<T> {
  const call = ideHostCommand(hostId, script, input);
  const { stdout } = await exec(call.command, call.args, { timeout, signal, maxBuffer: 1_000_000, windowsHide: true });
  return JSON.parse(stdout) as T;
}
export async function uploadIDEHost(hostId: string, script: string, input: object, file: string, signal: AbortSignal): Promise<void> {
  const call = ideHostCommand(hostId, script, input);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(call.command, call.args, { signal, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    const source = fs.createReadStream(file); child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.once("error", reject); source.once("error", reject); child.stdin.on("error", reject);
    child.once("close", code => { clearTimeout(timer); source.destroy(); code === 0 ? resolve() : reject(new Error("SSH 制品传输失败，可重试")); });
    source.pipe(child.stdin);
  });
}
