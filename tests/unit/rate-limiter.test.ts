import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createRedisClient, type RedisClient } from "@sentinel/redis";
import { createRateLimiter, type RateLimiter } from "@sentinel/rate-limiter";
import { createLogger } from "@sentinel/logger";

const logger = createLogger({ name: "test", level: "silent" });
let client: RedisClient;
let limiter: RateLimiter;

beforeAll(async () => {
  client = createRedisClient({ url: process.env.TEST_REDIS_URL ?? "redis://localhost:6379", logger });
  await new Promise<void>((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("error", reject);
  });
  limiter = createRateLimiter({ client, logger, fallbackMode: "fail-open" });
});

beforeEach(async () => {
  await client.flushall();
});

afterAll(async () => {
  await client.quit();
});

describe("fixed-window rate limiter", () => {
  it("allows requests up to the limit and blocks beyond it", async () => {
    const key = { policyName: "fw-test", identity: { type: "ip" as const, value: "1.1.1.1" } };
    const cfg = { limit: 3, windowSeconds: 2, strategy: "fixed-window" as const };

    const r1 = await limiter.check(key, cfg);
    const r2 = await limiter.check(key, cfg);
    const r3 = await limiter.check(key, cfg);
    const r4 = await limiter.check(key, cfg);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets the window after it expires", async () => {
    const key = { policyName: "fw-reset", identity: { type: "ip" as const, value: "1.1.1.2" } };
    const cfg = { limit: 1, windowSeconds: 1, strategy: "fixed-window" as const };

    const r1 = await limiter.check(key, cfg);
    const r2 = await limiter.check(key, cfg);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const r3 = await limiter.check(key, cfg);
    expect(r3.allowed).toBe(true);
  });

  it("tracks separate identities independently", async () => {
    const cfg = { limit: 1, windowSeconds: 5, strategy: "fixed-window" as const };
    const a = await limiter.check({ policyName: "fw-iso", identity: { type: "ip", value: "2.2.2.2" } }, cfg);
    const b = await limiter.check({ policyName: "fw-iso", identity: { type: "ip", value: "3.3.3.3" } }, cfg);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});

describe("sliding-window rate limiter", () => {
  it("allows requests up to the limit and blocks beyond it", async () => {
    const key = { policyName: "sw-test", identity: { type: "ip" as const, value: "4.4.4.4" } };
    const cfg = { limit: 3, windowSeconds: 2, strategy: "sliding-window" as const };

    const results = await Promise.all([1, 2, 3, 4].map(() => limiter.check(key, cfg)));
    const allowedCount = results.filter((r) => r.allowed).length;
    // Concurrent calls race on the same window; at most `limit` should be allowed.
    expect(allowedCount).toBeLessThanOrEqual(3);
    expect(results.some((r) => !r.allowed)).toBe(true);
  });

  it("provides an accurate rolling window (does not hard-reset at a boundary)", async () => {
    const key = { policyName: "sw-rolling", identity: { type: "ip" as const, value: "5.5.5.5" } };
    const cfg = { limit: 2, windowSeconds: 2, strategy: "sliding-window" as const };

    await limiter.check(key, cfg); // t=0
    await new Promise((r) => setTimeout(r, 1000));
    await limiter.check(key, cfg); // t=1s, still within window of the first
    const blocked = await limiter.check(key, cfg); // t=1s, should now be blocked (2 in window)
    expect(blocked.allowed).toBe(false);

    // Wait for the first request to roll out of the 2s window.
    await new Promise((r) => setTimeout(r, 1200));
    const allowed = await limiter.check(key, cfg);
    expect(allowed.allowed).toBe(true);
  });
});

describe("token-bucket rate limiter", () => {
  it("allows a burst up to capacity then blocks", async () => {
    const key = { policyName: "tb-test", identity: { type: "ip" as const, value: "6.6.6.6" } };
    const cfg = {
      limit: 3,
      windowSeconds: 3,
      strategy: "token-bucket" as const,
      burstCapacity: 3,
      refillRatePerSecond: 1,
    };

    const r1 = await limiter.check(key, cfg);
    const r2 = await limiter.check(key, cfg);
    const r3 = await limiter.check(key, cfg);
    const r4 = await limiter.check(key, cfg);

    expect(r1.allowed && r2.allowed && r3.allowed).toBe(true);
    expect(r4.allowed).toBe(false);
  });

  it("refills tokens over time", async () => {
    const key = { policyName: "tb-refill", identity: { type: "ip" as const, value: "7.7.7.7" } };
    const cfg = {
      limit: 1,
      windowSeconds: 2,
      strategy: "token-bucket" as const,
      burstCapacity: 1,
      refillRatePerSecond: 1,
    };

    const r1 = await limiter.check(key, cfg);
    const r2 = await limiter.check(key, cfg);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const r3 = await limiter.check(key, cfg);
    expect(r3.allowed).toBe(true);
  });
});

describe("Redis failure fallback", () => {
  it("fails open (allows requests) when configured and Redis is unreachable", async () => {
    const badClient = createRedisClient({ url: "redis://localhost:6399", logger });
    const failOpenLimiter = createRateLimiter({ client: badClient, logger, fallbackMode: "fail-open" });

    const result = await failOpenLimiter.check(
      { policyName: "fallback-open", identity: { type: "ip", value: "8.8.8.8" } },
      { limit: 1, windowSeconds: 1, strategy: "fixed-window" }
    );
    expect(result.allowed).toBe(true);
    badClient.disconnect();
  });

  it("fails closed (blocks requests) when configured and Redis is unreachable", async () => {
    const badClient = createRedisClient({ url: "redis://localhost:6399", logger });
    const failClosedLimiter = createRateLimiter({ client: badClient, logger, fallbackMode: "fail-closed" });

    const result = await failClosedLimiter.check(
      { policyName: "fallback-closed", identity: { type: "ip", value: "9.9.9.9" } },
      { limit: 1, windowSeconds: 1, strategy: "fixed-window" }
    );
    expect(result.allowed).toBe(false);
    badClient.disconnect();
  });
});
