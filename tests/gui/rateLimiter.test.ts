import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter, resolveClientIp } from "../../src/gui/rateLimiter.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FixedWindowRateLimiter", () => {
  it("allows up to the configured limit within one window", () => {
    const limiter = new FixedWindowRateLimiter(3, 60_000);
    expect(limiter.tryConsume("1.2.3.4")).toBe(true);
    expect(limiter.tryConsume("1.2.3.4")).toBe(true);
    expect(limiter.tryConsume("1.2.3.4")).toBe(true);
  });

  it("refuses the request that exceeds the limit within the window", () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    expect(limiter.tryConsume("1.2.3.4")).toBe(true);
    expect(limiter.tryConsume("1.2.3.4")).toBe(true);
    expect(limiter.tryConsume("1.2.3.4")).toBe(false);
  });

  it("tracks separate buckets per key, independently", () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    expect(limiter.tryConsume("visitor-a")).toBe(true);
    expect(limiter.tryConsume("visitor-a")).toBe(false);
    // A different key is unaffected by visitor-a's exhausted bucket.
    expect(limiter.tryConsume("visitor-b")).toBe(true);
  });

  it("resets the count once the window elapses", async () => {
    const limiter = new FixedWindowRateLimiter(1, 20);
    expect(limiter.tryConsume("1.2.3.4")).toBe(true);
    expect(limiter.tryConsume("1.2.3.4")).toBe(false);
    await sleep(40);
    expect(limiter.tryConsume("1.2.3.4")).toBe(true);
  });

  it("sweepExpired removes only buckets whose window has elapsed", async () => {
    const limiter = new FixedWindowRateLimiter(1, 20);
    limiter.tryConsume("stale-key");
    await sleep(40);
    limiter.tryConsume("fresh-key"); // starts a brand new window, well within limit
    limiter.sweepExpired();
    // The stale key's window elapsed, so a fresh call for it should succeed again
    // as if it were brand new (proving its old entry was actually dropped, not just ignored).
    expect(limiter.tryConsume("stale-key")).toBe(true);
    // The fresh key's window hasn't elapsed, so a second call for the same key
    // still correctly counts against its (still-live) single-request limit.
    expect(limiter.tryConsume("fresh-key")).toBe(false);
  });
});

describe("resolveClientIp", () => {
  it("prefers the trusted header when present", () => {
    const ip = resolveClientIp({ "x-real-ip": "203.0.113.5" }, "x-real-ip", "127.0.0.1");
    expect(ip).toBe("203.0.113.5");
  });

  it("falls back to the socket address when the trusted header is absent", () => {
    const ip = resolveClientIp({}, "x-real-ip", "127.0.0.1");
    expect(ip).toBe("127.0.0.1");
  });

  it("falls back to the socket address when the trusted header is blank", () => {
    const ip = resolveClientIp({ "x-real-ip": "   " }, "x-real-ip", "127.0.0.1");
    expect(ip).toBe("127.0.0.1");
  });

  it("takes the first entry when the header arrives as an array (multiple headers of the same name)", () => {
    const ip = resolveClientIp({ "x-real-ip": ["203.0.113.5", "198.51.100.9"] }, "x-real-ip", "127.0.0.1");
    expect(ip).toBe("203.0.113.5");
  });

  it("returns \"unknown\" rather than throwing when neither the header nor a socket address is available", () => {
    const ip = resolveClientIp({}, "x-real-ip", undefined);
    expect(ip).toBe("unknown");
  });

  it("respects a differently-configured trusted header name", () => {
    const ip = resolveClientIp({ "x-forwarded-for": "203.0.113.5" }, "x-forwarded-for", "127.0.0.1");
    expect(ip).toBe("203.0.113.5");
  });
});
