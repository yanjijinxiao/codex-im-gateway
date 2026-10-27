import https from "node:https";
import { Readable } from "node:stream";
import { fetchWithBudget, requestSignal, type NetworkRequestInit } from "./network-request.js";

export const NETWORK_FAMILY_POLICIES = ["auto", "ipv4", "ipv6"] as const;

export type NetworkFamilyPolicy = typeof NETWORK_FAMILY_POLICIES[number];
export type ResolvedNetworkFamily = 4 | 6;
export type { NetworkRequestInit } from "./network-request.js";
export type FamilyBoundFetch = (
  family: ResolvedNetworkFamily,
  input: string | URL,
  init?: NetworkRequestInit
) => Promise<Response>;

type NetworkLifecycle = {
  family?: ResolvedNetworkFamily;
  selection?: Promise<void>;
};

/**
 * Chooses an address family once for a logical request lifecycle and pins all
 * later requests in that lifecycle to the same family. `auto` may probe the
 * other family only before the first accepted response; it never changes a
 * family after the lifecycle has started successfully.
 */
export class PinnedNetworkLifecycleTransport {
  private readonly lifecycles = new Map<string, NetworkLifecycle>();

  constructor(
    readonly policy: NetworkFamilyPolicy = "auto",
    private readonly requestByFamily: FamilyBoundFetch = fetchHttpsWithFamily
  ) {}

  async request(lifecycleId: string, input: string | URL, init?: NetworkRequestInit): Promise<Response> {
    const id = lifecycleId.trim();
    if (!id) throw new Error("Network lifecycle ID must not be empty");
    const options = { ...init, signal: requestSignal(init) };
    const signal = options.signal;
    const lifecycle = this.lifecycles.get(id) ?? {};
    this.lifecycles.set(id, lifecycle);
    // The first emotion, card and media request can start concurrently. Only
    // one of them may negotiate; all others must inherit its accepted family.
    while (lifecycle.selection) await waitForSelection(lifecycle.selection, signal);
    signal.throwIfAborted();
    if (lifecycle.family) {
      return this.fetch(lifecycle.family, input, options);
    }
    let release!: () => void;
    lifecycle.selection = new Promise<void>((resolve) => { release = resolve; });
    try { return await this.selectFamily(lifecycle, input, options); }
    finally { lifecycle.selection = undefined; release(); }
  }

  private fetch(family: ResolvedNetworkFamily, input: string | URL, init: NetworkRequestInit): Promise<Response> {
    return fetchWithBudget((url, options) => this.requestByFamily(family, url, options), input, init);
  }

  private async selectFamily(lifecycle: NetworkLifecycle, input: string | URL, init: NetworkRequestInit & { signal: AbortSignal }): Promise<Response> {
    const candidates = networkFamilyCandidates(this.policy);
    let lastError: unknown;
    for (const [index, family] of candidates.entries()) {
      try {
        const response = await this.fetch(family, input, init);
        const mayTryNext = index + 1 < candidates.length;
        if (mayTryNext && await isDingTalkIpAllowlistRejection(response)) {
          void response.body?.cancel().catch(() => undefined);
          continue;
        }
        init.signal.throwIfAborted();
        lifecycle.family = family;
        return response;
      } catch (error) {
        lastError = error;
        if (index + 1 >= candidates.length || !isNetworkFamilyUnavailable(error)) throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Network family selection failed"));
  }

  resolvedFamily(lifecycleId: string): ResolvedNetworkFamily | undefined {
    return this.lifecycles.get(lifecycleId)?.family;
  }

  close(lifecycleId: string): void {
    this.lifecycles.delete(lifecycleId);
  }
}

async function waitForSelection(selection: Promise<void>, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return selection;
  return new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void selection.then(() => { signal.removeEventListener("abort", abort); resolve(); });
  });
}

function networkFamilyCandidates(policy: NetworkFamilyPolicy): readonly ResolvedNetworkFamily[] {
  if (policy === "ipv4") return [4];
  if (policy === "ipv6") return [6];
  return [4, 6];
}

async function isDingTalkIpAllowlistRejection(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const body = await response.clone().text().catch(() => "");
  return /IpNotInWhiteList|访问ip不在白名单/i.test(body);
}

function isNetworkFamilyUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EAFNOSUPPORT"
    || code === "EADDRNOTAVAIL"
    || code === "ENETUNREACH"
    || code === "EHOSTUNREACH"
    || code === "ENOTFOUND";
}

function fetchHttpsWithFamily(
  family: ResolvedNetworkFamily,
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "https:") return Promise.reject(new Error("Network lifecycle URL must use HTTPS"));
  const body = init?.body;
  if (
    body !== undefined
    && body !== null
    && typeof body !== "string"
    && !(body instanceof Uint8Array)
  ) {
    return Promise.reject(new TypeError("Unsupported network lifecycle request body"));
  }
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(url, {
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      family,
      ...(init?.signal ? { signal: init.signal } : {})
    }, (response) => {
      try {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name && value !== undefined) headers.append(name, value);
        }
        const status = response.statusCode ?? 502;
        const empty = init?.method === "HEAD" || status === 204 || status === 205 || status === 304;
        const responseBody = empty ? null : Readable.toWeb(response, {
          strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength }
        }) as ReadableStream<Uint8Array>;
        if (empty) response.resume();
        resolve(new Response(responseBody, {
          status,
          statusText: response.statusMessage,
          headers
        }));
      } catch (error) { response.destroy(); reject(error); }
    });
    request.on("error", reject);
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}
