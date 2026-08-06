import type { AddressInfo } from "node:net";

import { createTaskboardServer } from "codex-taskboard/server";
import { TaskboardClient } from "./client.js";

export type EmbeddedTaskboard = {
  url: string;
  close(): Promise<void>;
};

export class EmbeddedTaskboardStartError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "EmbeddedTaskboardStartError";
    this.cause = cause;
  }
}

export async function startEmbeddedTaskboard(options: {
  dataDirectory: string;
  port: number;
  codexExecutable?: string;
}): Promise<EmbeddedTaskboard> {
  const existing = await reuseHealthyTaskboard(options.port);
  if (existing) return existing;
  const taskboard = createTaskboardServer({
    dataDirectory: options.dataDirectory,
    codexExecutable: options.codexExecutable
  });
  try {
    const address = await taskboard.listen({ host: "127.0.0.1", port: options.port });
    if (!isAddressInfo(address)) {
      throw new Error("Taskboard did not return a TCP listening address");
    }
    let closePromise: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () => {
        closePromise ??= taskboard.close();
        return closePromise;
      }
    };
  } catch (cause) {
    await taskboard.close().catch(() => undefined);
    const raced = await reuseHealthyTaskboard(options.port);
    if (raced) return raced;
    throw new EmbeddedTaskboardStartError(
      `Unable to start the embedded Taskboard on port ${options.port}`,
      cause
    );
  }
}

async function reuseHealthyTaskboard(port: number): Promise<EmbeddedTaskboard | undefined> {
  if (port === 0) return undefined;
  const url = `http://127.0.0.1:${port}`;
  try {
    await new TaskboardClient({ baseUrl: url, timeoutMs: 1_500 }).health();
    return { url, close: () => Promise.resolve() };
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

export function embeddedTaskboardPort(taskboardUrl: string): number {
  const url = new URL(taskboardUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new EmbeddedTaskboardStartError(
      "Managed Taskboard URL must use an HTTP loopback origin",
      taskboardUrl
    );
  }
  return url.port ? Number(url.port) : 80;
}

function isAddressInfo(address: AddressInfo | string | null): address is AddressInfo {
  return typeof address === "object" && address !== null && typeof address.port === "number";
}
