/** Process transport carrying app-server JSONL messages over stdin/stdout. */
export type AppServerTransport = {
  readonly command: string;
  readonly args: readonly string[];
  readonly label?: string;
  readonly mode?: "stdio" | "daemon-proxy" | "remote-daemon";
  readonly prepare?: () => Promise<void>;
};
