/**
 * Tiny fixed-window counter — no new dependency. Two independent instances
 * are used: one for demo's expensive actions (keyed by client IP), one for
 * login attempts across admin/workbench (keyed by `ip + ":" + urlPrefix`).
 * A hygiene sweep, not a security boundary — fixed windows are simpler than
 * sliding ones and that's enough here.
 */
export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  tryConsume(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}

/**
 * Resolves the real client IP for rate-limiting purposes. This process only
 * ever binds 127.0.0.1 behind a reverse proxy, so `socketRemoteAddress`
 * alone would be the proxy's own address on every request, not the
 * visitor's — the header named by `env.trustedClientIpHeader` (default
 * x-real-ip, expected to be SET — not appended to — by the fronting proxy,
 * e.g. nginx's `proxy_set_header X-Real-IP $remote_addr;`) is preferred.
 * This is a deployment-time dependency this code cannot self-verify: a
 * misconfigured proxy that appends to a client-spoofable X-Forwarded-For
 * instead would let a malicious visitor bypass the limiter entirely.
 */
export function resolveClientIp(
  headers: Record<string, string | string[] | undefined>,
  trustedHeaderName: string,
  socketRemoteAddress: string | undefined
): string {
  const headerValue = headers[trustedHeaderName];
  const fromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return fromHeader?.trim() || socketRemoteAddress || "unknown";
}
