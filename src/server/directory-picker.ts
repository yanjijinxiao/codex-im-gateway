import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type DirectoryPickerCommand = {
  command: string;
  args: string[];
};

type DirectoryPickerDependencies = {
  platform?: NodeJS.Platform;
  run?: (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
};

const MACOS_PICKER_SCRIPT = `on run argv
  if (count of argv) > 0 then
    set selectedFolder to choose folder with prompt "选择 llm-wiki 目录" default location (POSIX file (item 1 of argv))
  else
    set selectedFolder to choose folder with prompt "选择 llm-wiki 目录"
  end if
  return POSIX path of selectedFolder
end run`;

const WINDOWS_PICKER_SCRIPT = (initialDirectory?: string): string => {
  const initialDirectoryBase64 = Buffer.from(initialDirectory ?? "", "utf8").toString("base64");
  return `$initialDirectory = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${initialDirectoryBase64}'))
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 llm-wiki 目录'
$dialog.ShowNewFolderButton = $true
if ($initialDirectory) { $dialog.SelectedPath = $initialDirectory }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}`;
};

export async function selectLocalDirectory(
  defaultPath?: string,
  dependencies: DirectoryPickerDependencies = {}
): Promise<string | undefined> {
  const platform = dependencies.platform ?? process.platform;
  const initialDirectory = defaultPath ? path.resolve(defaultPath) : undefined;
  const picker = directoryPickerCommand(platform, initialDirectory);
  const run = dependencies.run ?? runDirectoryPickerCommand;
  try {
    const result = await run(picker.command, picker.args);
    const selected = result.stdout.trim();
    return selected ? path.resolve(selected) : undefined;
  } catch (error) {
    if (isDirectoryPickerCancellation(error, platform)) return undefined;
    const code = commandErrorCode(error);
    if (code === "ENOENT") {
      const dependency = platform === "linux" ? "zenity" : picker.command;
      throw new Error(`当前系统缺少目录选择器命令：${dependency}`);
    }
    throw new Error(`无法打开系统目录选择器：${error instanceof Error ? error.message : String(error)}`);
  }
}

function directoryPickerCommand(platform: NodeJS.Platform, initialDirectory?: string): DirectoryPickerCommand {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", MACOS_PICKER_SCRIPT, ...(initialDirectory ? [initialDirectory] : [])]
    };
  }
  if (platform === "win32") {
    const encodedCommand = Buffer.from(WINDOWS_PICKER_SCRIPT(initialDirectory), "utf16le").toString("base64");
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-EncodedCommand",
        encodedCommand
      ]
    };
  }
  if (platform === "linux") {
    return {
      command: "zenity",
      args: [
        "--file-selection",
        "--directory",
        "--title=选择 llm-wiki 目录",
        ...(initialDirectory ? [`--filename=${initialDirectory}${path.sep}`] : [])
      ]
    };
  }
  throw new Error(`当前系统暂不支持目录选择：${platform}`);
}

async function runDirectoryPickerCommand(
  command: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, [...args], {
    encoding: "utf8",
    timeout: 10 * 60 * 1_000,
    windowsHide: false
  });
}

function isDirectoryPickerCancellation(error: unknown, platform: NodeJS.Platform): boolean {
  const code = commandErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (platform === "darwin") return code === 1 && /User canceled|\(-128\)/i.test(message);
  return platform === "linux" && code === 1;
}

function commandErrorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}
