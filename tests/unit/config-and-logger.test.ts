import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, __resetConfigCacheForTests } from "@sentinel/config";
import { createLogger } from "@sentinel/logger";

describe("config loader", () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  it("loads with documented defaults when env vars are absent", () => {
    const originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GATEWAY_") || key.startsWith("REDIS_") || key.startsWith("DATABASE_")) {
        delete process.env[key];
      }
    }
    const config = loadConfig();
    expect(config.GATEWAY_PORT).toBe(3000);
    expect(config.REDIS_FALLBACK_MODE).toBe("fail-open");
    process.env = originalEnv;
  });

  it("rejects an invalid REDIS_FALLBACK_MODE value", () => {
    const original = process.env.REDIS_FALLBACK_MODE;
    process.env.REDIS_FALLBACK_MODE = "not-a-real-mode";
    expect(() => loadConfig()).toThrow(/Invalid environment configuration/);
    process.env.REDIS_FALLBACK_MODE = original;
  });

  it("caches the config after first load", () => {
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });
});

describe("logger", () => {
  it("constructs without throwing and logs secret-shaped fields without crashing", () => {
    const logger = createLogger({ name: "test", level: "silent" });
    expect(logger).toBeDefined();
    expect(() => logger.info({ password: "supersecret", apiKey: "sk_live_abc" }, "test log")).not.toThrow();
  });
});
