/** Shared by persisted configuration, HTTP settings, the client and the owned
 * listener. A configured origin must describe the service we actually bind. */
export function taskboardOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Taskboard URL must use an HTTP loopback origin");
  return url;
}

/** The bundled independent server supports IPv4 only. The standalone client
 * can still connect to an externally supplied IPv6 loopback service. */
export function managedTaskboardOrigin(value: string): URL {
  const url = taskboardOrigin(value);
  if (url.hostname === "[::1]") throw new Error("Managed Taskboard requires an HTTP IPv4 loopback origin; bundled server does not support IPv6");
  return url;
}
export function validManagedTaskboardOrigin(value: string): boolean {
  try { managedTaskboardOrigin(value); return true; } catch { return false; }
}
