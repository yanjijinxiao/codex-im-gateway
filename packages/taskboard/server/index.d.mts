import type { AddressInfo } from "node:net";

export type TaskboardServerOptions = {
  dataDirectory?: string;
  databasePath?: string;
  attachmentsDirectory?: string;
  cloudConfigPath?: string;
  staticDirectory?: string;
  skillPath?: string;
  codexExecutable?: string;
  codexStatePath?: string;
  codexProcessesPath?: string;
};

export type TaskboardServer = {
  listen(options?: { host?: "127.0.0.1" | "0.0.0.0"; port?: number }): Promise<AddressInfo | string | null>;
  close(): Promise<void>;
};

export declare function createTaskboardServer(options?: TaskboardServerOptions): TaskboardServer;
export declare function resolveHost(value?: string): "127.0.0.1" | "0.0.0.0";
export declare function resolvePort(value?: string | number): number;
export declare function resolveServerOptions(options?: TaskboardServerOptions): Required<TaskboardServerOptions>;
