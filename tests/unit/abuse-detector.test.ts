import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createRedisClient, type RedisClient } from "@sentinel/redis";
import { createAbuseDetector, type AbuseDetector } from "@sentinel/abuse-detector";
import { createLogger } from "@sentinel/logger";
import { detectBurst, detectAuthFailures, detectEndpointScanning, detectHighErrorRate } from "@sentinel/abuse-detector";
import { DEFAULT_ABUSE_CONFIG } from "@sentinel/abuse-detector";
import { scoreToBand, bandToDecision, clampScore } from "@sentinel/shared";

const logger = createLogger({ name: "test", level: "silent" });

describe("pure risk-scoring rules", () => {
  it("scoreToBand maps scores to the documented bands", () => {
    expect(scoreToBand(0)).toBe("normal");
    expect(scoreToBand(29)).toBe("normal");
    expect(scoreToBand(30)).toBe("suspicious");
    expect(scoreToBand(59)).toBe("suspicious");
    expect(scoreToBand(60)).toBe("high-risk");
    expect(scoreToBand(79)).toBe("high-risk");
    expect(scoreToBand(80)).toBe("critical");
    expect(scoreToBand(100)).toBe("critical");
  });

  it("bandToDecision maps bands to the documented actions", () => {
    expect(bandToDecision("normal")).toBe("ALLOW");
    expect(bandToDecision("suspicious")).toBe("ALLOW_MONITOR");
    expect(bandToDecision("high-risk")).toBe("THROTTLE");
    expect(bandToDecision("critical")).toBe("BLOCK");
  });

  it("clampScore keeps scores within 0-100", () => {
    expect(clampScore(-10)).toBe(0);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(50)).toBe(50);
  });
});

describe("individual detection rules (pure functions)", () => {
  const now = Date.now();

  it("detectBurst fires when enough requests fall within the burst window", () => {
    const history = Array.from({ length: 25 }, (_, i) => ({ path: "/x", method: "GET", status: 200, ts: now - i * 10 }));
    const result = detectBurst(history, now, DEFAULT_ABUSE_CONFIG);
    expect(result).not.toBeNull();
    expect(result?.rule).toBe("burst-detection");
  });

  it("detectBurst does not fire for normal-paced traffic", () => {
    const history = [{ path: "/x", method: "GET", status: 200, ts: now - 5000 }];
    expect(detectBurst(history, now, DEFAULT_ABUSE_CONFIG)).toBeNull();
  });

  it("detectAuthFailures fires after threshold 401s", () => {
    const history = Array.from({ length: 6 }, () => ({ path: "/login", method: "POST", status: 401, ts: now }));
    const result = detectAuthFailures(history, DEFAULT_ABUSE_CONFIG);
    expect(result).not.toBeNull();
  });

  it("detectEndpointScanning fires when many distinct paths are hit", () => {
    const history = Array.from({ length: 9 }, (_, i) => ({ path: `/api/${i}`, method: "GET", status: 200, ts: now }));
    const result = detectEndpointScanning(history, DEFAULT_ABUSE_CONFIG);
    expect(result).not.toBeNull();
  });

  it("detectEndpointScanning does not fire when the same endpoint is hit repeatedly", () => {
    const history = Array.from({ length: 20 }, () => ({ path: "/products", method: "GET", status: 200, ts: now }));
    expect(detectEndpointScanning(history, DEFAULT_ABUSE_CONFIG)).toBeNull();
  });

  it("detectHighErrorRate requires a minimum sample size", () => {
    const smallHistory = [{ path: "/x", method: "GET", status: 500, ts: now }];
    expect(detectHighErrorRate(smallHistory, DEFAULT_ABUSE_CONFIG)).toBeNull();
  });

  it("detectHighErrorRate fires once the error ratio crosses the threshold with enough samples", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      path: "/x",
      method: "GET",
      status: i < 8 ? 500 : 200,
      ts: now,
    }));
    const result = detectHighErrorRate(history, DEFAULT_ABUSE_CONFIG);
    expect(result).not.toBeNull();
  });
});

describe("abuse detector integration (real Redis)", () => {
  let client: RedisClient;
  let detector: AbuseDetector;

  beforeAll(async () => {
    client = createRedisClient({ url: process.env.TEST_REDIS_URL ?? "redis://localhost:6379", logger });
    await new Promise<void>((resolve, reject) => {
      client.once("ready", () => resolve());
      client.once("error", reject);
    });
    detector = createAbuseDetector({
      client,
      logger,
      config: { burstThresholdRequests: 5, burstWindowMs: 2000, authFailureThreshold: 3 },
    });
  });

  beforeEach(async () => {
    await client.flushall();
  });

  afterAll(async () => {
    await client.quit();
  });

  it("returns ALLOW with score 0 for a single normal request", async () => {
    const result = await detector.recordAndAssess({
      identity: { type: "ip", value: "10.1.1.1" },
      path: "/products",
      method: "GET",
      status: 200,
    });
    expect(result.decision).toBe("ALLOW");
    expect(result.score).toBe(0);
  });

  it("accumulates risk score across repeated auth failures and reaches ALLOW_MONITOR or higher", async () => {
    const identity = { type: "ip" as const, value: "10.1.1.2" };
    let last;
    for (let i = 0; i < 4; i++) {
      last = await detector.recordAndAssess({ identity, path: "/login", method: "POST", status: 401 });
    }
    expect(last?.score).toBeGreaterThanOrEqual(15);
    expect(["ALLOW_MONITOR", "THROTTLE", "BLOCK"]).toContain(last?.decision);
  });

  it("getCurrentAssessment reflects the same score without adding new points", async () => {
    const identity = { type: "ip" as const, value: "10.1.1.3" };
    for (let i = 0; i < 4; i++) {
      await detector.recordAndAssess({ identity, path: "/login", method: "POST", status: 401 });
    }
    const a = await detector.getCurrentAssessment(identity);
    const b = await detector.getCurrentAssessment(identity);
    expect(a.score).toBe(b.score);
  });
});
