import { DWClient, type DWClientDownStream } from "dingtalk-stream";
import type { ChannelConnectionStatus } from "./types.js";

type Phase = "idle" | "endpoint" | "handshake" | "connected" | "retry_wait" | "disconnected" | "stopped";
type SafeFailure = { category: string; code?: string; httpStatus?: number };
type DiagnosticRecord = Record<string, string | number | undefined>;
type DiagnosticsOptions = {
  now?: () => number;
  log?: (level: "info" | "warn", record: DiagnosticRecord) => void;
};

const STALL_MS = 30_000;
const WARNING_INTERVAL_MS = 60_000;
const SAFE_ERROR_CODES = new Set([
  "ETIMEDOUT", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EPIPE",
  "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "ERR_NETWORK",
  "ERR_BAD_REQUEST", "ERR_BAD_RESPONSE", "ERR_CANCELED", "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"
]);

/** Never serialize SDK errors: Axios config/response and socket URLs can contain secrets. */
function safeFailure(error: unknown): SafeFailure {
  const value = error as { code?: unknown; response?: { status?: unknown }; message?: unknown } | undefined;
  const code = typeof value?.code === "string" && SAFE_ERROR_CODES.has(value.code) ? value.code : undefined;
  const responseStatus = value?.response?.status;
  // ws puts a rejected handshake's HTTP status in this fixed message, not response.status.
  const handshakeStatus = typeof value?.message === "string"
    ? /^Unexpected server response: ([1-5]\d{2})$/.exec(value.message)?.[1] : undefined;
  const status = typeof responseStatus === "number" ? responseStatus : Number(handshakeStatus);
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const category = httpStatus === 401 || httpStatus === 403 ? "authentication_or_permission"
    : httpStatus ? "http_rejected"
    : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "dns"
    : code === "ETIMEDOUT" || code === "ECONNABORTED" ? "network_timeout"
    : code?.includes("CERT") || code?.includes("TLS") ? "tls"
    : code ? "transport" : "unknown";
  return { category, ...(code ? { code } : {}), ...(httpStatus ? { httpStatus } : {}) };
}

/**
 * Observes the installed dingtalk-stream SDK without changing its retry policy.
 * Public method hooks expose failures the SDK otherwise swallows. printDebug is
 * intentionally NOT forwarded: native debug includes credentials and tickets.
 * Only exact, known lifecycle messages from SDK 2.1.6-beta.1 are recognized;
 * unknown debug output (including config, frames and error messages) is discarded.
 */
export class DiagnosticDingTalkStreamClient extends DWClient {
  private readonly clock: () => number;
  private readonly logger: NonNullable<DiagnosticsOptions["log"]>;
  private phase: Phase = "idle";
  private phaseStartedAt: number;
  private readonly runId: string;
  private attempt = 0;
  private attemptPending = false;
  private attemptStartedAt = 0;
  private offlineSince?: number;
  private lastConnectedAt?: number;
  private lastFrameAt?: number;
  private lastWarningAt?: number;
  private retryDelayMs = 0;
  private failure?: SafeFailure;

  constructor(
    private readonly accountId: string,
    config: { clientId: string; clientSecret: string; keepAlive?: boolean },
    options: DiagnosticsOptions = {}
  ) {
    super({ ...config, debug: false });
    this.clock = options.now ?? Date.now;
    this.phaseStartedAt = this.clock();
    this.runId = `${process.pid}-${this.phaseStartedAt}`;
    this.logger = options.log ?? ((level, record) => {
      console[level](`[codex-im-gateway] DingTalk Stream ${JSON.stringify(record)}`);
    });
  }

  override async connect(): Promise<void> {
    if (this.attemptPending) {
      this.warnPeriodically("connect_skipped_pending");
      return;
    }
    this.attemptPending = true;
    this.attempt += 1;
    this.attemptStartedAt = this.clock();
    this.offlineSince ??= this.attemptStartedAt;
    this.failure = undefined;
    this.transition("endpoint");
    this.write("info", "connect_attempt");
    try {
      await super.connect();
      if (this.phase !== "stopped" && this.connected) this.markConnected();
    } finally {
      this.attemptPending = false;
    }
  }

  override async getEndpoint(): Promise<this> {
    try {
      const result = await super.getEndpoint();
      if (this.phase !== "stopped") this.write("info", "endpoint_ready");
      return result;
    } catch (error) {
      this.recordFailure(error);
      throw error; // Preserve SDK retry behavior, but do not log its raw error.
    }
  }

  override async _connect(): Promise<void> {
    if (this.phase !== "stopped") this.transition("handshake");
    try {
      await super._connect();
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  override printDebug(message: object | string): void {
    if (typeof message !== "string" || this.phase === "stopped") return;
    const retry = /^Reconnecting in (\d+(?:\.\d+)?) seconds\.\.\. \(attempt \d+\)$/.exec(message);
    if (retry) {
      this.retryDelayMs = Math.round(Number(retry[1]) * 1_000);
      this.transition("retry_wait");
      this.write("info", "retry_scheduled", { retryDelayMs: this.retryDelayMs, nextAttempt: this.attempt + 1 });
    } else if (message === "Socket closed") {
      this.markDisconnected("socket_closed");
    } else if (message === "SOCKET ERROR") {
      // Established-socket errors aren't rethrown by this SDK. Don't invent a code.
      this.write("warn", "socket_error");
    }
  }

  override onDownStream(data: string): void {
    this.lastFrameAt = this.clock();
    super.onDownStream(data);
  }

  override onSystem(frame: DWClientDownStream): void {
    super.onSystem(frame);
    if (this.phase === "stopped") return;
    if (frame.headers.topic === "disconnect") this.markDisconnected("server_disconnect");
    else if (frame.headers.topic === "REGISTERED") this.write("info", "registered");
  }

  override disconnect(): void {
    if (this.phase === "stopped") return;
    this.transition("stopped");
    this.write("info", "monitor_stopped");
    super.disconnect();
  }

  /** Called by the adapter health timer, including while initial connect is pending. */
  connectionStatus(): ChannelConnectionStatus {
    if (this.phase === "stopped") return { state: "stopped" };
    if (this.connected) {
      this.markConnected();
      return { state: "connected" };
    }
    if (this.phase === "connected") this.markDisconnected("connection_lost");
    const elapsed = this.clock() - this.phaseStartedAt;
    const waiting = this.phase === "endpoint" || this.phase === "handshake";
    if ((waiting && elapsed >= STALL_MS)
      || (this.phase === "retry_wait" && elapsed >= this.retryDelayMs + STALL_MS)) {
      this.warnPeriodically("connection_stalled");
      return { state: "error", detail: `DingTalk Stream ${this.phase} 等待超过 30 秒，尚未恢复；请检查连接诊断日志。` };
    }
    if (this.phase === "disconnected" || this.phase === "idle") {
      this.warnPeriodically("disconnected_without_retry");
      return { state: "error", detail: "DingTalk Stream 已断开，未观察到重连安排；请检查连接诊断日志。" };
    }
    return { state: this.attempt <= 1 && this.phase !== "retry_wait" ? "connecting" : "reconnecting" };
  }

  private recordFailure(error: unknown): void {
    if (this.phase === "stopped") return;
    this.failure = safeFailure(error);
    this.write("warn", "connect_failed", this.failure);
    this.transition("disconnected");
  }

  private markConnected(): void {
    if (this.phase === "connected") return;
    this.lastConnectedAt = this.clock();
    this.transition("connected");
    this.write("info", "connected", { connectElapsedMs: this.clock() - this.attemptStartedAt });
    this.offlineSince = undefined;
    this.failure = undefined;
  }

  private markDisconnected(event: string): void {
    this.offlineSince ??= this.clock();
    this.transition("disconnected");
    this.write("warn", event);
  }

  private transition(phase: Phase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseStartedAt = this.clock();
    this.lastWarningAt = undefined;
  }

  private warnPeriodically(event: string): void {
    if (this.lastWarningAt !== undefined && this.clock() - this.lastWarningAt < WARNING_INTERVAL_MS) return;
    this.lastWarningAt = this.clock();
    this.write("warn", event, this.failure);
  }

  private write(level: "info" | "warn", event: string, extra: DiagnosticRecord = {}): void {
    const now = this.clock();
    try {
      this.logger(level, {
        timestamp: new Date(now).toISOString(), accountId: this.accountId, runId: this.runId, event,
        phase: this.phase, attempt: this.attempt, retryCount: Math.max(0, this.attempt - 1),
        phaseElapsedMs: Math.max(0, now - this.phaseStartedAt),
        ...(this.offlineSince !== undefined ? { disconnectedMs: Math.max(0, now - this.offlineSince) } : {}),
        ...(this.lastConnectedAt !== undefined ? { lastConnectedAt: new Date(this.lastConnectedAt).toISOString() } : {}),
        ...(this.lastFrameAt !== undefined ? { lastFrameAt: new Date(this.lastFrameAt).toISOString() } : {}),
        ...extra
      });
    } catch {
      // Observability must never break the SDK's connection or retry loop.
    }
  }
}
