export type ServerCommand = "start" | "help";

export function parseServerCommand(args: string[]): ServerCommand {
  if (args.length === 0) {
    return "start";
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return "help";
  }
  throw new Error(`Unknown argument: ${args.join(" ")}. Run codex-channel-bridge --help.`);
}

export function serverHelpText(): string {
  return [
    "Usage: codex-channel-bridge",
    "",
    "Starts the local Codex Channel Bridge Web service.",
    "",
    "Options:",
    "  -h, --help  Show this help without starting the service",
    "",
    "Environment:",
    "  CODEX_CHANNEL_BRIDGE_PORT       Local Web port (default: 8787)",
    "  CODEX_CHANNEL_BRIDGE_STATE_DIR  State directory (default: legacy ~/.codex-weixin)",
    "  CODEX_CHANNEL_BRIDGE_OPEN=0     Do not open the browser automatically",
    "",
    "Legacy CODEX_WEIXIN_* variables remain supported."
  ].join("\n");
}
