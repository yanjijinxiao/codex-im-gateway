/** Shared finite network budget. This layer never retries an uncertain write. */
export type NetworkRequestInit = RequestInit & { timeoutMs?: number; maxResponseBytes?: number };
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function requestSignal(init?: NetworkRequestInit): AbortSignal {
  const timeoutMs = init?.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Network request timeout must be a positive timer-safe integer");
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  return init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
}

export async function fetchWithBudget(fetchImpl: Fetch, input: string | URL, init?: NetworkRequestInit): Promise<Response> {
  const signal = requestSignal(init);
  const maxBytes = init?.maxResponseBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Network response byte budget must be a positive integer");
  signal.throwIfAborted();
  const pending = fetchImpl(input, { ...init, signal });
  // Test/provider transports may ignore cancellation. Retire their late body
  // without allowing it to become an accepted acknowledgement.
  void pending.then((response) => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
  const response = await withSignal(pending, signal);
  return boundedResponse(response, signal, maxBytes);
}

async function withSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

function boundedResponse(response: Response, signal: AbortSignal, maxBytes: number): Response {
  signal.throwIfAborted();
  if (!response.body) return response;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body.cancel().catch(() => undefined);
    throw new RangeError(`Network response exceeds byte limit (${maxBytes})`);
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let closed = false;
  let abort!: () => void;
  function finish() {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined).finally(() => reader.releaseLock());
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => { if (!closed) { controller.error(signal.reason); finish(); } };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) { controller.close(); finish(); return; }
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw new RangeError(`Network response exceeds byte limit (${maxBytes})`);
        controller.enqueue(next.value);
      } catch (error) { if (!closed) { controller.error(error); finish(); } }
    },
    cancel() { finish(); }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
