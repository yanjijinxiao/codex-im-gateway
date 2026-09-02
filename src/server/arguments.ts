export type ServerCommand = "start" | "help";

export function parseServerCommand(args: string[]): ServerCommand {
  if (args.length === 0) {
    return "start";
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return "help";
  }
  throw new Error(`Unknown argument: ${args.join(" ")}. Run codex-im-gateway --help.`);
}

export function serverHelpText(): string {
  return [
    "Usage: codex-im-gateway",
    "",
    "Starts the local Codex IM Gateway Web service.",
    "",
    "Options:",
    "  -h, --help  Show this help without starting the service",
    "",
    "Environment:",
    "  CODEX_IM_GATEWAY_PORT       Local Web port (default: 8787)",
    "  CODEX_IM_GATEWAY_STATE_DIR  State directory (default: ~/.codex-im-gateway)",
    "  CODEX_IM_GATEWAY_OPEN=0     Do not open the browser automatically",
    "",
    "Legacy CODEX_CHANNEL_BRIDGE_* and CODEX_WEIXIN_* variables remain supported."
  ].join("\n");
}
