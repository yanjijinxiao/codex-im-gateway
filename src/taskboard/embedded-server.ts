import type { AddressInfo } from "node:net";

import { createTaskboardServer } from "codex-taskboard/server";

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
}): Promise<EmbeddedTaskboard> {
  const taskboard = createTaskboardServer({ dataDirectory: options.dataDirectory });
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
    throw new EmbeddedTaskboardStartError(
      `Unable to start the embedded Taskboard on port ${options.port}`,
      cause
    );
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
